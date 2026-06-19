import { ExternalLink } from 'lucide-react';
import { renderMrkdwn } from '@/lib/mrkdwn';
import { Row, SurfaceText, COLOR_INBOUND, COLOR_OUTBOUND, COLOR_REMINDER } from './Row';
import { AttachedFiles, UploadedFile } from './Attachments';
import { isOnboardingWake, type ActivityFeedItem } from '@/lib/activity-feed';
import type { ActivityMode } from '@/lib/activities';
import type { ChoiceResponseInboxItem, FeishuInboxItem, InboxItem, SlackInboxItem } from '@shared/inbox';
import type { SlackFile } from '@/types';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

// Build a jump-to-Slack URL for an inbound Slack message. Uses the canonical
// `app_redirect` deep-link; falls back to `permalink` when available (richer
// but not always present on older records).
function slackInboundLink(item: SlackInboxItem): string {
  if (item.permalink) return item.permalink;
  // message_ts is a Slack timestamp like "1779123456.789012".
  const ts = item.messageTs ?? '';
  return `https://slack.com/app_redirect?channel=${encodeURIComponent(item.channelId)}&message_ts=${encodeURIComponent(ts)}`;
}

// Build a jump-to-Slack URL for an outbound message using `permalink` from the
// activity payload. Only present when the backend recorded it (send-message
// completion payload). Degrades gracefully — returns undefined when absent.
function slackOutboundLink(payload: Record<string, unknown>): string | undefined {
  const permalink = payload['permalink'];
  return typeof permalink === 'string' && permalink ? permalink : undefined;
}

// Small external-link affordance rendered at the end of a row's title line.
// Always visible at low opacity (touch-friendly); lifts to full on hover.
function SlackLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Open in Slack"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex shrink-0 items-center self-center text-text-subtle opacity-30 transition-opacity hover:opacity-100 focus-visible:opacity-100"
    >
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function actorName(item: InboxItem): string {
  if (item.kind === 'slack') {
    const displayName = item.actor?.displayName || item.actor?.realName;
    const handle = item.actor?.handle?.replace(/^@/, '');
    if (displayName) return displayName;
    if (handle) return handle;
    return item.actor?.userId ?? 'Unknown user';
  }
  if (item.kind === 'feishu') {
    return item.actor?.displayName
      ?? item.actor?.openId
      ?? item.actor?.userId
      ?? item.actor?.unionId
      ?? 'Unknown Feishu user';
  }
  return 'Unknown user';
}

function inboxItemText(item: InboxItem): string {
  if (item.kind === 'reminder') return '';
  if (item.kind === 'onboarding' || item.kind === 'feishu_onboarding') return item.text;
  if (item.kind === 'choice_response') return `Selected: ${item.optionLabel}\nQuestion: ${item.question}`;
  return item.text ?? '';
}

function isSlackItem(item: InboxItem): item is SlackInboxItem {
  return item.kind === 'slack';
}

function reminderTitle(item: Extract<InboxItem, { kind: 'reminder' }>): string {
  return item.title?.trim() || 'Reminder';
}

function onboardingTitle(): string {
  return 'Onboarding';
}

function choiceResponseTitle(item: ChoiceResponseInboxItem): string {
  return item.answeredBy.handle?.replace(/^@/, '') || item.answeredBy.displayName || 'Choice response';
}

function inboundFiles(item: SlackInboxItem | FeishuInboxItem): SlackFile[] {
  return item.files ?? [];
}

function isFileBearingInboxItem(item: InboxItem): item is SlackInboxItem | FeishuInboxItem {
  return item.kind === 'slack' || item.kind === 'feishu';
}

// ---------------------------------------------------------------------------
// Inbound message row
// ---------------------------------------------------------------------------

