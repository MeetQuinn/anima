import { Bell, MessageSquareQuote, SmilePlus, UserPlus, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { renderMrkdwn } from '@/lib/mrkdwn';
import { emojiGlyph } from '@/lib/emoji';
import { clockHM, dateLabel, dateTimeFull } from '@/lib/format';
import { AttachedFiles, UploadedFile } from '../activity/Attachments';
import type { ActivityFeedItem, SurfaceChip } from '@/lib/activity-feed';
import type { InboxItem, SlackMessagePreview } from '@shared/inbox';
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

// Inbound author byline (Slack only in v1; other kinds degrade to a label).
export function inboundAuthorName(event: InboxItem): string {
  if (event.kind === 'slack') {
    return (
      event.actor?.displayName ||
      event.actor?.realName ||
      event.actor?.handle?.replace(/^@/, '') ||
      event.actor?.userId ||
      'Unknown user'
    );
  }
  if (event.kind === 'feishu') {
    return event.actor?.displayName || event.actor?.openId || event.actor?.userId || 'Feishu user';
  }
  if (event.kind === 'choice_response')
    return event.answeredBy.handle?.replace(/^@/, '') || event.answeredBy.displayName || 'Choice response';
  if (event.kind === 'reminder') return event.title?.trim() || 'Reminder';
  if (event.kind === 'memory_coherence') return 'Memory coherence';
  return 'Onboarding';
}

export function inboundText(event: InboxItem): string {
  if (event.kind === 'reminder' || event.kind === 'memory_coherence') return '';
  if (event.kind === 'choice_response') return `Selected: ${event.optionLabel}`;
  return ('text' in event ? event.text : '') ?? '';
}

export function inboundFiles(event: InboxItem): SlackFile[] {
  if (event.kind === 'slack' || event.kind === 'feishu') {
    return (event.files ?? []) as SlackFile[];
  }
  return [];
}

function inboundPreviews(event: InboxItem): SlackMessagePreview[] {
  return event.kind === 'slack' ? event.previews ?? [] : [];
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
    const text = inboundText(item.event).trim();
    const files = inboundFiles(item.event);
    const previews = inboundPreviews(item.event);
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
const SYSTEM_EVENT_ICON: Record<'reminder' | 'onboarding', LucideIcon> = {
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
          <span className="shrink-0 font-sans text-[10px] text-text-subtle">· {item.meta}</span>
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

export function MessageGroupRow({ group, agentId }: { group: MessageGroup; agentId: string }) {
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
          {group.items.map(({ item, key }) => (
            // Wrap each message in a title-bearing div so hovering any row (not
            // just the group's header time) surfaces its own full date + time.
            // The inner flex-col gap-1 mirrors the prior layout exactly: before,
            // MessageBody's fragment parts were direct gap-1 siblings of the
            // column; now they're gap-1 siblings inside the wrapper, so spacing
            // is unchanged.
            <div key={key} title={dateTimeFull(item.timestamp)} className="flex flex-col gap-1">
              <MessageBody item={item} agentId={agentId} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
