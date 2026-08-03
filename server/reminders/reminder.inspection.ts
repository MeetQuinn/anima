import type {
  Reminder,
  ReminderPreflight,
  ReminderPreflightErrorState,
  ReminderPreflightLastResult,
  ReminderProvenance,
  ReminderSchedule,
  ReminderStatus,
} from '../../shared/reminder.js';

export interface ReminderInspection {
  reminderId: string;
  title: string;
  instructions: string;
  status: ReminderStatus;
  schedule: ReminderSchedule;
  provenance?: ReminderProvenance;
  preflight?: ReminderPreflight;
  preflightError?: ReminderPreflightErrorState;
  preflightLastResult?: ReminderPreflightLastResult;
  createdAt: string;
  updatedAt: string;
  nextDueAt?: string;
  lastFiredAt?: string;
  cancelledAt?: string;
  firedCount: number;
}

type Assert<T extends true> = T;
export type ReminderInspectionKeysMatch = Assert<
  [keyof Reminder] extends [keyof ReminderInspection]
    ? [keyof ReminderInspection] extends [keyof Reminder]
      ? true
      : false
    : false
>;

export function inspectReminder(reminder: Reminder): ReminderInspection {
  const inspection: ReminderInspection = {
    reminderId: reminder.reminderId,
    title: reminder.title,
    instructions: reminder.instructions,
    status: reminder.status,
    schedule: reminder.schedule,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
    firedCount: reminder.firedCount,
  };
  if (reminder.provenance) inspection.provenance = reminder.provenance;
  if (reminder.preflight) inspection.preflight = reminder.preflight;
  if (reminder.preflightError) inspection.preflightError = reminder.preflightError;
  if (reminder.preflightLastResult) inspection.preflightLastResult = reminder.preflightLastResult;
  if (reminder.nextDueAt) inspection.nextDueAt = reminder.nextDueAt;
  if (reminder.lastFiredAt) inspection.lastFiredAt = reminder.lastFiredAt;
  if (reminder.cancelledAt) inspection.cancelledAt = reminder.cancelledAt;
  return inspection;
}

export function formatReminderInspection(reminder: ReminderInspection): string {
  const preflightLabel = reminder.preflight
    ? `command=${JSON.stringify(reminder.preflight.command)}`
      + (reminder.preflight.timeoutMs !== undefined ? ` timeoutMs=${reminder.preflight.timeoutMs}` : '')
    : '-';
  const last = reminder.preflightLastResult
    ? JSON.stringify({
        status: reminder.preflightLastResult.status,
        exitCode: reminder.preflightLastResult.exitCode,
        timedOut: reminder.preflightLastResult.timedOut,
        signal: reminder.preflightLastResult.signal,
        durationMs: reminder.preflightLastResult.durationMs,
      })
    : '-';
  return [
    `reminder_id: ${JSON.stringify(reminder.reminderId)}`,
    `title: ${JSON.stringify(reminder.title)}`,
    `status: ${reminder.status}`,
    `schedule: ${JSON.stringify(reminder.schedule)}`,
    `run_only_when: ${preflightLabel}`,
    `preflight_last: ${last}`,
    `preflight_error: ${reminder.preflightError ? JSON.stringify(reminder.preflightError) : '-'}`,
    `provenance: ${reminder.provenance ? JSON.stringify(reminder.provenance) : '-'}`,
    `created_at: ${reminder.createdAt}`,
    `updated_at: ${reminder.updatedAt}`,
    `next_due_at: ${reminder.nextDueAt ?? '-'}`,
    `last_fired_at: ${reminder.lastFiredAt ?? '-'}`,
    `cancelled_at: ${reminder.cancelledAt ?? '-'}`,
    `fired_count: ${reminder.firedCount}`,
    'instructions:',
    reminder.instructions,
  ].join('\n');
}
