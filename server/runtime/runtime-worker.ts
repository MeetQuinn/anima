import type { AgentRuntime } from './provider-contract.js';
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
  recordRuntimeFollowupAppended,
  recordRuntimeFollowupFailed,
  recordRuntimePending,
} from './activity.js';
import { recordFinalRuntimeFailure, runProviderWithCrashRetries } from './provider-runner.js';

// Executor for one agent: claims queued inbox items, runs the provider runtime,
// appends follow-up items into the active run, and settles item lifecycle state.
const IDLE_TIMEOUT_MS_DEFAULT = PROVIDER_IDLE_TIMEOUT_MS_DEFAULT;
const IDLE_CHECK_INTERVAL_FLOOR_MS = 50;
const IDLE_CHECK_INTERVAL_CAP_MS = 1_000;
const FOLLOWUP_POLL_MS = 100;

type RuntimeFollowupDecision =
  | { status: 'appended'; text?: string }
  | { status: 'rejected' }
  | { error: string; status: 'failed' };

interface ActiveItemHandle {
  abortController: AbortController;
  // Follow-up inbox items are completed as soon as they are appended, but their
  // processing reactions should stay visible until the active provider run ends.
  appendedFollowups: RuntimeItemContext[];
  drainRequestedAt?: string;
  drainRequestInFlight: boolean;
  lastActivityAt: number;
  startedAt: number;
  watchdog: NodeJS.Timeout;
}

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
  private activeItem?: ActiveItemHandle;
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
      followupLoop = this.appendQueuedFollowupsUntilFinished(context, itemAbort.signal, handle).catch((error: unknown) => {
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
          onActivity: () => this.noteProviderActivity(handle),
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

  private registerActiveItem(itemId: string, abortController: AbortController): ActiveItemHandle {
    const startedAt = Date.now();
    const tickInterval = Math.max(
      IDLE_CHECK_INTERVAL_FLOOR_MS,
      Math.min(IDLE_CHECK_INTERVAL_CAP_MS, Math.floor(this.idleTimeoutMs / 2)),
    );
    const handle: ActiveItemHandle = {
      abortController,
      appendedFollowups: [],
      drainRequestInFlight: false,
      lastActivityAt: startedAt,
      startedAt,
      watchdog: setInterval(() => {
        if (abortController.signal.aborted) return;
        const now = Date.now();
        if (now - handle.lastActivityAt >= this.idleTimeoutMs) {
          abortController.abort('idle_timeout');
          return;
        }
        void this.checkExternalRequests(itemId, abortController, handle);
      }, tickInterval),
    };
    this.activeItem = handle;
    return handle;
  }

  private noteProviderActivity(handle: ActiveItemHandle): void {
    handle.lastActivityAt = Date.now();
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

  private async checkExternalRequests(
    itemId: string,
    abortController: AbortController,
    handle: ActiveItemHandle,
  ): Promise<void> {
    try {
      const item = await this.queue.find(itemId);
      if (item?.handling.stopRequestedAt && !abortController.signal.aborted) {
        abortController.abort('user_stop');
        return;
      }
      const drainRequestedAt = item?.handling.drainRequestedAt;
      if (
        drainRequestedAt &&
        !handle.drainRequestInFlight &&
        handle.drainRequestedAt !== drainRequestedAt &&
        !abortController.signal.aborted
      ) {
        handle.drainRequestInFlight = true;
        handle.drainRequestedAt = drainRequestedAt;
        void this.drainActiveItem(itemId, item.handling.drainTimeoutMs, abortController, handle);
      }
    } catch (error) {
      this.logger.error(`Runtime worker control check failed for item ${itemId}: ${errorMessage(error)}`);
    }
  }

  private async drainActiveItem(
    itemId: string,
    timeoutMs: number | undefined,
    abortController: AbortController,
    handle: ActiveItemHandle,
  ): Promise<void> {
    try {
      if (!this.options.agentRuntime.requestDrain) return;
      await withTimeout(
        this.options.agentRuntime.requestDrain({ activeItemId: itemId, signal: abortController.signal }),
        timeoutMs ?? 15_000,
        `Timed out waiting for item ${itemId} to reach a restart drain point`,
      );
      const current = await this.queue.find(itemId);
      if (current?.handling.drainRequestedAt !== handle.drainRequestedAt) return;
      if (!abortController.signal.aborted) abortController.abort('restart_drain');
    } catch (error) {
      this.logger.error(`Runtime worker drain request failed for item ${itemId}: ${errorMessage(error)}`);
    } finally {
      handle.drainRequestInFlight = false;
    }
  }

  private releaseActiveItem(): void {
    const handle = this.activeItem;
    if (!handle) return;
    clearInterval(handle.watchdog);
    this.activeItem = undefined;
  }

  private async appendQueuedFollowupsUntilFinished(activeContext: RuntimeItemContext, itemDone: AbortSignal, handle: ActiveItemHandle): Promise<void> {
    const skippedItemIds = new Set<string>();
    while (!itemDone.aborted) {
      if (await isRestartDrainActive()) {
        await sleep(FOLLOWUP_POLL_MS, itemDone);
        continue;
      }
      const item = await this.queue.claimNextFollowup({
        activeItemId: activeContext.item.id,
        excludedItemIds: skippedItemIds,
        workerId: this.workerId,
      });
      if (!item) {
        await sleep(FOLLOWUP_POLL_MS, itemDone);
        continue;
      }
      await this.tryOneFollowupItem(activeContext, item, handle, itemDone, skippedItemIds);
    }
  }

  private async tryOneFollowupItem(
    activeContext: RuntimeItemContext,
    item: InboxItem,
    handle: ActiveItemHandle,
    itemDone: AbortSignal,
    skippedItemIds: Set<string>,
  ): Promise<void> {
    let appended = false;
    let context: RuntimeItemContext | undefined;
    try {
      context = await runtimeContextForItemId(item.id, this.options);
      const followup = await appendRuntimeFollowup({
        activeContext,
        agentRuntime: this.options.agentRuntime,
        context,
        runtimeBridge: this.runtimeBridge,
      });
      if (followup.status === 'appended') {
        await this.recordFollowupAppendSuccess(activeContext, context, followup.text, handle);
        appended = true;
        return;
      }
      await this.recordFollowupAppendSkip(activeContext, item, followup);
      skippedItemIds.add(item.id);
      await this.queue.requeue(item.id);
      await sleep(FOLLOWUP_POLL_MS, itemDone);
    } catch (error) {
      skippedItemIds.add(item.id);
      await this.queue.requeue(item.id);
      await recordRuntimeFollowupFailed(
        { agentId: this.options.agentId },
        {
          activeItemId: activeContext.item.id,
          agentRuntime: this.options.agentRuntime.kind,
          error: errorMessage(error),
          reason: 'followup_failed',
        },
      );
      this.logger.error(`Runtime worker follow-up append failed for item ${item.id}: ${errorMessage(error)}`);
      await sleep(FOLLOWUP_POLL_MS, itemDone);
    } finally {
      const current = context && !appended ? await this.queue.find(context.item.id).catch(() => undefined) : undefined;
      if (context && (current?.handling.status === 'completed' || current?.handling.status === 'failed')) {
        await this.notifySettledItems([context]);
      }
    }
  }

  private async recordFollowupAppendSuccess(
    activeContext: RuntimeItemContext,
    context: RuntimeItemContext,
    text: string | undefined,
    handle: ActiveItemHandle,
  ): Promise<void> {
    this.noteProviderActivity(handle);
    await this.queue.complete(context.item.id);
    handle.appendedFollowups.push(context);
    await this.notifyItemFollowupAppended(activeContext, context);
    this.logger.log(JSON.stringify({
      activeItemId: activeContext.item.id,
      agentRuntime: this.options.agentRuntime.kind,
      event: 'runtime.followup_appended',
      itemId: context.item.id,
      text,
      workerId: this.workerId,
    }, null, 2));
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

  private async recordFollowupAppendSkip(
    activeContext: RuntimeItemContext,
    item: InboxItem,
    followup: RuntimeFollowupDecision,
  ): Promise<void> {
    if (followup.status === 'rejected') {
      await recordRuntimePending(
        { agentId: this.options.agentId },
        {
          activeItemId: activeContext.item.id,
          agentRuntime: this.options.agentRuntime.kind,
          reason: 'followup_rejected',
        },
      );
    }
    if (followup.status === 'failed') {
      this.logger.error(`Runtime worker follow-up append failed for item ${item.id}: ${followup.error}`);
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

async function appendRuntimeFollowup(input: {
  activeContext: RuntimeItemContext;
  agentRuntime: AgentRuntime;
  context: RuntimeItemContext;
  runtimeBridge: AgentRuntimeBridge;
}): Promise<RuntimeFollowupDecision> {
  try {
    const result = await input.agentRuntime.appendToActiveRun(await input.runtimeBridge.followupInput({
      activeContext: input.activeContext,
      context: input.context,
    }));
    if (!result.accepted) return { status: 'rejected' };
    await recordRuntimeFollowupAppended(
      { agentId: input.context.agentId },
      {
        activeItemId: input.activeContext.item.id,
        agentRuntime: input.agentRuntime.kind,
        text: result.text,
      },
    );
    return { status: 'appended', text: result.text };
  } catch (error) {
    const message = errorMessage(error);
    await recordRuntimeFollowupFailed(
      { agentId: input.context.agentId },
      {
        activeItemId: input.activeContext.item.id,
        agentRuntime: input.agentRuntime.kind,
        error: message,
        reason: 'followup_failed',
      },
    );
    return { error: message, status: 'failed' };
  }
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
