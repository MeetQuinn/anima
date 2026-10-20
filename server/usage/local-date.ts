import { DateTime, Info, type Zone } from 'luxon';

// Luxon converts an instant to a zone's wall clock through an offset in
// minutes. For an offset with seconds (local mean time), that float math can
// drop a millisecond close to 1970. From 2^29 ms (about 6 days) either side,
// with offsets under a day, it cannot.
const EXACT_OFFSET_MATH_MS = 2 ** 29;

/**
 * Returns a reader for the calendar date of a stored time in `timezone`, the
 * date that `DateTime.fromISO(iso, { setZone: true }).setZone(timezone).toISODate()`
 * gives, without building two DateTimes per row.
 *
 * Stored times are UTC in `Date#toISOString` form. For those:
 * - in an IANA zone, the reader formats the date with Intl. Luxon's `setZone`
 *   reads the same ICU wall clock through a formatter of its own, then applies
 *   it as an offset, which gives back that wall date.
 * - in a fixed or system zone, the reader applies `zone.offset(ts)` with the
 *   expression Luxon's `tsToObj` uses.
 *
 * Any other string, a time within 2^29 ms of 1970, or a local year the reader
 * cannot write in four digits takes Luxon's path.
 */
export function localDateReader(timezone: string): (iso: string) => string | null {
  const zone = Info.normalizeZone(timezone);
  const viaLuxon = (iso: string) => DateTime.fromISO(iso, { setZone: true }).setZone(zone).toISODate();
  if (!zone.isValid) return viaLuxon;
  const dateOf = (zone.type === 'iana' ? intlDateOf(zone.name) : undefined) ?? offsetDateOf(zone);
  return (iso) => {
    const ts = Date.parse(iso);
    if (iso.length === 24 && Math.abs(ts) >= EXACT_OFFSET_MATH_MS && new Date(ts).toISOString() === iso) {
      const date = dateOf(ts);
      if (date.length === 10) return date;
    }
    return viaLuxon(iso);
  };
}

/**
 * Formats an instant's date in the zone as YYYY-MM-DD, or undefined when this
 * runtime's locale data does not give that shape.
 */
function intlDateOf(zoneName: string): ((ts: number) => string) | undefined {
  const format = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: zoneName,
    year: 'numeric',
  });
  const { calendar, numberingSystem } = format.resolvedOptions();
  const pattern = format.formatToParts(0).map((part) => (part.type === 'literal' ? part.value : part.type)).join('');
  if (calendar !== 'gregory' || numberingSystem !== 'latn' || pattern !== 'year-month-day') return undefined;
  // A year below 1000, or at or before 1 BC (which shows no era here), formats
  // shorter than 10 characters, so the reader takes Luxon's path for it. So
  // does a year above 9999.
  return (ts) => format.format(ts);
}

function offsetDateOf(zone: Zone): (ts: number) => string {
  return (ts) => {
    const local = new Date(ts + zone.offset(ts) * 60 * 1000);
    const text = Number.isFinite(local.getTime()) ? local.toISOString() : '';
    return text.length === 24 ? text.slice(0, 10) : '';
  };
}
