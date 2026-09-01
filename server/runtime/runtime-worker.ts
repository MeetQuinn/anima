import { randomUUID } from 'node:crypto';

import type { AgentRuntime } from '../providers/contract.js';
import type { ProviderSessionCorruptionError } from '../providers/session-corruption.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { errorMessage, nowIso } from '../ids.js';
import { PROVIDER_IDLE_TIMEOUT_MS_DEFAULT } from '../../shared/agent-config.js';
import type { WakeQueueService } from '../inbox/wake-queue.service.js';
import { onWake } from '../inbox/wake-signal.js';
import {
  memoryCoherenceDigest,
  recordMemoryCoherenceCompleted,
  recordMemoryCoherenceFailed,
} from '../memory/memory-coherence-outcome.js';
import { readRestartDrainActive } from './intake-gate.js';
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
  recordSessionRotationActivity,
} from './activity.js';
import { startActiveRunControl, type ActiveRunHandle } from './active-run-control.js';
import { appendQueuedFollowupsUntilFinished } from './followup-appender.js';
import {
  isProviderRateLimitedError,
  recordFinalRuntimeFailure,
  runProviderWithCrashRetries,
  type ProviderRetryOptions,
} from './provider-runner.js';
import { classifyProviderRetry } from '../providers/provider-retry.js';
import type { RuntimeItemFailure } from './failure-notice.js';
import { defaultAgentHealthService, isProviderFailureReason } from './agent-health.service.js';
import { runtimeSessionServiceForAgent } from './runtime-session.service.js';
import type { AgentRuntimeHandleSnapshot } from '../../shared/snapshot.js';
import { TeamRunLimiter } from './team-run-limiter.js';
import {
  coalesceCoveredWakes,
  commitCursorDelivery,
  prepareCursorDelivery,
  surfacesForSlackWake,
} from './cursor-delivery.js';
import { backfillActiveSlackWakeJournal } from './cursor-wake-journal-backfill.js';
import { observedConversationStoreForAgent } from '../storage/schema/observed-conversation.store.js';

// Executor for one agent: claims queued inbox items, runs the provider runtime,
// appends follow-up items into the active run, and settles item lifecycle state.
const IDLE_TIMEOUT_MS_DEFAULT = PROVIDER_IDLE_TIMEOUT_MS_DEFAULT;
const STALE_RUNNING_RECOVERY_MS = 30 * 60 * 1000;
/**
 * How many times one item may be deferred for provider rate limits before it
 * is failed and the requester told. Each deferral waits until the provider's
 * reported reset (bounded in provider-retry.ts), so this is hours, not minutes.
 */
export const MAX_RATE_LIMIT_DEFERRALS = 6;

interface AgentRuntimeWorkerOptions extends RuntimeWorkerConfig {
  agentRuntime: AgentRuntime;
  idleTimeoutMs?: number;
  /** Test seam: inject a deferred restart-drain probe. */
  isRestartDrainActive?: () => Promise<boolean>;
  onItemStarted?: (context: RuntimeItemContext) => Promise<void>;
  /** Terminal failure (retries exhausted or non-retryable): tell the requester. */
  onItemFailed?: (context: RuntimeItemContext, failure: RuntimeItemFailure) => Promise<void>;
  onItemFollowupAppended?: (activeContext: RuntimeItemContext, context: RuntimeItemContext) => Promise<void>;
  onItemSettled?: (context: RuntimeItemContext) => Promise<void>;
  pollIntervalMs?: number;
  providerRetry?: ProviderRetryOptions;
  queue: WakeQueueService;
  workerIsAlive?: (workerId: string) => boolean;
  workerId?: string;
}

export interface AgentRuntimeWorkerCloseOptions {
  abortReason?: ItemStopReason;
  drainActive?: boolean;
  forceAfterMs?: number;
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
  private intakePaused = false;
  private pendingWake = false;
  private pollTimer?: NodeJS.Timeout;
  private unsubscribeWake?: () => void;
  /**
   * In-flight pre-drain journal backfill only. Not a lifetime success cache:
   * every drain re-runs (deduped observes are cheap) so transient top-level
   * queue/store failures are retried, and pre-journal active wakes are covered
   * without treating once-only startup as the sole correctness boundary.
   * Concurrent callers share one in-flight promise.
   */
  private journalBackfillInFlight?: Promise<void>;

