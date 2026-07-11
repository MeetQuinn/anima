import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Repeat } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { fetchAgentReminders } from '@/api/agents';
import { queryKeys } from '@/lib/query-keys';
import { formatRelativeShort } from '@/lib/format';
import { useNow } from '@/hooks/useNow';
import type { Reminder, ReminderSchedule } from '@shared/reminder';

// ── Reminders as a ledger ─────────────────────────────────────────────────────
//
// Task #99 shape: Active is the page's subject - a handful of live rows that
// read like the Profile Setup ledger. Past is an archive, not content: rows
// collapse to one quiet line (cancelled ones dimmed, statuses as bare caps
// text instead of boxed chips), and the list shows a recent window with a
// Show-all disclosure. Real pools run 1-3 active against 40-60 past, so the
// old flat render made the tab read as a wall of dead reminders.

/** How many past reminders show before the Show-all disclosure. */
const PAST_PREVIEW = 12;

function describeSchedule(schedule: ReminderSchedule, nextDueAt?: string): string {
  if (schedule.kind === 'once') {
    if (!nextDueAt) return 'One-shot';
    return new Date(nextDueAt).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  if (schedule.kind === 'interval') {
    const minutes = Math.round(schedule.intervalMs / 60000);
    if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(hours / 24);
    return `Every ${days} day${days === 1 ? '' : 's'}`;
  }
  if (schedule.kind === 'daily') return `Daily at ${schedule.time}`;
  const days = schedule.weekdays.map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(', ');
  return `Weekly ${days} at ${schedule.time}`;
}

function ExpandedDetail({
  agentId,
  reminder,
  onViewStream,
}: {
  agentId: string;
  reminder: Reminder;
  onViewStream: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="space-y-3 border-l-2 border-border-soft pl-4">
      <div className="font-serif whitespace-pre-wrap break-words text-[14px] leading-[1.6] text-text">
        {reminder.instructions}
      </div>
      <div className="font-sans flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] tracking-wide text-text-muted">
        <span>
          Fired <span className="font-mono">{reminder.firedCount}</span>
          {reminder.firedCount === 1 ? ' time' : ' times'}
        </span>
        {reminder.lastFiredAt && (
          <>
            <span aria-hidden className="text-text-subtle">
              ·
            </span>
            <span>last {new Date(reminder.lastFiredAt).toLocaleString()}</span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {reminder.provenance && (
          <button
            onClick={() =>
              navigate(
                `/agents/${agentId}/channels?c=${encodeURIComponent(reminder.provenance!.channelId)}`,
              )
            }
            className="chrome text-[11px] uppercase tracking-[0.12em] text-text-muted underline decoration-border-soft underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            View conversation →
          </button>
        )}
        {reminder.lastFiredAt && (
          <button
            onClick={onViewStream}
            className="chrome text-[11px] uppercase tracking-[0.12em] text-text-muted underline decoration-border-soft underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            View activity stream →
          </button>
        )}
      </div>
    </div>
  );
}

function ActiveRow({
  agentId,
  reminder,
  now,
  onViewStream,
}: {
  agentId: string;
  reminder: Reminder;
  now: Date;
  onViewStream: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isRecurring = reminder.schedule.kind !== 'once';
  const nextDue = reminder.nextDueAt;

  return (
    <div className="border-b border-border-soft last:border-b-0">
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[1fr_auto] items-start gap-3 px-1 py-3.5 text-left hover:bg-surface-elevated/40"
      >
        <div className="min-w-0">
          <div className="font-serif text-[15px] leading-snug text-text">{reminder.title}</div>
          <div className="font-sans mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] tracking-wide text-text-muted">
            {isRecurring && (
              <Repeat aria-label="Recurring" className="h-3 w-3 self-center text-text-subtle" />
            )}
            <span>{describeSchedule(reminder.schedule, reminder.nextDueAt)}</span>
            {nextDue && (
              <>
                <span aria-hidden className="text-text-subtle">
                  ·
                </span>
                <span>next {formatRelativeShort(nextDue, now)}</span>
              </>
            )}
            {isRecurring && reminder.lastFiredAt && (
              <>
                <span aria-hidden className="text-text-subtle">
                  ·
                </span>
                <span>last fired {formatRelativeShort(reminder.lastFiredAt, now)}</span>
              </>
            )}
          </div>
        </div>
        <ChevronRight
          className={`mt-1.5 h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-1 pb-4">
          <ExpandedDetail agentId={agentId} reminder={reminder} onViewStream={onViewStream} />
        </div>
      )}
    </div>
  );
}

function PastRow({
  agentId,
  reminder,
  now,
  onViewStream,
}: {
  agentId: string;
  reminder: Reminder;
  now: Date;
  onViewStream: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cancelled = reminder.status === 'cancelled';
  const when = reminder.cancelledAt ?? reminder.lastFiredAt ?? reminder.updatedAt;

  return (
    <div className="border-b border-border-soft/60 last:border-b-0">
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-baseline gap-2.5 px-1 py-2 text-left hover:bg-surface-elevated/40"
      >
        <span
          className={`min-w-0 flex-1 truncate font-serif text-[14px] leading-snug ${
            cancelled ? 'text-text-muted' : 'text-text'
          }`}
        >
          {reminder.title}
        </span>
        {/* Bare caps, no chip box: the archive should not out-shout Active.
            Both status and timestamp stay at text-text-muted (6.67:1 on the
            surface): text-text-subtle measures 3.43:1, under the 4.5:1 AA
            floor for normal text, and 10px caps is not "large text". The
            cancelled/fired distinction lives in the dimmed title instead. */}
        <span className="chrome shrink-0 text-[10px] uppercase tracking-[0.1em] text-text-muted">
          {reminder.status}
        </span>
        <span className="font-sans shrink-0 text-[11px] tracking-wide text-text-muted">
          {formatRelativeShort(when, now)}
        </span>
        <ChevronRight
          className={`h-3 w-3 shrink-0 self-center text-text-subtle/70 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-1 pb-4 pt-1">
          <ExpandedDetail agentId={agentId} reminder={reminder} onViewStream={onViewStream} />
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-3 flex items-baseline gap-4">
      <h2 className="caps text-text-muted">
        {title}
        <span className="ml-2 font-mono text-[11px] tracking-normal text-text-subtle">{count}</span>
      </h2>
      <span className="h-px flex-1 bg-border-soft" />
    </div>
  );
}

export default function Reminders() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  // Keyed by agent so switching agents re-collapses the archive without an
  // effect: the disclosure is only open for the agent it was opened on.
  const [showAllFor, setShowAllFor] = useState<string | null>(null);
  const showAllPast = showAllFor != null && showAllFor === agentId;

  // Reset scroll to top when switching agents.
  useEffect(() => {
    containerRef.current?.scrollTo(0, 0);
  }, [agentId]);

  // Tick every minute so relative timestamps stay fresh.
  const now = useNow();

  const {
    data: reminders = [],
    error,
  } = useQuery({
    queryKey: queryKeys.agentReminders(agentId ?? ''),
    queryFn: () => fetchAgentReminders(agentId!),
    enabled: !!agentId,
  });

  const { active, past } = useMemo(() => {
    return {
      active: reminders
        .filter((r) => r.status === 'scheduled')
        .sort((a, b) => (a.nextDueAt ?? a.updatedAt).localeCompare(b.nextDueAt ?? b.updatedAt)),
      past: reminders
        .filter((r) => r.status === 'fired' || r.status === 'cancelled')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }, [reminders]);

  if (!agentId) return null;

  const visiblePast = showAllPast ? past : past.slice(0, PAST_PREVIEW);
  const hiddenPast = past.length - PAST_PREVIEW;

  return (
    <div
      ref={containerRef}
      className="bg-surface h-full overflow-y-auto px-6 py-8 md:px-10 md:py-10"
    >
      <div className="max-w-3xl">
        {error && (
          <div className="mb-6 rounded-sm border border-border-soft bg-surface-raised px-4 py-3 text-[13px] text-text-subtle">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}
        <section className="first:mt-0">
          <SectionHeader title="Active" count={active.length} />
          {active.length === 0 ? (
            <div className="font-serif italic py-3 text-[14px] text-text-subtle">
              No active reminders.
            </div>
          ) : (
            <div className="divide-y divide-border-soft border-b border-border-soft">
              {active.map((r) => (
                <ActiveRow
                  key={r.reminderId}
                  agentId={agentId}
                  reminder={r}
                  now={now}
                  onViewStream={() => navigate(`/agents/${agentId}/activity`)}
                />
              ))}
            </div>
          )}
        </section>

        {past.length > 0 && (
          <section className="mt-10">
            <SectionHeader title="Past" count={past.length} />
            <div className="divide-y divide-border-soft/60 border-b border-border-soft/60">
              {visiblePast.map((r) => (
                <PastRow
                  key={r.reminderId}
                  agentId={agentId}
                  reminder={r}
                  now={now}
                  onViewStream={() => navigate(`/agents/${agentId}/activity`)}
                />
              ))}
            </div>
            {hiddenPast > 0 && (
              <button
                type="button"
                onClick={() => setShowAllFor(showAllPast ? null : agentId)}
                aria-expanded={showAllPast}
                className="mt-3 font-sans text-[11px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted hover:decoration-text-muted/40"
              >
                {showAllPast ? 'Show fewer' : `Show all ${past.length}`}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
