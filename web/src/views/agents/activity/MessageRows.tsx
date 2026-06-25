import { ExternalLink } from 'lucide-react';
import { renderMrkdwn } from '@/lib/mrkdwn';
import { Row, SurfaceText, COLOR_OUTBOUND } from './Row';
import { UploadedFile } from './Attachments';
import type { ActivityFeedItem } from '@/lib/activity-feed';

// ---------------------------------------------------------------------------
// Outbound message + file rows.
//
// The Activity tab's primary conversation now renders Slack-style (shared
// `conversation/SlackTimeline`), so the old audit-register message rows are
// retired there. These two rows survive only as the nested-subagent renderer
// inside StepRow (AuditRows), where a delegated subagent's own outbound
// messages / file sends are shown in the compact chrome register.
// ---------------------------------------------------------------------------

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
        text ? <span className="whitespace-pre-wrap break-words">{renderMrkdwn(text)}</span> : undefined
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
          {caption && <span className="whitespace-pre-wrap break-words">{renderMrkdwn(caption)}</span>}
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
