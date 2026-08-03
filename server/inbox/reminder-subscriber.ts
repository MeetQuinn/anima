import { errorMessage } from '../ids.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { resolveAgentHomePath } from '../agents/agent-config-ops.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import {
  matchesExpectedVersion,
  reminderServiceForAgent,
  type ReminderExpectedVersion,
  type ReminderService,
} from '../reminders/reminder.service.js';
import {
  classifyPreflightAttentionKey,
  endPreflight,
  preflightEvidenceForWake,
  runPreflightCommand,
  tryBeginPreflight,
  type PreflightLastResult,
} from '../reminders/preflight.js';
import type { Reminder } from '../../shared/reminder.js';
import type { ReminderInboxItem } from '../../shared/inbox.js';
import { WakeQueueService } from './wake-queue.service.js';

const REMINDER_POLL_MS = 30_000;
/** Throttle repeated identical preflight-error attention to once per hour. */
export const PREFLIGHT_ERROR_ATTENTION_THROTTLE_MS = 60 * 60 * 1000;

interface ManagedPreflightJob {
  abort: AbortController;
  promise: Promise<void>;
  reminderId: string;
}

/** Test-only: runs after the outer live recheck, before the commit CAS. */
let afterRecheckHookForTests: (() => Promise<void>) | undefined;

export function setPreflightAfterRecheckHookForTests(
  hook?: () => Promise<void>,
): void {
  afterRecheckHookForTests = hook;
}

