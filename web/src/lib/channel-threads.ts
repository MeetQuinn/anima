// Channels tab: thread-legibility context builder.
//
// From the loaded message records of a single channel, derive (a) a parent
// lookup so a reply can show a "↳ re: <author> · snippet" back-reference, and
// (b) a per-thread-starter reply count for the quiet "N replies" scent. Kept a
// pure function (no React) so it's unit-testable and the view stays thin.
//
// Exactness: the Channels detail pages newest-first and contiguous, so a
// *visible* parent's replies (always newer than the parent) are necessarily
// within the loaded window too. The counts are therefore exact for any rendered
// parent (`countsExact: true`). If a future paging model breaks contiguity, set
// this false and the badge renders "N+" instead of an authoritative count.

import {
  inboundAuthorName,
  inboundText,
  type ThreadContext,
  type ThreadParentInfo,
} from '@/views/agents/conversation/SlackTimeline';
import type { AgentMessageRecord } from '@shared/messages';

// Strip the inline/leading Markdown that would otherwise leak into a plain-text
// back-reference snippet (e.g. a message that opens with `**Release posture**`
// shouldn't render as `**Release posture`). Conservative: only emphasis, code,
// strikethrough markers, and leading block markers (heading/quote/list). Link
// text is kept, the URL dropped.
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/^\s*(?:[#>]+\s*|[-*+]\s+|\d+[.)]\s+)/, '') // leading heading/quote/list marker
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/(\*\*|__|~~|\*|_|`)/g, ''); // emphasis / code / strikethrough markers
}

// Collapse whitespace and clip a parent message to a short back-reference
// snippet (~40 chars). Returns '' for text-less parents (file/system) so the
// back-ref falls back to author-only rather than showing empty quotes.
export function threadSnippet(text: string): string {
  const t = stripInlineMarkdown(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 40 ? `${t.slice(0, 40).trimEnd()}…` : t;
}

export interface ChannelThreadInputs {
  // The agent's display name, for outbound (agent-authored) parents.
  agentName: string;
  // The channel kind ('dm' | 'channel' | …) and DM display name, mirroring the
  // view's `authorFor`: in a DM the inbound counterpart is the channel name.
  channelKind: string;
  channelName?: string;
}

export function buildChannelThreadContext(
  entries: AgentMessageRecord[],
  { agentName, channelKind, channelName }: ChannelThreadInputs,
): ThreadContext {
  const parentByTs = new Map<string, ThreadParentInfo>();
  const replyCountByTs = new Map<string, number>();
  for (const record of entries) {
    const ts = record.messageTs?.trim();
    if (ts) {
      const author =
        record.direction === 'out'
          ? agentName
          : channelKind === 'dm'
            ? channelName ?? inboundAuthorName(record)
            : inboundAuthorName(record);
      const rawText = record.direction === 'out' ? record.text : inboundText(record);
      parentByTs.set(ts, { author, snippet: threadSnippet(rawText ?? '') });
    }
    const parentTs = record.threadTs?.trim();
    if (parentTs && parentTs !== record.messageTs) {
      replyCountByTs.set(parentTs, (replyCountByTs.get(parentTs) ?? 0) + 1);
    }
  }
  return { parentByTs, replyCountByTs, countsExact: true };
}
