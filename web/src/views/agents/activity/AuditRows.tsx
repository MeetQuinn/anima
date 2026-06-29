import { useState, type ReactNode } from 'react';
import { activityRow, activityIsFailure } from '@/lib/activities';
import { emojiGlyph, replaceEmojiShortcodes } from '@/lib/emoji';
import { dateLabel, clockHM } from '@/lib/format';
import { Row, SurfaceText, COLOR_OUTBOUND } from './Row';
import type { ActivityFeedItem, SubagentStream } from '@/lib/activity-feed';
import { shortenModelLabel, subagentDelegationLabel } from '@/lib/activity-feed';
import type { Activity as ActivityRecord } from '@shared/activity';
import { ChevronRight } from 'lucide-react';
import { MessageOutRow, FileOutRow } from './MessageRows';

// ---------------------------------------------------------------------------
// Reaction row
// ---------------------------------------------------------------------------

export function ReactOutRow({
  item,
  time,
}: {
  item: Extract<ActivityFeedItem, { kind: 'reaction-out' }>;
  time: string;
}) {
  // React is outbound voice (we wrote it → accent dot) but a lighter weight
  // than message/file. No margin pull-rule — that's reserved for message/file.
  // Chrome register at small size keeps it as a byline trace, not a tool
  // ledger entry. Render the actual Unicode glyph next to the verb so the
  // user can see _what_ was reacted with; glyph primary, name via title hover.
  // Workspace-custom emoji have no Unicode equivalent → fall back to the
  // `:name:` mono form rather than rendering nothing.
  const verb = item.action === 'added' ? 'Reacted' : 'Unreacted';
  const glyph = emojiGlyph(item.emoji);
  return (
    <Row
      time={time}
      dotColor={COLOR_OUTBOUND}
      register="chrome"
      title={
        <span className="inline-flex items-baseline gap-2">
          <span>{verb}</span>
          {item.emoji &&
            (glyph ? (
              <span
                className="text-[14px] leading-none normal-case"
                title={item.emoji}
                aria-label={item.emoji}
              >
                {glyph}
              </span>
            ) : (
              <span
                className="font-mono text-[11px] tracking-normal text-text normal-case"
                title={item.emoji}
              >
                :{item.emoji}:
              </span>
            ))}
        </span>
      }
      secondary={
        <span className="inline-flex items-center gap-2">
          <SurfaceText chip={item.surface} />
          {item.noop && (
            <span className="chrome text-[10px] text-text-subtle">
              {item.action === 'added' ? 'already present' : 'already absent'}
            </span>
          )}
        </span>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Tool step row
// ---------------------------------------------------------------------------

/** Extract a one-line preview from output text: first non-empty line, whitespace-collapsed. */
function outputLinePreview(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find((l) => l.length > 0) ?? '';
  // Strip common markdown markers so preview reads as plain prose.
  return line.replace(/\*{1,3}|_{1,3}|`+|~~|^#+\s*/g, '').trim();
}

export function StepRow({
  item,
  time,
}: {
  item: Extract<ActivityFeedItem, { kind: 'step' }>;
  time: string;
}) {
  const [streamsOpen, setStreamsOpen] = useState(false);
  const row = activityRow(item.activity);
  // Unknown activity types have no useful mapping — suppress entirely rather
  // than rendering an opaque placeholder row (round-2 item 2).
  if (row.kind === 'unknown') return null;
  const failed = activityIsFailure(item.activity);
  const hasSubagents = !!item.subagentStreams?.length;
  const totalChildSteps = item.subagentStreams
    ? item.subagentStreams.reduce((n, s) => n + s.items.length, 0)
    : 0;

  // For output rows (agent.text / runtime.output): collapse to a single-line
  // preview by extracting the first non-empty line with whitespace normalised.
  // This prevents the 280-char secondary from wrapping to multiple lines in the
  // flex-wrap title row. The full content is preserved in expandableBody.full.
  const isOutput = row.kind === 'output';
  const fullText = row.targetFull ?? row.target ?? '';
  const previewText = isOutput ? outputLinePreview(fullText) : null;
  // Needs expand when: multiline, or first line isn't the entire content.
  const outputNeedsExpand = isOutput && !!fullText && (
    fullText.includes('\n') ||
    fullText.trim() !== previewText
  );

  // For the "Delegated to subagent" row the tool payload carries no target, so
  // surface which subagent type + model the parent delegated to (e.g.
  // "Explore · Haiku"), derived from the attached subagent streams.
  const delegationLabel = hasSubagents
    ? subagentDelegationLabel(item.subagentStreams!)
    : undefined;
  const secondaryText = isOutput ? previewText : (row.target ?? delegationLabel);
  const secondary = (
    <span className="inline-flex min-w-0 items-center gap-2 overflow-hidden">
      {secondaryText ? (
        <span className="chrome min-w-0 truncate text-[11px] tracking-normal text-text-subtle normal-case">
          {replaceEmojiShortcodes(secondaryText)}
        </span>
      ) : null}
      {hasSubagents && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setStreamsOpen((v) => !v);
          }}
          className="inline-flex shrink-0 items-center gap-0.5 chrome text-[10px] uppercase tracking-[0.1em] text-accent hover:text-accent/80 focus-visible:outline-none"
          aria-expanded={streamsOpen}
          aria-label={streamsOpen ? 'Collapse subagent steps' : 'Expand subagent steps'}
        >
          <ChevronRight
            className={[
              'h-2.5 w-2.5 transition-transform',
              streamsOpen ? 'rotate-90' : '',
            ].join(' ')}
            aria-hidden
          />
          {item.subagentStreams!.length > 1
            ? `${item.subagentStreams!.length} subagents`
            : `${totalChildSteps} step${totalChildSteps !== 1 ? 's' : ''}`}
        </button>
      )}
    </span>
  );

  const full = isOutput ? (fullText || undefined) : (row.targetFull ?? row.target);
  const expandableBody = full
    ? {
        full: (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-text-muted">
            {replaceEmojiShortcodes(full)}
          </pre>
        ),
        upstreamTruncated: isOutput ? outputNeedsExpand : !!row.targetFull,
      }
    : undefined;

  return (
    <div>
      <Row
        time={time}
        dotColor={row.color}
        register="chrome"
        failed={failed}
        title={row.title}
        secondary={secondary}
        expandableBody={expandableBody}
      />
      {hasSubagents && streamsOpen && (
        <SubagentStreams
          streams={item.subagentStreams!}
          multipleStreams={item.subagentStreams!.length > 1}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subagent nested timeline
// ---------------------------------------------------------------------------

function SubagentStreams({
  streams,
  multipleStreams,
}: {
  streams: SubagentStream[];
  multipleStreams: boolean;
}) {
  return (
    <div className="ml-[2.5rem] mt-0.5 mb-2 border-l-2 border-spine-border/40 pl-3 md:ml-[3.5rem]">
      {streams.map((stream) => (
        <SubagentStreamSection
          key={stream.subRunId}
          stream={stream}
          showHeader={multipleStreams}
        />
      ))}
    </div>
  );
}

function SubagentStreamSection({
  stream,
  showHeader,
}: {
  stream: SubagentStream;
  showHeader: boolean;
}) {
  const label = [stream.name, stream.role, shortenModelLabel(stream.model)]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="py-0.5">
      {showHeader && label && (
        <span className="chrome block mb-0.5 text-[10px] uppercase tracking-[0.12em] text-text-subtle">
          {label}
        </span>
      )}
      {stream.items.map((child, i) => {
        const t = clockHM(child.timestamp);
        if (child.kind === 'message-out')
          return <MessageOutRow key={i} item={child} time={t} />;
        if (child.kind === 'file-out')
          return <FileOutRow key={i} item={child} time={t} agentId="" />;
        if (child.kind === 'reaction-out')
          return <ReactOutRow key={i} item={child} time={t} />;
        if (child.kind === 'step') {
          const row = activityRow(child.activity);
          if (row.kind === 'unknown') return null;
          const failed = activityIsFailure(child.activity);
          const secondary = row.target ? (
            <span className="chrome min-w-0 truncate text-[11px] tracking-normal text-text-subtle normal-case">
              {replaceEmojiShortcodes(row.target)}
            </span>
          ) : undefined;
          const full = row.targetFull ?? row.target;
          const expandableBody = full
            ? {
                full: (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-text-muted">
                    {replaceEmojiShortcodes(full)}
                  </pre>
                ),
                upstreamTruncated: !!row.targetFull,
              }
            : undefined;
          return (
            <Row
              key={i}
              time={t}
              dotColor={row.color}
              register="chrome"
              failed={failed}
              title={row.title}
              secondary={secondary}
              expandableBody={expandableBody}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Working indicator
// ---------------------------------------------------------------------------

// Live working indicator — rendered at the bottom of the stream while an item
// is active. Pulsing amber dot so the user can tell "it's doing something"
// without mistaking the static label for a frozen UI. Two states:
//   Working… — a tool call has started and hasn't completed yet
//   Thinking… — no open tool call; the model is generating
// State is proxied from the type of the most recent activity in the current
// item. ~100ms lag from the SSE debounce is fine (iris approval).
export function WorkingIndicator({
  latestActivity,
  time,
}: {
  latestActivity: ActivityRecord | undefined;
  time?: string;
}) {
  const isWorking = latestActivity?.type === 'tool.call.started';
  const label = isWorking ? 'Working' : 'Thinking';
  // Align the live pulse to the tool-step rows: the same Row grid (time in the
  // first column, pulse in the dot column, label in the content column). The
  // timestamp anchors it to the time rail so it reads as a real timeline entry
  // rather than a floating label. When the caller wraps this in the step gutter
  // + lane (a step already exists this turn), the pulse continues the step lane
  // and "Thinking…" lines up under the streaming step titles. Before any step
  // exists the caller renders it unwrapped, so it sits at the top-level rail
  // with its time aligned to the message/step time column instead of dangling
  // in an empty lane.
  return (
    <div className="grid grid-cols-[2.5rem_0.75rem_minmax(0,1fr)] items-baseline gap-2 py-2 pr-2 md:grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] md:gap-3 md:py-2.5 md:pr-3">
      <span className="text-right font-mono text-[10px] leading-6 text-text-subtle md:text-[11px]">
        {time}
      </span>
      <span className="flex h-6 items-center self-start" aria-hidden>
        <span
          className="inline-block h-2 w-2 animate-pulse rounded-full"
          style={{ background: 'var(--color-health-warn)' }}
        />
      </span>
      <div className="leading-6">
        <span className="chrome text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
          {label}…
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day section divider
// ---------------------------------------------------------------------------

export function DaySection({ date, children }: { date: string; children: ReactNode }) {
  // Editorial day-divider: small-caps Fraunces eyebrow + hairline rule. Reads
  // like a section break in a published log rather than a UI separator.
  return (
    <div>
      <div className="mt-8 mb-3 flex items-center gap-4 first:mt-2">
        <span className="caps text-text-muted">{dateLabel(date)}</span>
        <span className="h-px flex-1 bg-border-soft" />
      </div>
      <div>{children}</div>
    </div>
  );
}
