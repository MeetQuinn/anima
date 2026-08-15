import { Bell, CirclePause, Lightbulb, UserPlus, type LucideIcon } from 'lucide-react';
import { clockHM, dateLabel, dateTimeFull } from '@/lib/format';
import type { ActivityFeedItem } from '@/lib/activity-feed';

// ---------------------------------------------------------------------------
// Timeline chrome shared across the Activity and Channels tabs — extracted
// from views/agents/conversation/SlackTimeline.tsx so the two consuming views
// (and AuditRows) stop reaching into a sibling view for presentation atoms.
// The Slack-style message rendering itself stays in SlackTimeline.tsx.
// ---------------------------------------------------------------------------

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

// System-originated wake (reminder / onboarding): a centered, avatar-less line
// so it reads as a timeline annotation, not a message someone sent. The type
// icon + small-caps label name the event class; the muted body carries the
// detail (reminder title / onboarding note). Short hairlines flank the pill on
// wider viewports to echo the Slack centered-system-notice convention; they
// drop on narrow widths so the pill never gets crushed.
const SYSTEM_EVENT_ICON: Record<
  'reminder' | 'onboarding' | 'attention' | 'held',
  LucideIcon
> = {
  attention: Lightbulb,
  held: CirclePause,
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