  constructor(
    private readonly options: AgentRuntimeWorkerOptions,
    private readonly logger: Pick<Console, 'error' | 'log'> = console,
    private readonly runLimiter = new TeamRunLimiter(),
  ) {
    this.workerIsAlive = options.workerIsAlive ?? isWorkerAlive;
    this.workerId = options.workerId ?? `${options.agentId}:${randomUUID()}:${process.pid}`;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS_DEFAULT;
    this.queue = options.queue;
    this.runtimeBridge = new AgentRuntimeBridge(options.agentRuntime);
  }

  async drainOnce(): Promise<number> {
    if (this.activeDrain) {
      this.pendingWake = true;
      return 0;
    }
    const drain = this.drainLoop();
    this.activeDrain = drain;
    try {
      return await drain;
    } finally {
      if (this.activeDrain === drain) {
        this.activeDrain = undefined;
        if (this.pendingWake && !this.closing) {
          this.pendingWake = false;
          this.tick();
        }
      }
    }
  }

  private async drainLoop(): Promise<number> {
    // Before any claim: backfill active Slack wakes missing from the journal
    // (upgrade/pre-journal recovery). Producers must also journal; this is not
    // the sole boundary for post-start wakes.
    await this.ensureJournalBackfill();
    let processed = 0;
    while (!this.closing && await this.runOne()) processed += 1;
    return processed;
  }

  /**
   * Pre-drain migration. Coalesces concurrent callers; always clears after
   * settle so the next drain retries after a transient top-level failure
   * (and re-scans active wakes that arrived mid-flight).
   */
  private ensureJournalBackfill(): Promise<void> {
    if (this.journalBackfillInFlight) return this.journalBackfillInFlight;
    this.journalBackfillInFlight = backfillActiveSlackWakeJournal({
      agentId: this.options.agentId,
      queue: this.queue,
      logger: this.logger,
    }).then(() => undefined).catch((error: unknown) => {
      // Fail-soft on the migration itself: prepare remains fail-closed for
      // any still-missing trigger. Do not block the worker forever.
      this.logger.error(
        `cursor-wake journal backfill failed for ${this.options.agentId}: ${errorMessage(error)}`,
      );
    }).finally(() => {
      if (this.journalBackfillInFlight) {
        // Clear only if we are still the in-flight owner (always true here).
        this.journalBackfillInFlight = undefined;
      }
    });
    return this.journalBackfillInFlight;
  }

  start(): NodeJS.Timeout {
    const intervalMs = this.options.pollIntervalMs ?? 15_000;
    this.unsubscribeWake = onWake(this.options.agentId, () => this.tick());
    // Fallback covers stale-running crash recovery and cross-process onboarding enqueues.
    this.pollTimer = setInterval(() => this.tick(), intervalMs);
    // Kick backfill then drain; do not claim until ensureJournalBackfill resolves.
    void this.ensureJournalBackfill().then(() => {
      if (!this.closing) this.tick();
    });
    return this.pollTimer;
  }

  isActive(): boolean {
    return Boolean(this.activeItem);
  }

  isProviderQuiescent(): boolean | undefined {
    return this.options.agentRuntime.isProviderQuiescent?.();
  }

  setIntakePaused(paused: boolean): void {
    this.intakePaused = paused;
  }

  waitForProviderQuiescent(signal?: AbortSignal): Promise<void> {
    return this.options.agentRuntime.waitForProviderQuiescent?.(signal) ?? Promise.resolve();
  }

  health(): AgentRuntimeHandleSnapshot {
    const active = this.activeItem;
    const provider = this.options.agentRuntime.health?.();
    return {
      ...(active ? {
        activeItemId: active.itemId,
        activeItemStartedAt: isoFromMs(active.startedAt),
      } : {}),
      processId: process.pid,
      ...(provider?.child ? { providerChild: provider.child } : {}),
      providerChildExpected: provider?.childExpected ?? false,
      ...(provider?.providerWork ? { providerWork: provider.providerWork } : {}),
      workerId: this.workerId,
    };
  }

  private tick(): void {
    if (this.closing) return;
    void this.drainOnce()
      .catch((error: unknown) => {
        this.logger.error(`Runtime worker drain failed for ${this.options.agentId}: ${errorMessage(error)}`);
      });
  }

