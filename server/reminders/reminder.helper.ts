import type { DateTime } from 'luxon';

import type { Reminder, ReminderSchedule } from '../../shared/reminder.js';
import { parseTimeOfDay, timeOnLocalDay, zonedDateTime } from '../schedule/local-time.js';

export { systemTimezone } from '../schedule/local-time.js';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type Weekday = (typeof WEEKDAYS)[number];

const WINDOWED_LOOKAHEAD_DAYS = 21;
const MAX_SLOTS_PER_DAY = 10_000;

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

/**
 * Parse `--window mon-fri@08:00-18:30` (or explicit weekday lists).
 * v1 rejects overnight windows (end must be strictly after start on the same day).
 */
export function parseWindowRule(windowRule: string): {
  weekdays: Weekday[];
  windowEnd: string;
  windowStart: string;
} {
  const normalized = windowRule.trim().toLowerCase();
  const match = normalized.match(/^([a-z0-9,-]+)@(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (!match) {
    throw new Error(
      `Invalid window: ${windowRule}. Expected e.g. mon-fri@08:00-18:30 or mon,wed@09:00-17:00`,
    );
  }
  const weekdays = expandWeekdaySpec(match[1] ?? '');
  const windowStart = match[2] as string;
  const windowEnd = match[3] as string;
  assertValidTime(windowStart);
  assertValidTime(windowEnd);
  const [startH, startM] = parseTimeOfDay(windowStart);
  const [endH, endM] = parseTimeOfDay(windowEnd);
  if (endH * 60 + endM <= startH * 60 + startM) {
    throw new Error(
      `Invalid window: ${windowRule}. End must be after start on the same day (overnight windows are not supported).`,
    );
  }
  return { weekdays, windowEnd, windowStart };
}

export function buildWindowedIntervalSchedule(input: {
  repeatRule: string;
  timezone: string;
  windowRule: string;
}): Extract<ReminderSchedule, { kind: 'windowed_interval' }> {
  assertValidTimezone(input.timezone);
  const base = parseRepeatRule(input.repeatRule, input.timezone);
  if (base.kind !== 'interval') {
    throw new Error('--window is only allowed with every:<n><m|h|d> intervals');
  }
  const window = parseWindowRule(input.windowRule);
  const windowRule = input.windowRule.trim().toLowerCase();
  return {
    intervalMs: base.intervalMs,
    kind: 'windowed_interval',
    repeatRule: base.repeatRule,
    timezone: input.timezone,
    weekdays: window.weekdays,
    windowEnd: window.windowEnd,
    windowRule,
    windowStart: window.windowStart,
  };
}

export function nextDueAtForSchedule(
  schedule: ReminderSchedule,
  after: Date,
  intervalFallbackAnchor?: string,
): string {
  switch (schedule.kind) {
    case 'once':
      throw new Error('One-shot reminders do not have a repeat schedule.');
    case 'interval': {
      const anchorAt = schedule.phaseAnchorAt ?? intervalFallbackAnchor;
      if (!anchorAt) throw new Error('Interval reminder requires a phase anchor.');
      return nextIntervalDueAt(anchorAt, schedule.intervalMs, after);
    }
    case 'daily':
      return nextDailyDueAt(schedule.time, schedule.timezone, after).toISOString();
    case 'weekly':
      return nextWeeklyDueAt(schedule.weekdays as Weekday[], schedule.time, schedule.timezone, after).toISOString();
    case 'windowed_interval':
      return nextWindowedIntervalDueAt(schedule, after);
  }
}

/** Exported for tests — local wall-clock grid slots for one calendar day (inclusive). */
export function windowedSlotsOnLocalDay(
  schedule: Extract<ReminderSchedule, { kind: 'windowed_interval' }>,
  day: DateTime,
): DateTime[] {
  const start = timeOnLocalDay(day, schedule.windowStart, schedule.timezone, 'window start');
  const end = timeOnLocalDay(day, schedule.windowEnd, schedule.timezone, 'window end');
  const slots: DateTime[] = [];
  let cursor = start;
  while (cursor.toMillis() <= end.toMillis()) {
    slots.push(cursor);
    if (slots.length > MAX_SLOTS_PER_DAY) {
      throw new Error('Windowed interval produced too many slots in one day.');
    }
    cursor = advanceLocalByInterval(cursor, schedule.intervalMs);
  }
  return slots;
}

function nextWindowedIntervalDueAt(
  schedule: Extract<ReminderSchedule, { kind: 'windowed_interval' }>,
  after: Date,
): string {
  const afterMs = after.getTime();
  const current = zonedDateTime(after, schedule.timezone);
  const wanted = new Set(schedule.weekdays.map((day) => WEEKDAYS.indexOf(day as Weekday)));
  for (let offset = 0; offset <= WINDOWED_LOOKAHEAD_DAYS; offset += 1) {
    const day = current.plus({ days: offset });
    if (!wanted.has(luxonWeekdayToSundayFirst(day.weekday))) continue;
    for (const slot of windowedSlotsOnLocalDay(schedule, day)) {
      // Late fire: strictly after `after` — never replay missed grid ticks.
      if (slot.toMillis() > afterMs) {
        const iso = slot.toUTC().toISO();
        if (!iso) throw new Error('Unable to serialize windowed reminder due time.');
        return iso;
      }
    }
  }
  throw new Error('Unable to calculate next windowed interval reminder time.');
}

function advanceLocalByInterval(cursor: DateTime, intervalMs: number): DateTime {
  // Prefer whole-minute wall-clock steps so DST keeps local grid alignment.
  if (intervalMs % 60_000 === 0) {
    return cursor.plus({ minutes: intervalMs / 60_000 });
  }
  return cursor.plus({ milliseconds: intervalMs });
}

function nextIntervalDueAt(anchorAt: string, intervalMs: number, after: Date): string {
  const anchorMs = Date.parse(anchorAt);
  if (!Number.isFinite(anchorMs)) throw new Error(`Invalid interval phase anchor: ${anchorAt}`);
  const elapsed = after.getTime() - anchorMs;
  const intervals = Math.floor(elapsed / intervalMs) + 1;
  return new Date(anchorMs + Math.max(intervals, 0) * intervalMs).toISOString();
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
  if (input.schedule.kind === 'interval') {
    return new Date(input.now.getTime() + input.schedule.intervalMs).toISOString();
  }
  // windowed_interval / daily / weekly: first eligible grid after now
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

/** Human-facing schedule fragment for list/activity (includes window when present). */
export function scheduleDisplayRule(schedule: ReminderSchedule): string | undefined {
  switch (schedule.kind) {
    case 'once':
      return undefined;
    case 'interval':
    case 'daily':
    case 'weekly':
      return schedule.repeatRule;
    case 'windowed_interval':
      return `${schedule.repeatRule} window=${schedule.windowRule}`;
  }
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

function expandWeekdaySpec(spec: string): Weekday[] {
  const parts = spec.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`Invalid window weekdays: ${spec}`);
  const days: Weekday[] = [];
  for (const part of parts) {
    const range = part.match(/^([a-z]{3})-([a-z]{3})$/);
    if (range) {
      const start = range[1] as string;
      const end = range[2] as string;
      if (!isWeekday(start) || !isWeekday(end)) {
        throw new Error(`Invalid window weekdays: ${spec}`);
      }
      const startIdx = WEEKDAYS.indexOf(start);
      const endIdx = WEEKDAYS.indexOf(end);
      if (endIdx < startIdx) {
        throw new Error(`Invalid window weekdays: ${spec}. Ranges must not wrap (v1).`);
      }
      for (let i = startIdx; i <= endIdx; i += 1) {
        days.push(WEEKDAYS[i] as Weekday);
      }
      continue;
    }
    if (!isWeekday(part)) throw new Error(`Invalid window weekdays: ${spec}`);
    days.push(part);
  }
  // Dedupe preserving order
  const seen = new Set<string>();
  const unique: Weekday[] = [];
  for (const day of days) {
    if (seen.has(day)) continue;
    seen.add(day);
    unique.push(day);
  }
  return unique;
}

function assertValidTimezone(timezone: string): void {
  zonedDateTime(new Date(), timezone);
}

function assertValidTime(time: string): void {
  parseTimeOfDay(time);
}

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}
