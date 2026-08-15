import type { ActivityFeedItem, SurfaceChip } from '@/lib/activity-feed';
import type { SlackMessagePreview } from '@shared/inbox';
import type { AgentMessageRecord } from '@shared/messages';
import type { SlackFile } from '@/types';

// ---------------------------------------------------------------------------
// Conversation data model — extracted from views/agents/conversation/
// SlackTimeline.tsx so pure lib helpers (activity-timeline, activity-authors,
// channel-threads) stop importing from a view. The Slack-style *rendering*
// stays in SlackTimeline.tsx; this module is the presentation-free layer:
// which feed items are messages, who authored them, how consecutive messages
// group into author blocks, and how thread replies relate to their parents.
// ---------------------------------------------------------------------------

const GROUP_GAP_MS = 5 * 60 * 1000; // start a fresh author block after a 5-min lull

export interface Author {
  key: string; // groups consecutive messages
  name: string;
  avatarUrl?: string;
  initial: string;
  isAgent: boolean;
}

export function isMessageItem(item: ActivityFeedItem): boolean {
  return (
    item.kind === 'message-in' ||
    item.kind === 'message-out' ||
    item.kind === 'file-out' ||
    item.kind === 'reaction-out'
  );
}

// A person's inbound message (slack/feishu), as opposed to a system wake or a
// choice response. Author/file/preview readers key off this split.
function isPersonMessage(message: AgentMessageRecord): boolean {
  return (
    message.kind === 'message' || message.kind === 'file' || message.kind === 'reaction'
  );
}

// Inbound author byline (Slack only in v1; other kinds degrade to a label).
export function inboundAuthorName(message: AgentMessageRecord): string {
  if (message.kind === 'choice_response') {
    return (
      message.actorHandle?.replace(/^@/, '') || message.actorDisplayName || 'Choice response'
    );
  }
  if (message.kind === 'reminder') return message.reminderTitle?.trim() || 'Reminder';
  if (message.kind === 'onboarding') return 'Onboarding';
  if (message.platform === 'feishu') {
    return message.actorDisplayName || message.actorUserId || 'Feishu user';
  }
  return (
    message.actorDisplayName ||
    message.actorHandle?.replace(/^@/, '') ||
    message.actorUserId ||
    'Unknown user'
  );
}

// Inbound sender's Slack user id — the author-grouping key. Undefined for
// non-Slack sources (feishu / system wakes / choice responses) and when the
// id is unknown, so callers fall back to the display name.
export function inboundSlackUserId(message: AgentMessageRecord): string | undefined {
  if (!isPersonMessage(message) || message.platform === 'feishu') return undefined;
  return message.actorUserId || undefined;
}

export function inboundText(message: AgentMessageRecord): string {
  if (message.kind === 'reminder') return '';
  if (message.kind === 'choice_response')
    return `Selected: ${message.optionLabel ?? message.text}`;
  return message.text ?? '';
}

export function inboundFiles(message: AgentMessageRecord): SlackFile[] {
  if (!isPersonMessage(message)) return [];
  return (message.files ?? []).map((file, index) => ({
    id: file.fileId ?? `${message.messageId}:file:${index}`,
    mimetype: file.mimetype ?? 'application/octet-stream',
    name: file.filename,
    sizeBytes: file.sizeBytes ?? 0,
  }));
}

export function inboundPreviews(message: AgentMessageRecord): SlackMessagePreview[] {
  if (!isPersonMessage(message) || message.platform === 'feishu') return [];
  return (message.previews ?? []).filter(
    (preview) => preview.platform === 'slack' && preview.type === 'message_unfurl',
  );
}

// A run of consecutive messages from one author (in one surface): avatar +
// byline once, bodies stacked beneath (the Slack grouping rhythm).
export interface MessageGroup {
  author: Author;
  surfaceKey: string; // groups break when this changes (cross-channel axis)
  surface?: SurfaceChip; // optional per-group chip (Activity cross-channel axis)
  startTs: string;
  items: { item: ActivityFeedItem; key: string }[];
}

