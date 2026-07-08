import {
  Bell,
  CornerDownRight,
  Lightbulb,
  MessageSquareQuote,
  MessageSquareReply,
  SmilePlus,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { renderMrkdwn } from '@/lib/mrkdwn';
import { emojiGlyph } from '@/lib/emoji';
import { clockHM, dateLabel, dateTimeFull } from '@/lib/format';
import { AttachedFiles, UploadedFile } from '../activity/Attachments';
import type { ActivityFeedItem, SurfaceChip } from '@/lib/activity-feed';
import type { SlackMessagePreview } from '@shared/inbox';
import type { AgentMessageRecord } from '@shared/messages';
import type { SlackFile } from '@/types';

// ---------------------------------------------------------------------------
// Shared Slack-style conversation renderer
//
// Extracted from the Channels tab (#317) so the Activity tab can reuse the
// exact same Slack-style rendering for its conversation layer (iris-approved
// layered sourcing `1782412048`). The rule: read the conversation like Slack,
// not like the retired audit register. Messages sit left-aligned with an
// author avatar + name + time; consecutive same-author messages collapse under
// one byline; day dividers separate the stream. Read-only (no composer).
//
// Two axes share this renderer:
//   • Channels — single channel, no surface chip. `resolveAuthor` is
//     channel-scoped (DM avatar from the channel).
//   • Activity — cross-channel timeline. `resolveAuthor` is injected and a
//     `resolveSurface` adds a per-group surface chip + breaks groups when the
//     channel changes (so two channels never collapse into one byline).
//
// Both consume the shared `ActivityFeedItem` normalization so the
// in→file / out→file mapping stays in one tested place; this layer is
// presentation only.
// ---------------------------------------------------------------------------

export const GROUP_GAP_MS = 5 * 60 * 1000; // start a fresh author block after a 5-min lull

export interface Author {
  key: string; // groups consecutive messages
  name: string;
  avatarUrl?: string;
  initial: string;
  isAgent: boolean;
}

export function initialOf(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
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

function inboundPreviews(message: AgentMessageRecord): SlackMessagePreview[] {
  if (!isPersonMessage(message) || message.platform === 'feishu') return [];
  return (message.previews ?? []).filter(
    (preview) => preview.platform === 'slack' && preview.type === 'message_unfurl',
  );
}

export function MsgAvatar({ author }: { author: Author }) {
  if (author.avatarUrl) {
    return (
      <img
        src={author.avatarUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-md object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <span
      className={[
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[13px] font-semibold',
        author.isAgent ? 'bg-accent/15 text-accent' : 'bg-surface-raised text-text-muted',
      ].join(' ')}
      aria-hidden
    >
      {author.initial}
    </span>
  );
}

// One message's content (text + files), avatar/byline handled by the group.
export function MessageBody({ item, agentId }: { item: ActivityFeedItem; agentId: string }) {
  if (item.kind === 'message-in') {
    const text = inboundText(item.message).trim();
    const files = inboundFiles(item.message);
    const previews = inboundPreviews(item.message);
    return (
      <>
        {text && (
          <div className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-text">
            {renderMrkdwn(text)}
          </div>
        )}
        {files.length > 0 && <AttachedFiles files={files} agentId={agentId} />}
        {previews.length > 0 && <SlackPreviewCards previews={previews} />}
      </>
    );
  }
  if (item.kind === 'message-out') {
    const text = item.text.trim();
    if (!text)
      return <span className="font-serif text-[13px] italic text-text-subtle">(empty message)</span>;
    return (
      <div className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-text">
        {renderMrkdwn(text)}
      </div>
    );
  }
  if (item.kind === 'file-out') {
    const caption = item.caption.trim();
    return (
      <>
        {caption && (
          <div className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-text">
            {renderMrkdwn(caption)}
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-2">
          {item.files.map((file) => (
            <UploadedFile key={file.fileId} file={file} agentId={agentId} />
          ))}
        </div>
      </>
    );
  }
  if (item.kind !== 'reaction-out') return null;
  // reaction-out: a lightweight signal, not a full message.
  const verb = item.action === 'removed' ? 'removed reaction' : 'reacted';
  // Render the actual Unicode glyph (what Slack shows) when we have a mapping;
  // workspace-custom emoji have no Unicode equivalent → keep the `:name:` mono
  // chip so the reaction still reads. Mirrors ReactOutRow.
  const glyph = item.emoji ? emojiGlyph(item.emoji) : undefined;
  return (
    <span className="inline-flex items-center gap-1.5 font-sans text-[13px] text-text-muted">
      <SmilePlus className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
      {verb}
      {item.emoji &&
        (glyph ? (
          <span className="text-[15px] leading-none" title={`:${item.emoji}:`} aria-label={item.emoji}>
            {glyph}
          </span>
        ) : (
          <code className="rounded-sm bg-surface-raised px-1 py-0.5 text-[12px] text-text-muted">
            :{item.emoji}:
          </code>
        ))}
    </span>
  );
}

function SlackPreviewCards({ previews }: { previews: SlackMessagePreview[] }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {previews.map((preview, index) => (
        <SlackPreviewCard key={`${preview.fromUrl ?? preview.channelId ?? 'preview'}:${preview.messageTs ?? index}`} preview={preview} />
      ))}
    </div>
  );
}

function SlackPreviewCard({ preview }: { preview: SlackMessagePreview }) {
  const author = preview.authorName || preview.authorSubname || preview.authorId || 'Slack message';
  const meta = [
    author,
    preview.channelId,
    preview.isPrivate ? 'private preview' : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className="max-w-full rounded-md border border-border-soft bg-surface-raised/65 px-3 py-2">
      <div className="mb-1 flex min-w-0 items-center gap-1.5 font-sans text-[11px] text-text-subtle">
        <MessageSquareQuote className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-semibold uppercase tracking-[0.08em]">Slack preview</span>
        {meta && <span className="min-w-0 truncate">· {meta}</span>}
        {preview.fromUrl && (
          <a
            className="ml-auto shrink-0 text-[10px] text-text-subtle underline-offset-2 hover:text-accent hover:underline"
            href={preview.fromUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open
          </a>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-text-muted">
        {renderMrkdwn(preview.text)}
      </div>
    </div>
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

// The date chip on its own. Shared so the Activity tab's sticky/floating day
// header can render just the pill (no flanking rules): when the header is
// pinned and floating over scrolling content, the two hairline rules read as a
// divider cutting across the content. A lone centered pill (Slack-style) stays
// clean both pinned and at rest.
export function DayLabelPill({ iso }: { iso: string }) {
  return (
    <span className="chrome rounded-full border border-border-soft bg-surface px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-text-subtle">
      {dateLabel(iso)}
    </span>
  );
}

export function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-border-soft" />
      <DayLabelPill iso={iso} />
      <span className="h-px flex-1 bg-border-soft" />
    </div>
  );
}

// Small muted surface chip for the cross-channel byline (Activity axis). The
// label already carries its kind marker (`#prod` / `@handle`), so no icon.
//
// When the chip maps to a real Slack conversation (`channelId` present), it
// becomes a link to that channel in the Channels tab, so a user reading the
// cross-channel Activity timeline can jump straight to a surface for detail.
// The chip is the affordance (iris-locked): pointer + hover underline/accent so
// it reads as clickable, focusable with an aria-label naming the destination.
// Rows with no resolvable channel (reminder / onboarding / unknown) render the
// plain non-interactive chip, so we never link to nowhere. This chip only
// renders in Activity (Channels passes no surface resolver), so the link is
// inherently active-only there.
const SURFACE_CHIP_BASE =
  'shrink-0 truncate rounded-sm bg-surface-raised px-1.5 py-px font-sans text-[10px] text-text-subtle';

function GroupSurfaceChip({ chip, agentId }: { chip: SurfaceChip; agentId: string }) {
  if (!chip.channelId || !agentId) {
    return <span className={SURFACE_CHIP_BASE}>{chip.label}</span>;
  }
  return (
    <Link
      to={`/agents/${agentId}/channels?c=${encodeURIComponent(chip.channelId)}`}
      aria-label={`Open ${chip.label} in the Channels tab`}
      className={`${SURFACE_CHIP_BASE} cursor-pointer underline-offset-2 transition-colors hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
    >
      {chip.label}
    </Link>
  );
}

// System-originated wake (reminder / onboarding): a centered, avatar-less line
// so it reads as a timeline annotation, not a message someone sent. The type
// icon + small-caps label name the event class; the muted body carries the
// detail (reminder title / onboarding note). Short hairlines flank the pill on
// wider viewports to echo the Slack centered-system-notice convention; they
// drop on narrow widths so the pill never gets crushed.
const SYSTEM_EVENT_ICON: Record<'reminder' | 'onboarding' | 'attention', LucideIcon> = {
  attention: Lightbulb,
  reminder: Bell,
  onboarding: UserPlus,
};

export function SystemEventRow({
  item,
}: {
  item: Extract<ActivityFeedItem, { kind: 'system-event' }>;
}) {
  const Icon = SYSTEM_EVENT_ICON[item.eventKind];
  return (
    <div className="flex items-center justify-center gap-2.5 px-1 py-1.5">
      <span aria-hidden className="hidden h-px w-8 shrink-0 bg-border-soft sm:block" />
      <span className="inline-flex max-w-[85%] items-center gap-1.5 rounded-full border border-border-soft bg-surface-raised px-2.5 py-0.5">
        <Icon className="h-3 w-3 shrink-0 text-text-subtle" aria-hidden />
        <span className="shrink-0 font-sans text-[9.5px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
          {item.label}
        </span>
        <span className="truncate font-sans text-[12px] text-text-muted">{item.body}</span>
        {item.meta && (
          <span className="min-w-0 truncate font-sans text-[10px] text-text-subtle">· {item.meta}</span>
        )}
        <span
          className="shrink-0 cursor-default font-sans text-[10px] text-text-subtle"
          title={dateTimeFull(item.timestamp)}
        >
          {clockHM(item.timestamp)}
        </span>
      </span>
      <span aria-hidden className="hidden h-px w-8 shrink-0 bg-border-soft sm:block" />
    </div>
  );
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

function threadMetaOf(item: ActivityFeedItem): { messageTs?: string; threadTs?: string } {
  if (item.kind === 'message-in') {
    return { messageTs: item.message.messageTs, threadTs: item.message.threadTs };
  }
  if (item.kind === 'message-out' || item.kind === 'file-out' || item.kind === 'reaction-out') {
    return { messageTs: item.messageTs, threadTs: item.threadTs };
  }
  return {};
}

// A reply is a message whose threadTs points at a *different* message (the
// parent). A thread parent carries threadTs absent or === its own messageTs.
function isReplyMeta(meta: { messageTs?: string; threadTs?: string }): boolean {
  return !!meta.threadTs && meta.threadTs !== meta.messageTs;
}

export function threadDomId(messageTs: string): string {
  return `chan-msg-${messageTs}`;
}

function flashThreadTarget(threadTs: string) {
  const el = document.getElementById(threadDomId(threadTs));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Soft arrival flash: the wrapper has transition-colors, so adding then
  // removing a faint accent wash fades in and out gently.
  el.classList.add('bg-accent/10');
  window.setTimeout(() => el.classList.remove('bg-accent/10'), 1200);
}

// The clickable back-reference on a reply. Degrades to plain, non-interactive
// muted text when the parent is outside the loaded window (never a dead click,
// and never *looks* clickable).
function ThreadBackRef({ threadTs, parent }: { threadTs: string; parent?: ThreadParentInfo }) {
  if (!parent) {
    return (
      <div className="flex items-center gap-1 font-sans text-[11px] text-text-subtle">
        <CornerDownRight className="h-3 w-3 shrink-0 text-text-subtle/60" aria-hidden />
        <span>reply in thread</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => flashThreadTarget(threadTs)}
      aria-label={`Jump to the message this replies to, by ${parent.author}`}
      className="group/threadref flex min-w-0 items-center gap-1 self-start rounded-sm font-sans text-[11px] text-text-subtle transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <CornerDownRight
        className="h-3 w-3 shrink-0 text-text-subtle/60 transition-colors group-hover/threadref:text-accent"
        aria-hidden
      />
      <span className="min-w-0 truncate">
        re: <span className="font-medium text-text-muted">{parent.author}</span>
        {parent.snippet && <span> · “{parent.snippet}”</span>}
      </span>
    </button>
  );
}

// Quiet forward-scent on a thread-starter: announces threads exist at all.
function ReplyCountBadge({ count, exact }: { count: number; exact: boolean }) {
  const noun = exact && count === 1 ? 'reply' : 'replies';
  return (
    <span className="inline-flex items-center gap-1 self-start font-sans text-[11px] text-text-subtle">
      <MessageSquareReply className="h-3 w-3 shrink-0 text-text-subtle/60" aria-hidden />
      {exact ? count : `${count}+`} {noun}
    </span>
  );
}

export function MessageGroupRow({
  group,
  agentId,
  threadContext,
}: {
  group: MessageGroup;
  agentId: string;
  threadContext?: ThreadContext;
}) {
  return (
    <div className="flex gap-2.5 px-1 py-1.5">
      <MsgAvatar author={group.author} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-sans text-[13px] font-semibold text-text">
            {group.author.name}
          </span>
          <span
            className="shrink-0 cursor-default font-sans text-[11px] text-text-subtle"
            title={dateTimeFull(group.startTs)}
          >
            {clockHM(group.startTs)}
          </span>
          {group.surface && <GroupSurfaceChip chip={group.surface} agentId={agentId} />}
        </div>
        <div className="mt-0.5 flex flex-col gap-1">
          {group.items.map(({ item, key }) => {
            // Thread decoration (Channels only). meta is empty for Activity (no
            // context) and for system rows, so both fall through untouched.
            const meta = threadContext ? threadMetaOf(item) : {};
            const reply = isReplyMeta(meta);
            const parent =
              reply && meta.threadTs ? threadContext!.parentByTs.get(meta.threadTs) : undefined;
            const replyCount =
              threadContext && meta.messageTs
                ? threadContext.replyCountByTs.get(meta.messageTs) ?? 0
                : 0;
            // Wrap each message in a title-bearing div so hovering any row (not
            // just the group's header time) surfaces its own full date + time.
            // The inner flex-col gap-1 mirrors the prior layout: MessageBody's
            // fragment parts stay gap-1 siblings. A reply gets a shallow muted
            // left rule + the back-ref; a thread-starter gets the reply badge.
            return (
              <div
                key={key}
                {...(threadContext && meta.messageTs ? { id: threadDomId(meta.messageTs) } : {})}
                title={dateTimeFull(item.timestamp)}
                className={[
                  'flex flex-col gap-1',
                  // Thread-only classes: `rounded-sm transition-colors duration-500`
                  // exist solely for the Channels flash target, so gate them behind
                  // threadContext. With no context the class string is exactly the
                  // prior `flex flex-col gap-1` — Activity stays literally identical.
                  threadContext ? 'rounded-sm transition-colors duration-500' : '',
                  reply ? 'border-l-2 border-border-soft/70 pl-2.5' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {reply && meta.threadTs && (
                  <ThreadBackRef threadTs={meta.threadTs} parent={parent} />
                )}
                <MessageBody item={item} agentId={agentId} />
                {replyCount > 0 && (
                  <ReplyCountBadge count={replyCount} exact={threadContext!.countsExact} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
