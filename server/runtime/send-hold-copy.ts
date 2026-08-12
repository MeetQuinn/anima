// Final HELD + truncation copy (Iris, PRD b7efec1 / building/send-hold-and-cursor-view.md).
// Embed verbatim. English is the live emit language; ZH is stored for future locale.

import type { ObservedConversationEntry } from '../storage/schema/observed-conversation.store.js';
import { slackDisplayLabel } from '../slack/slack.helper.js';

/** Noun in the HELD outcome: message send / ask → "message"; file send → "file". */
export type HeldNoun = 'message' | 'file';

/** Soft per-row budget for HELD delta lines (shared spirit with cursor view). */
export const HELD_MAX_MESSAGE_CHARS = 2_000;

/** UTF-8 safe clip (no surrogate split). Local copy to avoid cycle with cursor-delivery. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  const ellipsisBytes = Buffer.byteLength(ellipsis, 'utf8');
  if (maxBytes < ellipsisBytes) return '';
  const budget = maxBytes - ellipsisBytes;
  let result = '';
  for (const ch of text) {
    const next = result + ch;
    if (Buffer.byteLength(next, 'utf8') > budget) break;
    result = next;
  }
  return result ? `${result}${ellipsis}` : '';
}

/**
 * Exact-count truncation marker (EN). Shared by HELD delta and wake-time cursor view.
 * PRD: `(+{N} earlier messages not shown)`
 */
export function exactEarlierMessagesMarker(count: number): string {
  if (count <= 0) return '';
  return `(+${count} earlier message${count === 1 ? '' : 's'} not shown)`;
}

/** Unknown-count truncation marker (EN). PRD: `(earlier messages not shown)` */
export function unknownEarlierMessagesMarker(): string {
  return '(earlier messages not shown)';
}

/**
 * Per-message clip suffix when a row exceeds its byte share.
 * PRD: append `… [truncated]` (ellipsis already applied by truncateUtf8).
 */
export function truncatedMarkerSuffix(): string {
  return ' [truncated]';
}

/** Clip row text and append Iris's truncation marker when clipped. */
export function clipHeldRowText(text: string, maxChars = HELD_MAX_MESSAGE_CHARS): string {
  if (Buffer.byteLength(text, 'utf8') <= maxChars) return text;
  // Leave room for " [truncated]" after the ellipsis clip.
  const suffix = truncatedMarkerSuffix();
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const bodyBudget = Math.max(1, maxChars - suffixBytes);
  return `${truncateUtf8(text, bodyBudget)}${suffix}`;
}

function heldSenderLabel(entry: ObservedConversationEntry): string {
  if (entry.userId) return slackDisplayLabel({ userId: entry.userId });
  if (entry.botId) return `bot:${entry.botId}`;
  return 'unknown';
}

/** Clock time from receivedAt/messageTs for HELD lines (`13:44:59`). */
export function heldTimeLabel(entry: ObservedConversationEntry): string {
  const iso = entry.receivedAt || undefined;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(11, 19); // HH:MM:SS Z
    }
  }
  // Slack ts "1234567890.123456" → best-effort local-ish display from epoch.
  const sec = Number(entry.messageTs.split('.')[0]);
  if (Number.isFinite(sec) && sec > 0) {
    return new Date(sec * 1000).toISOString().slice(11, 19);
  }
  return entry.messageTs;
}

export function formatHeldDeltaLine(entry: ObservedConversationEntry): string {
  let text = entry.text;
  if (!text && entry.files?.length) {
    text = entry.files.map((f) => f.name ?? f.id).join(', ');
    text = text ? `[file: ${text}]` : '[file]';
  }
  text = clipHeldRowText(text || '');
  return `  [${heldSenderLabel(entry)} ${heldTimeLabel(entry)}] ${text}`;
}

/**
 * HELD outcome (EN) — sole stdout when a send is held.
 * Iris template (PRD):
 *
 * HELD: the conversation moved while you were composing. {N} new message(s) arrived,
 * so your {message|file} was not sent:
 *   [{sender} {time}] {text}
 * Read them, then resend to post it (revised or unchanged). To stay silent, do nothing.
 */
export function renderHeldCopy(input: {
  /** Full after-cursor non-own population (exact N). */
  totalNewCount: number;
  /** Newest-fitting rows included in the body (chronological). */
  shown: ObservedConversationEntry[];
  noun: HeldNoun;
}): string {
  const n = input.totalNewCount;
  const arrived = n === 1 ? '1 new message arrived' : `${n} new messages arrived`;
  const lines: string[] = [
    `HELD: the conversation moved while you were composing. ${arrived}, so your ${input.noun} was not sent:`,
  ];
  for (const entry of input.shown) {
    lines.push(formatHeldDeltaLine(entry));
  }
  const omitted = Math.max(0, n - input.shown.length);
  if (omitted > 0) {
    lines.push(`  ${exactEarlierMessagesMarker(omitted)}`);
  }
  lines.push(
    'Read them, then resend to post it (revised or unchanged). To stay silent, do nothing.',
  );
  return lines.join('\n');
}

/**
 * Approved ZH variant (not emitted until locale support lands). Kept next to EN
 * so the pair cannot drift.
 */
export function renderHeldCopyZh(input: {
  totalNewCount: number;
  shown: ObservedConversationEntry[];
  noun: HeldNoun;
}): string {
  const n = input.totalNewCount;
  const nounZh = input.noun === 'file' ? '文件' : '消息';
  const lines: string[] = [
    `HELD:你组稿期间会话有 ${n} 条新消息,这条${nounZh}没有发出:`,
  ];
  for (const entry of input.shown) {
    lines.push(formatHeldDeltaLine(entry));
  }
  const omitted = Math.max(0, n - input.shown.length);
  if (omitted > 0) {
    lines.push(`  (另有 ${omitted} 条更早消息未显示)`);
  }
  lines.push('看完这些消息后,重发即可发出(改不改由你);不想发就什么都不做。');
  return lines.join('\n');
}
