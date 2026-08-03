import { errorMessage } from '../ids.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { resolveAgentHomePath } from '../agents/agent-config-ops.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { reminderServiceForAgent, type ReminderService } from '../reminders/reminder.service.js';
import {
  classifyPreflightAttentionKey,
  endPreflight,
  preflightEvidenceForWake,
  runPreflightCommand,
  tryBeginPreflight,
} from '../reminders/preflight.js';
import type { Reminder } from '../../shared/reminder.js';
import type { ReminderInboxItem } from '../../shared/inbox.js';
import { WakeQueueService } from './wake-queue.service.js';

const REMINDER_POLL_MS = 30_000;
/** Throttle repeated identical preflight-error attention to once per hour. */
const PREFLIGHT_ERROR_ATTENTION_THROTTLE_MS = 60 * 60 * 1000;

export class ReminderInboxSubscriber {
  private poll?: Promise<void>;
  private readonly reminderService: ReminderService;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly queue: WakeQueueService,
    reminderService?: ReminderService,
  ) {
    this.reminderService = reminderService ?? reminderServiceForAgent(queue.agentId);
  }

  start(): void {
    this.timer = setInterval(() => void this.pollDueReminders(), REMINDER_POLL_MS);
    this.timer.unref();
    void this.pollDueReminders();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
    const firedAt = new Date();
    for (const reminder of await this.reminderService.dueReminders({ now: firedAt })) {
      await this.fireReminder(reminder, firedAt);
    }
  }

  private async fireReminder(reminder: Reminder, firedAt: Date): Promise<void> {
    if (reminder.preflight) {
      await this.fireReminderWithPreflight(reminder, firedAt);
      return;
    }
    await this.enqueueAndComplete(reminder, firedAt);
  }

  private async fireReminderWithPreflight(reminder: Reminder, firedAt: Date): Promise<void> {
    // Forbid concurrent preflight for the same reminder; skip this tick (no catch-up).
    if (!tryBeginPreflight(reminder.reminderId)) {
      console.log(
        `reminder preflight skipped overlap reminderId=${reminder.reminderId} firedAt=${firedAt.toISOString()}`,
      );
      return;
    }
    try {
      const agentHome = await resolveAgentHomeForPreflight(this.queue.agentId);
      const scheduledAt = reminder.nextDueAt ?? firedAt.toISOString();
      const { result } = await runPreflightCommand({
        command: reminder.preflight!.command,
        cwd: agentHome,
        now: firedAt,
        scheduledAt,
        ...(reminder.preflight!.timeoutMs !== undefined
          ? { timeoutMs: reminder.preflight!.timeoutMs }
          : {}),
      });

      if (result.status === 'succeeded') {
        const hadError = Boolean(reminder.preflightError);
        const scheduledAt = reminder.nextDueAt;
        const firedReminder = await this.reminderService.completeReminderFire({
          clearPreflightError: hadError,
          id: reminder.reminderId,
          now: firedAt,
          preflightResult: result,
        });
        if (hadError) await this.recordPreflightRecovery(reminder, result.status);
        await this.enqueueWakeOnly(
          firedReminder,
          firedAt,
          scheduledAt,
          preflightEvidenceForWake(result),
        );
        return;
      }

      if (result.status === 'declined') {
        const hadError = Boolean(reminder.preflightError);
        await this.reminderService.completeReminderFire({
          clearPreflightError: hadError,
          id: reminder.reminderId,
          now: firedAt,
          preflightResult: result,
        });
        if (hadError) await this.recordPreflightRecovery(reminder, result.status);
        console.log(
          `reminder preflight declined reminderId=${reminder.reminderId} exit=1 firedAt=${firedAt.toISOString()}`,
        );
        return;
      }

      // errored: advance schedule, no agent wake, persistent attention state
      const attentionKey = classifyPreflightAttentionKey(reminder.reminderId, result);
      const shouldNotify = shouldNotifyPreflightError(reminder, attentionKey, firedAt);
      await this.reminderService.completeReminderFire({
        id: reminder.reminderId,
        now: firedAt,
        preflightResult: result,
        setPreflightError: {
          attentionKey,
          ...(shouldNotify ? { lastNotifiedAt: firedAt.toISOString() } : {}),
          since: reminder.preflightError?.since ?? firedAt.toISOString(),
        },
      });
      if (shouldNotify) {
        await this.recordPreflightErrorAttention(reminder, result);
      }
      console.log(
        `reminder preflight errored reminderId=${reminder.reminderId} exit=${result.exitCode ?? '-'} timedOut=${Boolean(result.timedOut)} firedAt=${firedAt.toISOString()}`,
      );
    } finally {
      endPreflight(reminder.reminderId);
    }
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
    const firedReminder = await this.reminderService.completeReminderFire({
      id: reminder.reminderId,
      now: firedAt,
    });
    if (!decision.duplicate) {
      await this.reminderService.recordReminderFire({
        firedAt,
        reminder: firedReminder,
      });
    }
    console.log(
      `reminder fired reminderId=${reminder.reminderId} eventId=${event.id} duplicate=${Boolean(decision.duplicate)} queued=${Boolean(decision.queued)} firedAt=${firedAt.toISOString()}`,
    );
  }

  /** Preflight already completed the fire; only enqueue the agent wake. */
  private async enqueueWakeOnly(
    firedReminder: Reminder,
    firedAt: Date,
    scheduledAt: string | undefined,
    preflightEvidence?: string,
  ): Promise<void> {
    const receivedAt = firedAt.toISOString();
    const event: ReminderInboxItem = {
      id: `reminder:${firedReminder.reminderId}:fire:${firedReminder.firedCount}`,
      kind: 'reminder',
      receivedAt,
      handling: {
        createdAt: receivedAt,
        queuedAt: receivedAt,
        status: 'queued',
        updatedAt: receivedAt,
      },
      reminderId: firedReminder.reminderId,
      ...(scheduledAt ? { scheduledAt } : {}),
      ...(preflightEvidence ? { preflightEvidence } : {}),
      title: firedReminder.title,
    };
    const decision = await this.queue.enqueue(event);
    if (!decision.duplicate) {
      await this.reminderService.recordReminderFire({
        firedAt,
        reminder: firedReminder,
      });
    }
    console.log(
      `reminder fired reminderId=${firedReminder.reminderId} eventId=${event.id} duplicate=${Boolean(decision.duplicate)} queued=${Boolean(decision.queued)} firedAt=${firedAt.toISOString()} preflight=succeeded`,
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

function shouldNotifyPreflightError(
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
