import { DateTime } from 'luxon';

// Shared local-time math for scheduled wake producers (reminders and the
// memory-coherence scheduler). Both need the same primitives: resolve the
// host timezone, parse an HH:MM time of day, and place that time on a
// specific local calendar day in a zone.

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function zonedDateTime(date: Date, timezone: string): DateTime {
  const result = DateTime.fromJSDate(date, { zone: timezone });
  if (!result.isValid) throw new Error(`Invalid timezone: ${timezone}`);
  return result;
}

export function parseTimeOfDay(time: string): [number, number] {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time: ${time}`);
  const hour = Number.parseInt(match[1] ?? '', 10);
  const minute = Number.parseInt(match[2] ?? '', 10);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time: ${time}`);
  return [hour, minute];
}

export function timeOnLocalDay(
  day: DateTime,
  time: string,
  timezone: string,
  label = 'time',
): DateTime {
  const [hour, minute] = parseTimeOfDay(time);
  const result = DateTime.fromObject(
    { day: day.day, hour, minute, month: day.month, year: day.year },
    { zone: timezone },
  );
  if (!result.isValid) {
    throw new Error(`Invalid ${label} ${time} in timezone ${timezone}: ${result.invalidReason ?? 'invalid'}`);
  }
  return result;
}