  async close(options: AgentRuntimeWorkerCloseOptions = {}): Promise<void> {
    this.closing = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.unsubscribeWake?.();
    this.unsubscribeWake = undefined;
    if (!options.drainActive) {
      this.activeItem?.abortController.abort(options.abortReason ?? 'shutdown');
      await this.options.agentRuntime.close?.(
        options.forceAfterMs === undefined ? undefined : { forceAfterMs: options.forceAfterMs },
      );
    }
    while (this.activeDrain) {
      await this.activeDrain.catch((error: unknown) => {
        this.logger.error(`Runtime worker drain failed for ${this.options.agentId}: ${errorMessage(error)}`);
      });
    }
    if (options.drainActive) {
      await this.options.agentRuntime.close?.(
        options.forceAfterMs === undefined ? undefined : { forceAfterMs: options.forceAfterMs },
      );
    }
  }

  private async runOne(): Promise<boolean> {
    // Await drain only, then sync pause/closing in this same continuation.
    {
      const drainActive = await this.readDrainActive();
      if (this.closing || this.intakePaused || drainActive) return false;
    }
    const releaseRunSlot = await this.runLimiter.acquire();
    try {
      {
        const drainActive = await this.readDrainActive();
        if (this.closing || this.intakePaused || drainActive) return false;
      }
      const item = await this.takeNextRunnable();
      if (!item) return false;
      // Fail-closed after claim: drain probe, sync pause/closing, then either
      // requeue or invoke processClaimedItem with no await between the pause
      // read and starting processClaimedItem.
      const drainActive = await this.readDrainActive();
      if (this.closing || this.intakePaused || drainActive) {
        await this.queue.requeue(item.id);
        return false;
      }
      const outcome = await this.processClaimedItem(item);
      // 'deferred' stops this drain cycle (item requeued without tombstone).
      return outcome !== 'deferred';
    } finally {
      releaseRunSlot();
    }
  }

  private readDrainActive(): Promise<boolean> {
    return readRestartDrainActive(this.options.isRestartDrainActive);
  }

  private async takeNextRunnable(): Promise<InboxItem | undefined> {
    const result = await this.queue.takeNextRunnable({
      currentWorkerId: this.workerId,
      isWorkerAlive: this.workerIsAlive,
      staleRunningMs: STALE_RUNNING_RECOVERY_MS,
      workerId: this.workerId,
    });
    return result;
  }

