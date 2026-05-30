import type { AgentRuntime } from '../providers/contract.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { errorMessage } from '../ids.js';
import { PROVIDER_IDLE_TIMEOUT_MS_DEFAULT } from '../../shared/agent-config.js';
import type { WakeQueueService } from '../inbox/wake-queue.service.js';
import { isRestartDrainActive } from '../services/restart-drain.js';
import type {
  ItemStopReason,
  RuntimeWorkerConfig,
  RuntimeItemContext,
} from './types.js';
import type { InboxItem } from '../../shared/inbox.js';
import { AgentRuntimeBridge } from './runtime-bridge.js';
import { runtimeContextForItemId } from './context.js';
import { clearActiveRuntimeItem, setActiveRuntimeItem } from './active-item.js';
import {
  recordRuntimeAborted,
  recordRuntimeEvent,
} from './activity.js';
import { startActiveRunControl, type ActiveRunHandle } from './active-run-control.js';
import { appendQueuedFollowupsUntilFinished } from './followup-appender.js';
import { recordFinalRuntimeFailure, runProviderWithCrashRetries } from './provider-runner.js';

// Executor for one agent: claims queued inbox items, runs the provider runtime,
// appends follow-up items into the active run, and settles item lifecycle state.
const IDLE_TIMEOUT_MS_DEFAULT = PROVIDER_IDLE_TIMEOUT_MS_DEFAULT;

interface AgentRuntimeWorkerOptions extends RuntimeWorkerConfig {
  agentRuntime: AgentRuntime;
  idleTimeoutMs?: number;
  onItemStarted?: (context: RuntimeItemContext) => Promise<void>;
  onItemFollowupAppended?: (activeContext: RuntimeItemContext, context: RuntimeItemContext) => Promise<void>;
  onItemSettled?: (context: RuntimeItemContext) => Promise<void>;
  pollIntervalMs?: number;
  queue: WakeQueueService;
  workerIsAlive?: (workerId: string) => boolean;
  workerId?: string;
}

