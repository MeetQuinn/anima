import type {
  Reminder,
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
  createdAt: string;
  updatedAt: string;
  nextDueAt?: string;
  lastFiredAt?: string;
  cancelledAt?: string;
  firedCount: number;
}

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
  if (reminder.nextDueAt) inspection.nextDueAt = reminder.nextDueAt;
  if (reminder.lastFiredAt) inspection.lastFiredAt = reminder.lastFiredAt;
  if (reminder.cancelledAt) inspection.cancelledAt = reminder.cancelledAt;
  return inspection;
}

export function formatReminderInspection(reminder: ReminderInspection): string {
  return [
    `reminder_id: ${JSON.stringify(reminder.reminderId)}`,
    `title: ${JSON.stringify(reminder.title)}`,
    `status: ${reminder.status}`,
    `schedule: ${JSON.stringify(reminder.schedule)}`,
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