// Resolve the author byline for an item. Channels passes a channel-scoped
// closure; Activity passes a cross-channel resolver.
export type AuthorResolver = (item: ActivityFeedItem) => Author;

// Resolve a surface key (+ optional chip) for an item. Returning a stable key
// for every item (e.g. the single channel id) means groups never break on
// surface; returning per-item keys (the channel/thread/dm) breaks groups when
// the conversation jumps channels. Omit entirely for the single-channel axis.
export type SurfaceResolver = (item: ActivityFeedItem) => { key: string; chip?: SurfaceChip };

export function groupByAuthor(
  items: ActivityFeedItem[],
  resolveAuthor: AuthorResolver,
  resolveSurface?: SurfaceResolver,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const author = resolveAuthor(item);
    const surface = resolveSurface?.(item);
    const surfaceKey = surface?.key ?? '';
    const tsMs = Date.parse(item.timestamp);
    const last = groups[groups.length - 1];
    const lastMs = last ? Date.parse(last.startTs) : 0;
    const continues =
      last &&
      last.author.key === author.key &&
      last.surfaceKey === surfaceKey &&
      Number.isFinite(tsMs) &&
      tsMs - Date.parse(last.items[last.items.length - 1]!.item.timestamp) <= GROUP_GAP_MS &&
      Number.isFinite(lastMs);
    if (continues) {
      last!.items.push({ item, key: `${i}` });
    } else {
      groups.push({
        author,
        surfaceKey,
        ...(surface?.chip ? { surface: surface.chip } : {}),
        startTs: item.timestamp,
        items: [{ item, key: `${i}` }],
      });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Thread legibility (Channels axis only)
//
// The Channels detail is a calm flat chronological log, so a reply can render
// far below its parent. `threadContext` lets a reply show a back-reference to
// its parent ("↳ re: <author> · snippet", click-to-scroll) and a thread-starter
// show a quiet "N replies" scent — just enough legibility to answer "is this a
// reply, and to what?" without turning the surface into a threaded UI. Activity
// passes NO context, so its rendering is byte-identical (no decoration reads).
// ---------------------------------------------------------------------------

export interface ThreadParentInfo {
  author: string;
  snippet: string; // '' for a text-less (file/system) parent → render author-only
}

export interface ThreadContext {
  // parent messageTs → author + snippet, for a reply's back-reference.
  parentByTs: Map<string, ThreadParentInfo>;
  // thread-starter messageTs → count of loaded replies (only entries with > 0).
  replyCountByTs: Map<string, number>;
  // Whether the reply counts are exact. Under contiguous newest-first paging a
  // visible parent's replies (always newer than the parent) are necessarily
  // within the loaded window, so the count is exact. If a future paging model
  // breaks contiguity, set this false and the badge renders "N+" (never lets an
  // approximate count read as authoritative).
  countsExact: boolean;
}

export function threadMetaOf(item: ActivityFeedItem): { messageTs?: string; threadTs?: string } {
  if (item.kind === 'message-in') {
    return { messageTs: item.message.messageTs, threadTs: item.message.threadTs };
  }
  if (item.kind === 'message-out' || item.kind === 'file-out') {
    return { messageTs: item.messageTs, threadTs: item.threadTs };
  }
  // reaction-out carries the *target* message's ts as messageTs. A reaction is
  // never a thread parent or reply, so it must yield no thread metadata -
  // otherwise it would claim a duplicate DOM id at the target ts and could
  // hijack a degraded back-ref (pointing at "Reaction added…" instead of the
  // real parent). Fall through to no metadata.
  return {};
}

// A reply is a message whose threadTs points at a *different* message (the
// parent). A thread parent carries threadTs absent or === its own messageTs.
export function isReplyMeta(meta: { messageTs?: string; threadTs?: string }): boolean {
  return !!meta.threadTs && meta.threadTs !== meta.messageTs;
}

export function threadDomId(messageTs: string): string {
  return `chan-msg-${messageTs}`;
}