export class ReminderInboxSubscriber {
  private poll?: Promise<void>;
  private readonly jobs = new Map<string, ManagedPreflightJob>();
  private readonly reminderService: ReminderService;
  private stopping = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly queue: WakeQueueService,
    reminderService?: ReminderService,
  ) {
    this.reminderService = reminderService ?? reminderServiceForAgent(queue.agentId);
  }

  start(): void {
    this.stopping = false;
    this.timer = setInterval(() => void this.pollDueReminders(), REMINDER_POLL_MS);
    this.timer.unref();
    void this.pollDueReminders();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Abort only this subscriber's managed jobs (not process-global preflights).
    // AbortSignal kills each job's process group; then await cleanup.
    for (const job of this.jobs.values()) {
      job.abort.abort();
    }
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
    await (this.poll ?? Promise.resolve());
  }

  private async pollDueReminders(): Promise<void> {
    if (this.poll) return this.poll;
    this.poll = this.fireDueReminders()
      .catch((error: unknown) => {
        console.error(`Reminder scheduler failed for ${this.queue.agentId}: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.poll = undefined;
      });
    return this.poll;
  }

  private async fireDueReminders(): Promise<void> {
    if (this.stopping) return;
    const polledAt = new Date();
    for (const reminder of await this.reminderService.dueReminders({ now: polledAt })) {
      if (this.stopping) return;
      if (reminder.preflight) {
        // Do not await long commands — track as managed job so poll can continue.
        // Clone snapshot: store updates mutate shared object refs from JsonStore cache.
        this.startPreflightJob(cloneReminder(reminder));
        continue;
      }
      await this.enqueueAndComplete(reminder, polledAt);
    }
  }

  private startPreflightJob(reminder: Reminder): void {
    if (this.jobs.has(reminder.reminderId)) {
      console.log(
        `reminder preflight skipped overlap reminderId=${reminder.reminderId}`,
      );
      return;
    }

    const abort = new AbortController();
    if (!tryBeginPreflight(reminder.reminderId, () => abort.abort())) {
      console.log(
        `reminder preflight skipped overlap reminderId=${reminder.reminderId}`,
      );
      return;
    }

    const promise = this.runPreflightJob(reminder, abort)
      .catch((error: unknown) => {
        console.error(
          `reminder preflight job failed reminderId=${reminder.reminderId}: ${errorMessage(error)}`,
        );
      })
      .finally(() => {
        endPreflight(reminder.reminderId);
        this.jobs.delete(reminder.reminderId);
      });

    this.jobs.set(reminder.reminderId, {
      abort,
      promise,
      reminderId: reminder.reminderId,
    });
  }

  private async runPreflightJob(
    snapshot: Reminder,
    abort: AbortController,
  ): Promise<void> {
    const startedAt = new Date();
    const scheduledAt = snapshot.nextDueAt ?? startedAt.toISOString();
    const preflightConfig = snapshot.preflight;
    if (!preflightConfig) return;

    const agentHome = await resolveAgentHomeForPreflight(this.queue.agentId);

    const { aborted, result } = await runPreflightCommand({
      abortSignal: abort.signal,
      command: preflightConfig.command,
      cwd: agentHome,
      now: startedAt,
      scheduledAt,
      ...(preflightConfig.timeoutMs !== undefined ? { timeoutMs: preflightConfig.timeoutMs } : {}),
    });

    if (aborted || this.stopping || !result) {
      console.log(
        `reminder preflight discarded aborted reminderId=${snapshot.reminderId}`,
      );
      return;
    }

    const completedAt = new Date();
    // Fast-path recheck (cancel/snooze/config). Authoritative CAS is inside the store update.
    const live = await this.reminderService.findReminder(snapshot.reminderId);
    const liveStatus = live?.status ?? 'missing';
    if (!isPreflightResultStillValid(snapshot, live)) {
      console.log(
        `reminder preflight discarded stale reminderId=${snapshot.reminderId} status=${liveStatus}`,
      );
      return;
    }

    if (afterRecheckHookForTests) {
      await afterRecheckHookForTests();
    }

    const expected = expectedVersionFrom(snapshot);
    if (result.status === 'succeeded') {
      await this.commitSucceededPreflight(live, result, completedAt, scheduledAt, expected);
      return;
    }
    if (result.status === 'declined') {
      await this.commitDeclinedPreflight(live, result, completedAt, expected);
      return;
    }
    await this.commitErroredPreflight(live, result, completedAt, expected);
  }

  private async commitSucceededPreflight(
    reminder: Reminder,
    result: PreflightLastResult,
    completedAt: Date,
    scheduledAt: string,
    expected: ReminderExpectedVersion,
  ): Promise<void> {
    const hadError = Boolean(reminder.preflightError);
    // Durable enqueue BEFORE schedule advance / fire count (legacy crash ordering).
    const receivedAt = completedAt.toISOString();
    const event: ReminderInboxItem = {
      id: `reminder:${reminder.reminderId}:fire:${reminder.firedCount + 1}`,
      kind: 'reminder',
      receivedAt,
      handling: {
        createdAt: receivedAt,
        queuedAt: receivedAt,
        status: 'queued',
        updatedAt: receivedAt,
      },
      reminderId: reminder.reminderId,
      scheduledAt,
      ...(preflightEvidenceForWake(result)
        ? { preflightEvidence: preflightEvidenceForWake(result) }
        : {}),
      title: reminder.title,
    };

    let decision;
    try {
      decision = await this.queue.enqueue(event);
    } catch (error) {
      // Leave reminder scheduled with original nextDueAt so the wake is not lost.
      console.error(
        `reminder preflight enqueue failed reminderId=${reminder.reminderId}: ${errorMessage(error)}`,
      );
      return;
    }

    // CAS complete inside store lock; if stale after enqueue, withdraw the wake.
    const transition = await this.reminderService.completeReminderFire({
      clearPreflightError: hadError,
      expected,
      id: reminder.reminderId,
      now: completedAt,
      preflightResult: result,
    });
    if (!transition.applied) {
      const withdrawn = await this.queue.withdrawQueued(event.id);
      console.log(
        `reminder preflight discarded after enqueue reminderId=${reminder.reminderId} withdrawn=${Boolean(withdrawn)}`,
      );
      return;
    }
    if (hadError) await this.recordPreflightRecovery(reminder, result.status);
    if (!decision.duplicate) {
      await this.reminderService.recordReminderFire({
        firedAt: completedAt,
        reminder: transition.reminder,
      });
    }
    console.log(
      `reminder fired reminderId=${transition.reminder.reminderId} eventId=${event.id} duplicate=${Boolean(decision.duplicate)} queued=${Boolean(decision.queued)} firedAt=${completedAt.toISOString()} preflight=succeeded`,
    );
  }

  private async commitDeclinedPreflight(
    reminder: Reminder,
    result: PreflightLastResult,
    completedAt: Date,
    expected: ReminderExpectedVersion,
  ): Promise<void> {
    const hadError = Boolean(reminder.preflightError);
    const transition = await this.reminderService.recordPreflightCheck({
      clearPreflightError: hadError,
      expected,
      id: reminder.reminderId,
      now: completedAt,
      preflightResult: result,
    });
    if (!transition.applied) {
      console.log(
        `reminder preflight declined discarded stale reminderId=${reminder.reminderId}`,
      );
      return;
    }
    if (hadError) await this.recordPreflightRecovery(reminder, result.status);
    console.log(
      `reminder preflight declined reminderId=${reminder.reminderId} exit=1 completedAt=${completedAt.toISOString()}`,
    );
  }

  private async commitErroredPreflight(
    reminder: Reminder,
    result: PreflightLastResult,
    completedAt: Date,
    expected: ReminderExpectedVersion,
  ): Promise<void> {
    const attentionKey = classifyPreflightAttentionKey(reminder.reminderId, result);
    const shouldNotify = shouldNotifyPreflightError(reminder, attentionKey, completedAt);
    const transition = await this.reminderService.recordPreflightCheck({
      expected,
      id: reminder.reminderId,
      now: completedAt,
      preflightResult: result,
      setPreflightError: {
        attentionKey,
        // Only set lastNotifiedAt when we actually notify; otherwise service
        // preserves the previous timestamp (throttle must not erase it).
        ...(shouldNotify ? { lastNotifiedAt: completedAt.toISOString() } : {}),
        since: reminder.preflightError?.since ?? completedAt.toISOString(),
      },
    });
    if (!transition.applied) {
      console.log(
        `reminder preflight errored discarded stale reminderId=${reminder.reminderId}`,
      );
      return;
    }
    if (shouldNotify) {
      await this.recordPreflightErrorAttention(reminder, result);
    }
    console.log(
      `reminder preflight errored reminderId=${reminder.reminderId} exit=${result.exitCode ?? '-'} timedOut=${Boolean(result.timedOut)} completedAt=${completedAt.toISOString()} notified=${shouldNotify}`,
    );
  }

  /** Classic path: enqueue wake then complete fire (original ordering). */
  private async enqueueAndComplete(reminder: Reminder, firedAt: Date): Promise<void> {
    const receivedAt = firedAt.toISOString();
    const event: ReminderInboxItem = {
      id: `reminder:${reminder.reminderId}:fire:${reminder.firedCount + 1}`,
      kind: 'reminder',
      receivedAt,
      handling: {
        createdAt: receivedAt,
        queuedAt: receivedAt,
        status: 'queued',
        updatedAt: receivedAt,
      },
      reminderId: reminder.reminderId,
      ...(reminder.nextDueAt ? { scheduledAt: reminder.nextDueAt } : {}),
      title: reminder.title,
    };
    const decision = await this.queue.enqueue(event);
    const transition = await this.reminderService.completeReminderFire({
      id: reminder.reminderId,
      now: firedAt,
    });
    if (!transition.applied) {
      await this.queue.withdrawQueued(event.id);
      return;
    }
    if (!decision.duplicate) {
      await this.reminderService.recordReminderFire({
        firedAt,
        reminder: transition.reminder,
      });
    }
    console.log(
      `reminder fired reminderId=${reminder.reminderId} eventId=${event.id} duplicate=${Boolean(decision.duplicate)} queued=${Boolean(decision.queued)} firedAt=${firedAt.toISOString()}`,
    );
  }

  private async recordPreflightErrorAttention(
    reminder: Reminder,
    result: { exitCode?: number; signal?: string; timedOut?: boolean },
  ): Promise<void> {
    const detail = [
      result.timedOut ? 'timed out' : undefined,
      result.signal ? `signal ${result.signal}` : undefined,
      result.exitCode !== undefined ? `exit ${result.exitCode}` : undefined,
    ].filter(Boolean).join(', ') || 'errored';
    await activityServiceForAgent(this.queue.agentId).record({
      type: 'anima.attention.suggestion',
      payload: {
        ...(reminder.provenance?.channelId ? { channelId: reminder.provenance.channelId } : {}),
        platform: 'reminder',
        reminderId: reminder.reminderId,
        suggestion:
          `Reminder preflight-error on "${reminder.title}" (${reminder.reminderId}): ${detail}. `
          + 'Needs attention — the agent was not woken. Fix the preflight command or cancel the reminder.',
        title: reminder.title,
      },
    }).catch((error: unknown) => {
      console.warn(`preflight error attention failed: ${errorMessage(error)}`);
    });
  }

  private async recordPreflightRecovery(reminder: Reminder, status: string): Promise<void> {
    await activityServiceForAgent(this.queue.agentId).record({
      type: 'anima.attention.suggestion',
      payload: {
        platform: 'reminder',
        reminderId: reminder.reminderId,
        suggestion:
          `Reminder preflight recovered on "${reminder.title}" (${reminder.reminderId}): ${status}.`,
        title: reminder.title,
      },
    }).catch((error: unknown) => {
      console.warn(`preflight recovery activity failed: ${errorMessage(error)}`);
    });
  }
}

function cloneReminder(reminder: Reminder): Reminder {
  return structuredClone(reminder);
}

function expectedVersionFrom(reminder: Reminder): ReminderExpectedVersion {
  return {
    status: reminder.status,
    updatedAt: reminder.updatedAt,
    ...(reminder.nextDueAt !== undefined ? { nextDueAt: reminder.nextDueAt } : {}),
    ...(reminder.preflight ? { preflight: reminder.preflight } : {}),
  };
}

/** Cancel/snooze/config edits bump updatedAt and must void in-flight preflight results. */
export function isPreflightResultStillValid(
  snapshot: Reminder,
  live: Reminder | undefined,
): live is Reminder {
  if (!live || live.status !== 'scheduled') return false;
  return matchesExpectedVersion(live, expectedVersionFrom(snapshot));
}

export function shouldNotifyPreflightError(
  reminder: Reminder,
  attentionKey: string,
  now: Date,
): boolean {
  const existing = reminder.preflightError;
  if (!existing || existing.attentionKey !== attentionKey) return true;
  if (!existing.lastNotifiedAt) return true;
  const last = Date.parse(existing.lastNotifiedAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= PREFLIGHT_ERROR_ATTENTION_THROTTLE_MS;
}

async function resolveAgentHomeForPreflight(agentId: string): Promise<string> {
  const store = new AgentStore(agentId);
  if (!store.exists()) throw new Error(`Agent not found for preflight cwd: ${agentId}`);
  const agent = await store.read();
  return resolveAgentHomePath(agent);
}
