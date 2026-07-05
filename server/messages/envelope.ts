import { DateTime } from 'luxon';

/**
 * Shared renderer for the bracket-envelope grammar used across agent-facing
 * text surfaces: delivery prompts (`server/runtime/delivery-prompt.ts`),
 * `anima message read` transcripts, and the history/inbox/outbox CLI.
 *
 * Grammar: `[key=value key=value ...]` — fields space-joined in caller order
 * (order is part of the surface contract), absent fields omitted entirely
 * (never rendered empty), values raw unless explicitly quoted.
 *
 * This module owns the HOW (joining, omission, quoting, time trimming).
 * Each surface keeps its own WHAT: which fields, in which order, at which
 * time granularity. Envelope semantics are frozen; tests pin the bytes.
 */
export interface EnvelopeField {
  key: string;
  /** `undefined`, `null`, and `''` all mean "omit this field". */
  value: string | number | boolean | undefined | null;
  /** Quote the value with {@link quoteEnvelopeValue} (e.g. feishu `chat_name`). */
  quoted?: boolean;
}

export function renderEnvelope(fields: EnvelopeField[]): string {
  const rendered = fields
    .filter((field) => field.value !== undefined && field.value !== null && field.value !== '')
    .map((field) => `${field.key}=${field.quoted ? quoteEnvelopeValue(String(field.value)) : String(field.value)}`);
  return `[${rendered.join(' ')}]`;
}

/** The one quoting rule for envelope values: backslash-escape `\` and `"`, wrap in quotes. */
export function quoteEnvelopeValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Delivery-envelope timestamps render at second granularity; sub-second
 * precision is noise for reading context (message_ts carries exact identity).
 * Transcript and history surfaces deliberately keep raw ISO timestamps.
 */
export function envelopeTime(timestamp: string): string {
  return timestamp.replace(/\.\d{3}(?=Z$|[+-]\d{2}:\d{2}$)/, '');
}

/**
 * Renders an instant in the user's local time as `YYYY-MM-DDTHH:mm:ss±HH:MM`.
 * Zone-based (DST-correct at the instant); falls back to a fixed offset when
 * the zone name is unusable, then to the raw timestamp.
 */
export function formatUserLocalTime(
  timestamp: string,
  timezone: { name: string; offsetSeconds?: number },
): string {
  const zoned = DateTime.fromISO(timestamp, { zone: timezone.name });
  if (zoned.isValid) return zoned.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
  if (typeof timezone.offsetSeconds === 'number') {
    const fixed = DateTime.fromISO(timestamp).toUTC(Math.round(timezone.offsetSeconds / 60));
    if (fixed.isValid) return fixed.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
  }
  return timestamp;
}

/** Pagination footer shared by transcript and history surfaces. */
export function renderPageFooter(page: { hasMore: boolean; nextCursor?: string | null }): string {
  return `[page has_more=${String(page.hasMore)} next_cursor=${page.nextCursor || '-'}]`;
}
