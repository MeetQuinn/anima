import { errorMessage, makeId } from '../ids.js';
import type { Reminder, ReminderProvenance, ReminderStatus } from '../../shared/reminder.js';
import { ReminderStore } from '../storage/schema/reminder.store.js';
import type { ReminderPreflightLastResult } from '../../shared/reminder.js';
import {
  buildWindowedIntervalSchedule,
  initialDueAt,
  nextDueAtForSchedule,
  parseDurationMs,
  parseRepeatRule,
  systemTimezone,
} from './reminder.helper.js';
import {
  defaultReminderActivityRecorder,
  type ReminderActivityRecorder,
} from './reminder.activity.js';
import {
  normalizePreflightTimeoutMs,
  validatePreflightCommand,
} from './preflight.js';

const SETTLED_REMINDER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ScheduleReminderInput {
  delaySeconds?: number;
  fireAt?: string;
  instructions: string;
  now?: Date;
  /** Optional shell gate; product label "Run only when". CWD is always Agent Home. */
  preflight?: { command: string; timeoutMs?: number };
  provenance?: ReminderProvenance;
  repeat?: string;
  timezone?: string;
  title: string;
  /** Local weekday+time window; only valid with every:* intervals. */
  window?: string;
}

export class ReminderService {
  constructor(
    private readonly agentId: string,
    private readonly store: ReminderStore = new ReminderStore(agentId),
    private readonly activity: ReminderActivityRecorder = defaultReminderActivityRecorder,
  ) {}