export function MessageInRow({
  item,
  time,
  agentId,
  mode,
}: {
  item: Extract<ActivityFeedItem, { kind: 'message-in' }>;
  time: string;
  agentId: string;
  mode: ActivityMode;
}) {
  // For reminder wakes the byline is the reminder's own title — that's the
  // identifier the user wrote when scheduling, so it's the natural
  // "byline" for the wake row (parallel to a Slack sender's name being the
  // byline of an inbound message). Dot uses the aubergine reminder hue
  // (still inbound register, but the dot color separates scheduler-wakes
  // from person-messages at a glance). Discriminant check stays inline so
  // TS can narrow `item.event` through the ternary.
  const onboarding = isOnboardingWake(item.event);
  let name: string;
  if (onboarding) {
    name = onboardingTitle();
  } else if (item.event.kind === 'reminder') {
    name = reminderTitle(item.event);
  } else if (item.event.kind === 'choice_response') {
    name = choiceResponseTitle(item.event);
  } else {
    name = actorName(item.event);
  }
  const dotColor = item.event.kind === 'reminder' || onboarding ? COLOR_REMINDER : COLOR_INBOUND;
  const text = inboxItemText(item.event).trim();
  const files = isFileBearingInboxItem(item.event) ? inboundFiles(item.event) : [];
  const hasFiles = files.length > 0;
  // Follow-up treatment is mode-dependent (iris lock 1779210850.086949):
  //   • Conversation mode: hide entirely. Active-run append is Anima-internal
  //     lifecycle metadata; users reading the conversation register
  //     should see it as part of the conversation.
  //   • Audit mode: keep but demote to a subtle ↳ glyph in the byline area.
  //     The marker is audit metadata, not user-facing terminology.
  const showFollowupMarker = item.followupAppended && mode === 'audit';
  const slackLink = isSlackItem(item.event) ? slackInboundLink(item.event) : undefined;
  return (
    <Row
      time={time}
      dotColor={dotColor}
      title={
        showFollowupMarker ? (
          <span className="inline-flex items-baseline gap-1.5">
            <span
              aria-label="continued conversation"
              title="continued conversation"
              className="font-sans text-[12px] text-text-subtle"
            >
              ↳
            </span>
            <span>{name}</span>
          </span>
        ) : (
          name
        )
      }
      secondary={
        <span className="inline-flex items-center gap-2">
          <SurfaceText chip={item.surface} />
          {slackLink && <SlackLink href={slackLink} />}
        </span>
      }
      body={
        text || hasFiles ? (
          <div className="flex flex-col gap-2">
            {text && <span className="whitespace-pre-wrap break-words">{renderMrkdwn(text)}</span>}
            {hasFiles && <AttachedFiles files={files} agentId={agentId} />}
          </div>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Outbound message row
// ---------------------------------------------------------------------------

export function MessageOutRow({
  item,
  time,
}: {
  item: Extract<ActivityFeedItem, { kind: 'message-out' }>;
  time: string;
}) {
  const text = item.text.trim();
  // Outbound = the agent's voice. voice='outbound' draws the accent margin
  // pull-rule under the dot; body itself stays ink (selection chrome is a
  // different signal — see iris gut-check #1).
  //
  // Title carries threadedness as prose (Option A, iris-locked
  // 1779212784.593679): "Replied in thread" reads naturally on the
  // editorial register; chip stays clean as just `#prod` / `@user`.
  const threaded = item.surface.kind === 'thread';
  const isDm = item.surface.kind === 'dm';
  const verb = item.isEdit ? 'Edited' : 'Replied';
  // DM replies carry the recipient in the title so the line reads as a complete
  // sentence without the user having to look at the chip ("Replied to
  // Alice" vs bare "Replied" + "@alice" chip). Strip the leading @ if
  // surfaceChipForOutbound already included it (round-2 item 4).
  const title = threaded
    ? `${verb} in thread`
    : isDm && item.surface.label
      ? `${verb} to ${item.surface.label.replace(/^@/, '')}`
      : verb;
  const outLink = slackOutboundLink(item.activity.payload ?? {});
  return (
    <Row
      time={time}
      dotColor={COLOR_OUTBOUND}
      voice="outbound"
      title={title}
      secondary={
        <span className="inline-flex items-center gap-2">
          <SurfaceText chip={item.surface} />
          {outLink && <SlackLink href={outLink} />}
        </span>
      }
      body={
        text ? (
          <span className="whitespace-pre-wrap break-words">{renderMrkdwn(text)}</span>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Outbound file row
// ---------------------------------------------------------------------------

export function FileOutRow({
  item,
  time,
  agentId,
}: {
  item: Extract<ActivityFeedItem, { kind: 'file-out' }>;
  time: string;
  agentId: string;
}) {
  const caption = item.caption.trim();
  const noun = item.files.length === 1 ? 'file' : 'files';
  const threaded = item.surface.kind === 'thread';
  const isDm = item.surface.kind === 'dm';
  const base = `Sent ${item.files.length} ${noun}`;
  // Mirror MessageOutRow: DM sends carry the recipient in the title so the
  // row reads as a complete sentence without consulting the chip.
  const title = threaded
    ? `${base} in thread`
    : isDm && item.surface.label && item.surface.label !== 'DM'
      ? `${base} to ${item.surface.label.replace(/^@/, '')}`
      : base;
  const fileLink = item.permalink ?? slackOutboundLink(item.activity.payload ?? {});
  return (
    <Row
      time={time}
      dotColor={COLOR_OUTBOUND}
      voice="outbound"
      title={title}
      secondary={
        <span className="inline-flex items-center gap-2">
          <SurfaceText chip={item.surface} />
          {fileLink && <SlackLink href={fileLink} />}
        </span>
      }
      body={
        <div className="flex flex-col gap-2">
          {caption && (
            <span className="whitespace-pre-wrap break-words">{renderMrkdwn(caption)}</span>
          )}
          <div className="mt-1 flex flex-wrap gap-2">
            {item.files.map((file) => (
              <UploadedFile key={file.fileId} file={file} agentId={agentId} />
            ))}
          </div>
        </div>
      }
    />
  );
}