  /**
   * @returns `'ran'` when a provider turn ran; `'settled'` when the item was
   * completed without a turn; `'deferred'` when the item was requeued without
   * tombstone (e.g. cursor-delivery prepare fail-closed) — stop this drain
   * cycle to avoid a hot reclaim loop.
   */
  private async processClaimedItem(item: InboxItem): Promise<'ran' | 'settled' | 'deferred'> {
    let context: RuntimeItemContext | undefined;
    let memoryCoherenceBeforeDigest: string | undefined;
    let runtimeFailureRecorded = false;
    let recordedFailure: RuntimeItemFailure | undefined;
    const itemAbort = new AbortController();
    const handle = this.registerActiveItem(item.id, itemAbort);
    let followupLoop: Promise<void> | undefined;
    let followupError: unknown;
    let appendedFollowupsSettled = false;
    // Cut (b): follow-up appender starts only after initial cursor commit so it
    // cannot race the snapshot (or coalesce under a half-committed cursor).
    let releaseFollowups: (() => void) | undefined;
    const followupsGate = new Promise<void>((resolve) => {
      releaseFollowups = resolve;
    });
    try {
      context = await runtimeContextForItemId(item.id, this.options, this.queue);
      const activeContext = context;

      // Prepare cursor delivery (flag-off → disabled, no behavior change).
      const prepared = await prepareCursorDelivery({
        agentId: this.options.agentId,
        item: context.item,
      });
      if (prepared.kind === 'already_delivered') {
        // Crash recovery: cursor already covers this wake — settle without a provider turn,
        // and coalesce any other same-surface wakes already under that cursor.
        await this.queue.complete(item.id);
        if (context.item.kind === 'slack') {
          const store = observedConversationStoreForAgent(this.options.agentId);
          const surfaceIds = surfacesForSlackWake(context.item);
          const surfaces = await Promise.all(surfaceIds.map(async (surfaceId) => {
            const cursor = await store.getCursor(surfaceId);
            const next = cursor.status === 'present' ? cursor.deliveredOrdinal : 0;
            return {
              surfaceId,
              cursorExpected: cursor.status === 'absent'
                ? { status: 'absent' as const }
                : { status: 'present' as const, deliveredOrdinal: cursor.deliveredOrdinal },
              nextDeliveredOrdinal: next,
              entries: [],
              candidateCount: 0,
              omittedCount: 0,
              establishOnly: next === 0,
            };
          }));
          await coalesceCoveredWakes({
            agentId: this.options.agentId,
            queue: this.queue,
            surfaces,
            excludeItemIds: new Set([item.id]),
            store,
          });
        }
        releaseFollowups?.();
        return 'settled';
      }
      if (prepared.kind === 'failed') {
        // Fail-closed without tombstone: requeue so repair can retry later.
        // Do not queue.fail — that moves the id to seen and loses the wake.
        this.logger.error(
          `Cursor delivery prepare failed for item ${item.id}: ${prepared.error.message} (${prepared.error.reason})`,
        );
        // Quiet requeue: no wake signal (avoids pendingWake → immediate reclaim hot loop).
        await this.queue.requeueQuiet(item.id);
        releaseFollowups?.();
        return 'deferred';
      }
      if (prepared.kind === 'prepared') {
        context.cursorDelivery = prepared.plan;
      }

      memoryCoherenceBeforeDigest = await this.memoryCoherenceDigest(context);
      // Gate-off / no plan: preserve pre-cut-(b) behavior — follow-ups run
      // without waiting on runtime.started (fake/test runtimes may omit it).
      // Gate-on: hold follow-ups until cursor commit at runtime.started.
      const holdFollowupsForCursorCommit = Boolean(context.cursorDelivery);
      if (!holdFollowupsForCursorCommit) {
        releaseFollowups?.();
      }
      followupLoop = followupsGate
        .then(() => appendQueuedFollowupsUntilFinished({
          activeContext,
          agentRuntime: this.options.agentRuntime,
          isIntakePaused: () => this.intakePaused,
          ...(this.options.isRestartDrainActive
            ? { isRestartDrainActive: this.options.isRestartDrainActive }
            : {}),
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
        }))
        .catch((error: unknown) => {
          followupError = error;
        });
      const agentConfig = await defaultAgentRegistryService.serviceFor(this.options.agentId).getConfig();
      const slackIdentity = agentConfig.slack.botUserId
        ? { handle: agentConfig.slack.botHandle, userId: agentConfig.slack.botUserId }
        : undefined;
      await setActiveRuntimeItem({
        agentId: this.options.agentId,
        startedAt: isoFromMs(handle.startedAt),
        itemId: context.item.id,
        workerId: this.workerId,
      }, this.queue);
      await this.notifyItemStarted(context);
      if (context.item.handling.resumeReason === 'runtime_restart') {
        await this.recordRestartResumeActivity(context);
      }
      const runContext = context;
      let providerProgressHealthClearStarted = false;
      const clearProviderFailureOnProviderProgress = () => {
        if (providerProgressHealthClearStarted) return;
        providerProgressHealthClearStarted = true;
        void (async () => {
          const current = await defaultAgentHealthService.get(this.options.agentId);
          if (!isProviderFailureReason(current?.reason)) return;
          await defaultAgentHealthService.writeHealth({
            agentId: this.options.agentId,
            clearProviderFailure: true,
            runtime: this.health(),
            state: 'healthy',
            updatedAt: nowIso(),
          });
        })().catch((error: unknown) => {
          providerProgressHealthClearStarted = false;
          this.logger.error(`Runtime worker provider-progress health clear failed for item ${item.id}: ${errorMessage(error)}`);
        });
      };
      const onRuntimeStarted = async () => {
        // Commit cursor + coalesce once at the provider-neutral runtime.started seam.
        if (runContext.cursorDelivery) {
          await commitCursorDelivery({
            plan: runContext.cursorDelivery,
            queue: this.queue,
          });
          // Release follow-ups only after cursor commit when gate-on.
          releaseFollowups?.();
        }
      };
      const result = await runProviderWithCrashRetries({
        agentId: this.options.agentId,
        agentRuntime: this.options.agentRuntime,
        buildInput: (retryNotice) => this.runtimeBridge.runInput({
          context: runContext,
          onActivity: () => handle.noteActivity(),
          onProviderProgress: clearProviderFailureOnProviderProgress,
          onRuntimeStarted,
          profile: {
            displayName: agentConfig.profile?.displayName ?? this.options.agentId,
            ...(agentConfig.profile?.role ? { role: agentConfig.profile.role } : {}),
            ...(slackIdentity ? { slackIdentity } : {}),
            transports: {
              feishu: agentConfig.feishu.connected,
              slack: agentConfig.slack.connected,
            },
          },
          retryNotice,
          session: runContext.session,
          signal: itemAbort.signal,
          suppressFailureRecord: true,
        }),
        itemId: item.id,
        onFinalFailureRecorded: (failure) => {
          runtimeFailureRecorded = true;
          recordedFailure = failure;
        },
        recoverCorruptSession: (error) => this.recoverCorruptProviderSession(
          runContext,
          handle,
          item.id,
          error,
        ),
        ...(this.options.providerRetry ? { retry: this.options.providerRetry } : {}),
        signal: itemAbort.signal,
      });
      itemAbort.abort('completed');
      // Ensure follow-ups are released even if runtime.started never fired.
      releaseFollowups?.();
      await followupLoop;
      if (followupError) throw followupError;
      this.logger.log(JSON.stringify({
        agentRuntime: this.options.agentRuntime.kind,
        event: 'runtime.completed',
        itemId: context.item.id,
        text: result.text,
        workerId: this.workerId,
      }, null, 2));
      await defaultAgentHealthService.writeHealth({
        agentId: this.options.agentId,
        clearProviderFailure: true,
        runtime: this.health(),
        state: 'healthy',
        updatedAt: nowIso(),
      });
      await this.recordMemoryCoherenceCompleted(
        context,
        result.text,
        isoFromMs(handle.startedAt),
        memoryCoherenceBeforeDigest,
      );
      await this.queue.complete(item.id);
      await this.queue.completeAppendedTo(item.id);
      appendedFollowupsSettled = true;
      return 'ran';
    } catch (error) {
      releaseFollowups?.();
      if (!itemAbort.signal.aborted) itemAbort.abort('failed');
      await followupLoop;
      if (followupError) {
        this.logger.error(`Runtime worker follow-up loop failed for item ${item.id}: ${errorMessage(followupError)}`);
      }
      const abortReason = itemAbort.signal.aborted ? abortReasonOf(itemAbort.signal) : undefined;
      let itemSettled = false;
      if (abortReason && context) {
        appendedFollowupsSettled = await this.settleAbortedItem(context, abortReason);
        itemSettled = true;
      } else if (context && isProviderRateLimitedError(error)) {
        const deferrals = (context.item.handling.deferrals ?? 0) + 1;
        if (deferrals <= MAX_RATE_LIMIT_DEFERRALS) {
          // Rate limit: keep the wake, park it until the provider's reset.
          await this.queue.requeueDeferred(item.id, {
            deferrals,
            notBefore: error.resumeAt.toISOString(),
          });
          await this.queue.requeueAppendedTo(item.id);
          this.logger.log(JSON.stringify({
            agentRuntime: this.options.agentRuntime.kind,
            deferrals,
            event: 'runtime.rate_limit_deferred',
            itemId: item.id,
            resumeAt: error.resumeAt.toISOString(),
            workerId: this.workerId,
          }, null, 2));
          return 'deferred';
        }
        await recordFinalRuntimeFailure({
          agentId: this.options.agentId,
          agentRuntime: this.options.agentRuntime,
          error: error.cause,
          itemId: item.id,
          providerFailure: true,
          retryAttempts: deferrals - 1,
          retryClass: 'rate_limited',
        });
        runtimeFailureRecorded = true;
      } else if (context && !runtimeFailureRecorded) {
        await recordFinalRuntimeFailure({
          agentId: this.options.agentId,
          agentRuntime: this.options.agentRuntime,
          error,
          itemId: item.id,
          retryAttempts: 0,
        });
      }
      if (!itemSettled) {
        await this.queue.fail(item.id);
        await this.queue.requeueAppendedTo(item.id);
        if (context) await this.notifyItemFailed(context, error, recordedFailure);
      }
      if (abortReason === 'restart_drain') {
        this.logger.log(JSON.stringify({
          agentRuntime: this.options.agentRuntime.kind,
          event: 'runtime.drained_for_restart',
          itemId: item.id,
          workerId: this.workerId,
        }, null, 2));
      } else {
        if (context?.item.kind === 'memory_coherence') {
          await this.recordMemoryCoherenceFailed(context, error, isoFromMs(handle.startedAt));
        }
        this.logger.error(`Runtime worker failed for item ${item.id}: ${errorMessage(error)}`);
      }
      return 'ran';
    } finally {
      if (context) {
        await clearActiveRuntimeItem({
          agentId: this.options.agentId,
          itemId: context.item.id,
          workerId: this.workerId,
        }, this.queue);
      }
      this.releaseActiveItem();
      if (context) {
        await this.notifySettledItems([
          context,
          ...(appendedFollowupsSettled ? handle.appendedFollowups : []),
        ]);
      }
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

  private async recoverCorruptProviderSession(
    context: RuntimeItemContext,
    handle: ActiveRunHandle,
    itemId: string,
    error: ProviderSessionCorruptionError,
  ): Promise<boolean> {
    const note = `Automatic recovery after ${error.reason.replaceAll('_', ' ')}`;
    const recovered = await runtimeSessionServiceForAgent(this.options.agentId)
      .archiveCorruptProviderSession(
        this.options.agentRuntime.kind,
        error.providerSessionId,
        note,
      );
    if (!recovered) return false;

    context.session = recovered.session;
    await this.queue.requeueAppendedTo(itemId);
    handle.appendedFollowups.length = 0;
    await recordSessionRotationActivity({
      agentId: this.options.agentId,
      itemId,
    }, {
      archivedAt: recovered.archived.archivedAt,
      archivedCount: 1,
      archivedProviderSessions: [recovered.archived],
      automatic: true,
      note,
      reason: error.reason,
    });
    return true;
  }

  private async recordMemoryCoherenceCompleted(
    context: RuntimeItemContext,
    resultText: string | undefined,
    startedAt: string,
    beforeDigest: string | undefined,
  ): Promise<void> {
    if (context.item.kind !== 'memory_coherence') return;
    const afterDigest = await memoryCoherenceDigest(context.homePath);
    await recordMemoryCoherenceCompleted({
      agentId: this.options.agentId,
      item: context.item,
      memoryChanged: beforeDigest !== afterDigest,
      resultText,
      startedAt,
    });
  }

  private async memoryCoherenceDigest(context: RuntimeItemContext): Promise<string | undefined> {
    if (context.item.kind !== 'memory_coherence') return undefined;
    return memoryCoherenceDigest(context.homePath);
  }

  private async recordMemoryCoherenceFailed(
    context: RuntimeItemContext,
    error: unknown,
    startedAt: string,
  ): Promise<void> {
    if (context.item.kind !== 'memory_coherence') return;
    await recordMemoryCoherenceFailed({
      agentId: this.options.agentId,
      error,
      item: context.item,
      startedAt,
    });
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

  private async notifyItemFailed(
    context: RuntimeItemContext,
    error: unknown,
    recorded: RuntimeItemFailure | undefined,
  ): Promise<void> {
    if (!this.options.onItemFailed) return;
    const failure: RuntimeItemFailure = isProviderRateLimitedError(error)
      ? {
          error: error.cause,
          retryAttempts: context.item.handling.deferrals ?? 0,
          retryClass: 'rate_limit_deferrals_exhausted',
        }
      : recorded ?? {
          error,
          retryAttempts: 0,
          retryClass: classifyProviderRetry(error),
        };
    try {
      await this.options.onItemFailed(context, failure);
    } catch (hookError) {
      this.logger.error(
        `Runtime worker item-failed hook failed for item ${context.item.id}: ${errorMessage(hookError)}`,
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

  private async settleAbortedItem(context: RuntimeItemContext, abortReason: ItemStopReason): Promise<boolean> {
    await recordRuntimeAborted(
      { agentId: this.options.agentId, itemId: context.item.id },
      abortReason,
      abortReason === 'idle_timeout' ? { timeoutMs: this.idleTimeoutMs } : undefined,
    );
    if (abortReason === 'restart_drain') {
      await this.queue.requeue(context.item.id, { resumeReason: 'runtime_restart' });
      await this.queue.requeueAppendedTo(context.item.id);
      return false;
    }
    await this.queue.fail(context.item.id);
    await this.queue.failAppendedTo(context.item.id);
    return true;
  }
}

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function abortReasonOf(signal: AbortSignal): ItemStopReason | undefined {
  const reason = signal.reason;
  return reason === 'idle_timeout' ||
    reason === 'operator_restart' ||
    reason === 'restart_drain' ||
    reason === 'shutdown' ||
    reason === 'user_stop'
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
