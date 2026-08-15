import {
  CornerDownRight,
  MessageSquareQuote,
  MessageSquareReply,
  SmilePlus,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { renderMrkdwn } from '@/lib/mrkdwn';
import { emojiGlyph } from '@/lib/emoji';
import { clockHM, dateTimeFull } from '@/lib/format';
import {
  inboundFiles,
  inboundPreviews,
  inboundText,
  isReplyMeta,
  threadDomId,
  threadMetaOf,
  type Author,
  type MessageGroup,
  type ThreadContext,
  type ThreadParentInfo,
} from '@/lib/message-model';
import { AttachedFiles, UploadedFile } from '../activity/Attachments';
import type { ActivityFeedItem, SurfaceChip } from '@/lib/activity-feed';
import type { SlackMessagePreview } from '@shared/inbox';

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
// The presentation-free data model (message classification, author readers,
// author grouping, thread meta) lives in `@/lib/message-model`; the shared
// timeline chrome (day dividers, system-event pill) in
// `@/components/TimelineRows`. This file is the message rendering only.
// ---------------------------------------------------------------------------

function MsgAvatar({ author }: { author: Author }) {
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
function MessageBody({ item, agentId }: { item: ActivityFeedItem; agentId: string }) {
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
