import type { DateTime } from 'luxon';

import type { Reminder, ReminderSchedule } from '../../shared/reminder.js';
import { parseTimeOfDay, timeOnLocalDay, zonedDateTime } from '../schedule/local-time.js';

export { systemTimezone } from '../schedule/local-time.js';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type Weekday = (typeof WEEKDAYS)[number];

export function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number.parseInt(match[1] ?? '', 10);
  switch ((match[2] ?? '').toLowerCase()) {
    case 's': return amount * 1000;
    case 'm': return amount * 60 * 1000;
    case 'h': return amount * 60 * 60 * 1000;
    case 'd': return amount * 24 * 60 * 60 * 1000;
    default: throw new Error(`Invalid duration: ${value}`);
  }
}

export function parseRepeatRule(rule: string, timezone: string): ReminderSchedule {
  const normalized = rule.trim().toLowerCase();
  const interval = normalized.match(/^every:(\d+)(m|h|d)$/);
  if (interval) {
    const intervalMs = parseDurationMs(`${interval[1]}${interval[2]}`);
    if (intervalMs <= 0) throw new Error(`Repeat interval must be greater than zero: ${rule}`);
    return {
      intervalMs,
      kind: 'interval',
      repeatRule: normalized,
    };
  }

  const daily = normalized.match(/^daily@(\d{2}:\d{2})$/);
  if (daily) {
    assertValidTime(daily[1] ?? '');
    return {
      kind: 'daily',
      repeatRule: normalized,
      time: daily[1] as string,
      timezone,
    };
  }

  const weekly = normalized.match(/^weekly:([a-z,]+)@(\d{2}:\d{2})$/);
  if (weekly) {
    const weekdays = (weekly[1] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (weekdays.length === 0 || weekdays.some((day) => !isWeekday(day))) {
      throw new Error(`Invalid weekly repeat weekdays: ${rule}`);
    }
    assertValidTime(weekly[2] ?? '');
    return {
      kind: 'weekly',
      repeatRule: normalized,
      time: weekly[2] as string,
      timezone,
      weekdays,
    };
  }

  throw new Error(`Invalid repeat rule: ${rule}`);
}

export function nextDueAtForSchedule(schedule: ReminderSchedule, after: Date): string {
  switch (schedule.kind) {
    case 'once':
      throw new Error('One-shot reminders do not have a repeat schedule.');
    case 'interval':
      return new Date(after.getTime() + schedule.intervalMs).toISOString();
    case 'daily':
      return nextDailyDueAt(schedule.time, schedule.timezone, after).toISOString();
    case 'weekly':
      return nextWeeklyDueAt(schedule.weekdays as Weekday[], schedule.time, schedule.timezone, after).toISOString();
  }
}

export function initialDueAt(input: {
  delaySeconds?: number;
  fireAt?: string;
  now: Date;
  schedule: ReminderSchedule;
}): string {
  if (input.fireAt) {
    const date = new Date(input.fireAt);
    if (!Number.isFinite(date.getTime())) throw new Error(`Invalid fireAt: ${input.fireAt}`);
    return date.toISOString();
  }
  if (input.delaySeconds !== undefined) {
    if (!Number.isFinite(input.delaySeconds) || input.delaySeconds <= 0) {
      throw new Error('delaySeconds must be greater than 0');
    }
    return new Date(input.now.getTime() + input.delaySeconds * 1000).toISOString();
  }
  return nextDueAtForSchedule(input.schedule, input.now);
}

export function reminderActivityPayload(tool: string, reminder: Reminder): Record<string, unknown> {
  return {
    tool,
    ...reminderActivityFields(reminder),
  };
}

export function reminderActivityFields(reminder: Reminder): Record<string, unknown> {
  return {
    reminderId: reminder.reminderId,
    title: reminder.title,
    status: reminder.status,
    ...(reminder.cancelledAt ? { cancelledAt: reminder.cancelledAt } : {}),
    ...(reminder.lastFiredAt ? { lastFiredAt: reminder.lastFiredAt } : {}),
    ...(reminder.nextDueAt ? { nextDueAt: reminder.nextDueAt } : {}),
  };
}

const DAILY_LOOKAHEAD_DAYS = 8;
const WEEKLY_LOOKAHEAD_DAYS = 14;

function nextDailyDueAt(time: string, timezone: string, after: Date): Date {
  const current = zonedDateTime(after, timezone);
  for (let offset = 0; offset <= DAILY_LOOKAHEAD_DAYS; offset += 1) {
    const candidate = localTimeOnDay(current.plus({ days: offset }), time, timezone);
    if (candidate.toMillis() > after.getTime()) return candidate.toJSDate();
  }
  throw new Error('Unable to calculate next daily reminder time.');
}

function nextWeeklyDueAt(weekdays: Weekday[], time: string, timezone: string, after: Date): Date {
  const wanted = new Set(weekdays.map((day) => WEEKDAYS.indexOf(day)));
  const current = zonedDateTime(after, timezone);
  for (let offset = 0; offset <= WEEKLY_LOOKAHEAD_DAYS; offset += 1) {
    const candidateDay = current.plus({ days: offset });
    if (!wanted.has(luxonWeekdayToSundayFirst(candidateDay.weekday))) continue;
    const candidate = localTimeOnDay(candidateDay, time, timezone);
    if (candidate.toMillis() > after.getTime()) return candidate.toJSDate();
  }
  throw new Error('Unable to calculate next weekly reminder time.');
}

function localTimeOnDay(day: DateTime, time: string, timezone: string): DateTime {
  return timeOnLocalDay(day, time, timezone, 'reminder time');
}

function luxonWeekdayToSundayFirst(weekday: number): number {
  return weekday === 7 ? 0 : weekday;
}

function assertValidTime(time: string): void {
  parseTimeOfDay(time);
}

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}