export class AgentRuntimeWorker {
  private readonly workerIsAlive: (workerId: string) => boolean;
  private readonly workerId: string;
  private readonly idleTimeoutMs: number;
  private readonly queue: WakeQueueService;
  private readonly runtimeBridge: AgentRuntimeBridge;
  private activeItem?: ActiveRunHandle;
  private activeDrain?: Promise<number>;
  private closing = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly options: AgentRuntimeWorkerOptions,
    private readonly logger: Pick<Console, 'error' | 'log'> = console,
  ) {
    this.workerIsAlive = options.workerIsAlive ?? isWorkerAlive;
    this.workerId = options.workerId ?? `${options.agentId}:${process.pid}`;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS_DEFAULT;
    this.queue = options.queue;
    this.runtimeBridge = new AgentRuntimeBridge(options.agentRuntime);
  }

  async drainOnce(): Promise<number> {
    if (this.activeDrain) return 0;
    const drain = this.drainLoop();
    this.activeDrain = drain;
    try {
      return await drain;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = undefined;
    }
  }

  private async drainLoop(): Promise<number> {
    let processed = 0;
    await this.recoverInterruptedItems();
    while (!this.closing && await this.runOne()) processed += 1;
    return processed;
  }

  start(): NodeJS.Timeout {
    const intervalMs = this.options.pollIntervalMs ?? 1_000;
    this.pollTimer = setInterval(() => this.tick(), intervalMs);
    this.tick();
    return this.pollTimer;
  }

  isActive(): boolean {
    return Boolean(this.activeItem);
  }

  private tick(): void {
    if (this.closing) return;
    void this.drainOnce()
      .catch((error: unknown) => {
        this.logger.error(`Runtime worker drain failed for ${this.options.agentId}: ${errorMessage(error)}`);
      });
  }

  async close(options: { drainActive?: boolean } = {}): Promise<void> {
    this.closing = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (!options.drainActive) {
      this.activeItem?.abortController.abort('shutdown');
      await this.options.agentRuntime.close?.();
    }
    while (this.activeDrain) {
      await this.activeDrain.catch((error: unknown) => {
        this.logger.error(`Runtime worker drain failed for ${this.options.agentId}: ${errorMessage(error)}`);
      });
    }
    if (options.drainActive) await this.options.agentRuntime.close?.();
  }

  private async recoverInterruptedItems(): Promise<void> {
    const recovered = await this.queue.recoverInterrupted({ isWorkerAlive: this.workerIsAlive });
    if (recovered.length === 0) return;
    this.logger.log(JSON.stringify({
      agentId: this.options.agentId,
      event: 'runtime.recovered',
      recoveredItemIds: recovered.map((item) => item.id),
      workerId: this.workerId,
    }, null, 2));
  }

  private async runOne(): Promise<boolean> {
    if (await isRestartDrainActive()) return false;
    const item = await this.queue.claimNext(this.workerId);
    if (!item) return false;
    await this.processClaimedItem(item);
    return true;
  }

  private async processClaimedItem(item: InboxItem): Promise<void> {
    let context: RuntimeItemContext | undefined;
    let runtimeFailureRecorded = false;
    const itemAbort = new AbortController();
    const handle = this.registerActiveItem(item.id, itemAbort);
    let followupLoop: Promise<void> | undefined;
    let followupError: unknown;
    try {
      context = await runtimeContextForItemId(item.id, this.options);
      const activeContext = context;
      followupLoop = appendQueuedFollowupsUntilFinished({
        activeContext,
        agentRuntime: this.options.agentRuntime,
        itemDone: itemAbort.signal,
        logger: this.logger,
        onFollowupAccepted: () => handle.noteActivity(),
        onFollowupAppended: async (followupContext, _text) => {
          handle.appendedFollowups.push(followupContext);
          await this.notifyItemFollowupAppended(activeContext, followupContext);
        },
        onFollowupSettled: (followupContext) => this.notifySettledItems([followupContext]),
        queue: this.queue,
        runtimeBridge: this.runtimeBridge,
        runtimeConfig: this.options,
        workerId: this.workerId,
      }).catch((error: unknown) => {
        followupError = error;
      });
      const agentConfig = await defaultAgentRegistryService.serviceFor(this.options.agentId).getConfig();
      await setActiveRuntimeItem({
        agentId: this.options.agentId,
        startedAt: isoFromMs(handle.startedAt),
        itemId: context.item.id,
        workerId: this.workerId,
      });
      await this.notifyItemStarted(context);
      if (context.item.handling.resumeReason === 'runtime_restart') {
        await this.recordRestartResumeActivity(context);
      }
      const runContext = context;
      const result = await runProviderWithCrashRetries({
        agentId: this.options.agentId,
        agentRuntime: this.options.agentRuntime,
        buildInput: (retryNotice) => this.runtimeBridge.runInput({
          context: runContext,
          onActivity: () => handle.noteActivity(),
          profile: {
            displayName: agentConfig.profile?.displayName ?? this.options.agentId,
            ...(agentConfig.profile?.role ? { role: agentConfig.profile.role } : {}),
          },
          retryNotice,
          session: runContext.session,
          signal: itemAbort.signal,
          suppressFailureRecord: true,
        }),
        onFinalFailureRecorded: () => {
          runtimeFailureRecorded = true;
        },
        signal: itemAbort.signal,
      });
      itemAbort.abort('completed');
      await followupLoop;
      if (followupError) throw followupError;
      this.logger.log(JSON.stringify({
        agentRuntime: this.options.agentRuntime.kind,
        event: 'runtime.completed',
        itemId: context.item.id,
        text: result.text,
        workerId: this.workerId,
      }, null, 2));
      await this.queue.complete(item.id);
    } catch (error) {
      if (!itemAbort.signal.aborted) itemAbort.abort('failed');
      await followupLoop;
      if (followupError) {
        this.logger.error(`Runtime worker follow-up loop failed for item ${item.id}: ${errorMessage(followupError)}`);
      }
      const abortReason = itemAbort.signal.aborted ? abortReasonOf(itemAbort.signal) : undefined;
      let itemSettled = false;
      if (abortReason && context) {
        await this.settleAbortedItem(context, abortReason);
        itemSettled = true;
      } else if (context && !runtimeFailureRecorded) {
        await recordFinalRuntimeFailure({
          agentId: this.options.agentId,
          agentRuntime: this.options.agentRuntime,
          error,
          retryAttempts: 0,
        });
      }
      if (!itemSettled) await this.queue.fail(item.id);
      if (abortReason === 'restart_drain') {
        this.logger.log(JSON.stringify({
          agentRuntime: this.options.agentRuntime.kind,
          event: 'runtime.drained_for_restart',
          itemId: item.id,
          workerId: this.workerId,
        }, null, 2));
      } else {
        this.logger.error(`Runtime worker failed for item ${item.id}: ${errorMessage(error)}`);
      }
    } finally {
      if (context) {
        await clearActiveRuntimeItem({
          agentId: this.options.agentId,
          itemId: context.item.id,
          workerId: this.workerId,
        });
      }
      this.releaseActiveItem();
      if (context) await this.notifySettledItems([context, ...handle.appendedFollowups]);
    }
  }

  private registerActiveItem(itemId: string, abortController: AbortController): ActiveRunHandle {
    const handle = startActiveRunControl({
      abortController,
      agentRuntime: this.options.agentRuntime,
      idleTimeoutMs: this.idleTimeoutMs,
      itemId,
      logger: this.logger,
      queue: this.queue,
    });
    this.activeItem = handle;
    return handle;
  }

  private async recordRestartResumeActivity(context: RuntimeItemContext): Promise<void> {
    await recordRuntimeEvent(
      { agentId: this.options.agentId },
      this.options.agentRuntime.kind,
      this.options.agentRuntime.env,
      {
        eventType: 'runtime.restart_resumed',
        itemId: context.item.id,
        message: 'Resumed after restart',
      },
    );
  }

  private releaseActiveItem(): void {
    const handle = this.activeItem;
    if (!handle) return;
    handle.release();
    this.activeItem = undefined;
  }

  private async notifyItemStarted(context: RuntimeItemContext): Promise<void> {
    try {
      await this.options.onItemStarted?.(context);
    } catch (error) {
      this.logger.error(
        `Runtime worker item-started hook failed for item ${context.item.id}: ${errorMessage(error)}`,
      );
    }
  }

  private async notifyItemFollowupAppended(activeContext: RuntimeItemContext, context: RuntimeItemContext): Promise<void> {
    try {
      await this.options.onItemFollowupAppended?.(activeContext, context);
    } catch (error) {
      this.logger.error(
        `Runtime worker follow-up appended hook failed for item ${context.item.id}: ${errorMessage(error)}`,
      );
    }
  }

  private async notifySettledItems(contexts: RuntimeItemContext[]): Promise<void> {
    for (const context of contexts) {
      try {
        await this.options.onItemSettled?.(context);
      } catch (error) {
        this.logger.error(
          `Runtime worker item-settled hook failed for item ${context.item.id}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private async settleAbortedItem(context: RuntimeItemContext, abortReason: ItemStopReason): Promise<void> {
    await recordRuntimeAborted(
      { agentId: this.options.agentId },
      abortReason,
      abortReason === 'idle_timeout' ? { timeoutMs: this.idleTimeoutMs } : undefined,
    );
    if (abortReason === 'restart_drain') {
      await this.queue.requeue(context.item.id, { resumeReason: 'runtime_restart' });
      return;
    }
    await this.queue.fail(context.item.id);
  }
}

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function abortReasonOf(signal: AbortSignal): ItemStopReason | undefined {
  const reason = signal.reason;
  return reason === 'idle_timeout' || reason === 'restart_drain' || reason === 'shutdown' || reason === 'user_stop'
    ? reason
    : undefined;
}

function isWorkerAlive(workerId: string): boolean {
  const pidText = workerId.split(':').at(-1);
  const pid = pidText ? Number.parseInt(pidText, 10) : Number.NaN;
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