  async scheduleReminder(input: ScheduleReminderInput): Promise<Reminder> {
    const now = input.now ?? new Date();
    return this.activity.schedule({
      agentId: this.agentId,
      title: input.title,
      ...(input.repeat ? { repeat: input.repeat } : {}),
      ...(input.window ? { window: input.window } : {}),
      ...(input.fireAt ? { fireAt: input.fireAt } : {}),
      ...(input.delaySeconds !== undefined ? { delaySeconds: input.delaySeconds } : {}),
      ...(input.preflight ? { preflight: input.preflight } : {}),
    }, async () => {
      const title = input.title.trim();
      const instructions = input.instructions.trim();
      if (!title) throw new Error('reminder schedule requires title');
      if (!instructions) throw new Error('reminder schedule requires instructions');

      const hasFireAt = Boolean(input.fireAt);
      const hasDelay = input.delaySeconds !== undefined;
      const hasRepeat = Boolean(input.repeat);
      const windowRule = input.window?.trim();
      if (windowRule && !hasRepeat) {
        throw new Error('--window requires --repeat every:<n><m|h|d>');
      }
      // v1: first wake is always the next eligible grid slot — never fire outside the window.
      if (windowRule && (hasFireAt || hasDelay)) {
        throw new Error(
          '--window cannot be combined with --fire-at or --in; first wake is the next eligible grid slot',
        );
      }
      if (hasFireAt && hasDelay) throw new Error('Pass only one of fireAt or delaySeconds');
      if (!hasFireAt && !hasDelay && !hasRepeat) {
        throw new Error('Pass fireAt, delaySeconds, or repeat');
      }

      const timezone = input.timezone?.trim() || systemTimezone();
      let schedule = hasRepeat
        ? parseRepeatRule(input.repeat as string, timezone)
        : { kind: 'once' as const };
      if (windowRule) {
        schedule = buildWindowedIntervalSchedule({
          repeatRule: input.repeat as string,
          timezone,
          windowRule,
        });
      }
      const createdAt = now.toISOString();
      const nextDueAt = initialDueAt({
        delaySeconds: input.delaySeconds,
        fireAt: input.fireAt,
        now,
        schedule,
      });
      if (schedule.kind === 'interval') {
        schedule = {
          ...schedule,
          phaseAnchorAt: hasFireAt || hasDelay ? nextDueAt : createdAt,
        };
      }
      const preflight = input.preflight
        ? {
            command: validatePreflightCommand(input.preflight.command),
            ...(input.preflight.timeoutMs !== undefined
              ? { timeoutMs: normalizePreflightTimeoutMs(input.preflight.timeoutMs) }
              : {}),
          }
        : undefined;
      const reminder: Reminder = {
        createdAt,
        firedCount: 0,
        instructions,
        nextDueAt,
        ...(preflight ? { preflight } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
        reminderId: makeId('rem'),
        schedule,
        status: 'scheduled',
        title,
        updatedAt: createdAt,
      };
      await this.store.create(reminder);
      await this.pruneOldSettled(now);
      return reminder;
    });
  }

  async cancelReminder(input: { id: string; now?: Date }): Promise<Reminder> {
    const now = input.now ?? new Date();
    return this.activity.cancel({ agentId: this.agentId, id: input.id }, async () => {
      const reminder = await this.store.find(input.id);
      if (!reminder) throw new Error(`Reminder not found: ${input.id}`);
      if (reminder.status === 'cancelled') return reminder;
      const cancelledAt = now.toISOString();
      reminder.status = 'cancelled';
      reminder.cancelledAt = cancelledAt;
      reminder.updatedAt = cancelledAt;
      delete reminder.nextDueAt;
      const updated = await this.store.update(reminder);
      await this.pruneOldSettled(now);
      return updated;
    });
  }

  async snoozeReminder(input: { by: string; id: string; now?: Date }): Promise<Reminder> {
    const durationMs = parseDurationMs(input.by);
    const now = input.now ?? new Date();
    return this.activity.snooze({ agentId: this.agentId, id: input.id }, async () => {
      const reminder = await this.store.find(input.id);
      if (!reminder) throw new Error(`Reminder not found: ${input.id}`);
      if (reminder.status === 'cancelled') {
        throw new Error(`Cannot snooze cancelled reminder: ${reminder.reminderId}`);
      }
      reminder.status = 'scheduled';
      reminder.nextDueAt = new Date(now.getTime() + durationMs).toISOString();
      reminder.updatedAt = now.toISOString();
      const updated = await this.store.update(reminder);
      await this.pruneOldSettled(now);
      return updated;
    });
  }

  async completeReminderFire(input: {
    id: string;
    now?: Date;
    /** When set, advances schedule after a preflight outcome (wake, decline, or error). */
    preflightResult?: ReminderPreflightLastResult;
    clearPreflightError?: boolean;
    setPreflightError?: { attentionKey: string; since: string; lastNotifiedAt?: string };
  }): Promise<Reminder> {
    const now = input.now ?? new Date();
    const reminder = await this.store.find(input.id);
    if (!reminder) throw new Error(`Reminder not found: ${input.id}`);
    const firedAt = now.toISOString();
    reminder.firedCount += 1;
    reminder.lastFiredAt = firedAt;
    if (input.preflightResult) {
      reminder.preflightLastResult = input.preflightResult;
    }
    if (input.clearPreflightError) {
      delete reminder.preflightError;
    }
    if (input.setPreflightError) {
      reminder.preflightError = {
        attentionKey: input.setPreflightError.attentionKey,
        since: input.setPreflightError.since,
        ...(input.setPreflightError.lastNotifiedAt
          ? { lastNotifiedAt: input.setPreflightError.lastNotifiedAt }
          : {}),
      };
    }
    if (reminder.schedule.kind === 'once') {
      reminder.status = 'fired';
      delete reminder.nextDueAt;
    } else {
      reminder.status = 'scheduled';
      // Records created before phaseAnchorAt was introduced retain their
      // original creation-time recurrence origin without rewriting the store.
      reminder.nextDueAt = nextDueAtForSchedule(reminder.schedule, now, reminder.createdAt);
    }
    reminder.updatedAt = firedAt;
    const updated = await this.store.update(reminder);
    await this.pruneOldSettled(now);
    return updated;
  }

  async recordReminderFire(input: {
    firedAt?: Date;
    reminder: Reminder;
  }): Promise<void> {
    await this.activity.fire({ agentId: this.agentId, ...input });
  }

  async listReminders(input: { statuses?: ReminderStatus[] } = {}): Promise<Reminder[]> {
    const statuses = new Set(input.statuses ?? ['scheduled', 'fired']);
    const reminders = await this.listAllReminders();
    return reminders
      .filter((reminder) => statuses.has(reminder.status))
      .sort((a, b) => (a.nextDueAt ?? a.updatedAt).localeCompare(b.nextDueAt ?? b.updatedAt));
  }

  async listAllReminders(): Promise<Reminder[]> {
    return this.store.list();
  }

  async findReminder(reminderId: string): Promise<Reminder | undefined> {
    return this.store.find(reminderId);
  }

  async dueReminders(input: { now?: Date } = {}): Promise<Reminder[]> {
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const reminders = await this.listAllReminders();
    return reminders
      .filter(
        (reminder) =>
          reminder.status === 'scheduled' &&
          reminder.nextDueAt !== undefined &&
          Date.parse(reminder.nextDueAt) <= nowMs,
      )
      .sort((a, b) => (a.nextDueAt ?? '').localeCompare(b.nextDueAt ?? ''));
  }

  private async pruneOldSettled(now: Date): Promise<void> {
    const cutoffIso = new Date(now.getTime() - SETTLED_REMINDER_RETENTION_MS).toISOString();
    try {
      await this.store.pruneSettledBefore(cutoffIso);
    } catch (error) {
      console.warn(`Reminder retention failed for ${this.agentId}: ${errorMessage(error)}`);
    }
  }
}

export function reminderServiceForAgent(agentId: string): ReminderService {
  return new ReminderService(agentId);
}
