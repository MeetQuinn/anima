import { Fragment, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertCircle, BrainCircuit, ChevronRight, ExternalLink, Loader2, Power, X } from 'lucide-react';
import {
  fetchAgentStatuses,
  fetchAgentActivities,
  fetchAgentFeishuScopeStatus,
  fetchAgentMessages,
  fetchAgents,
} from '@/api/agents';
import { buildActivityFeed, buildMessageFeed, type ActivityFeedItem } from '@/lib/activity-feed';
import { activityRow, isNarrativeStep } from '@/lib/activities';
import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
import { clockHM, dateKey, dateLabel, formatRelativeShort } from '@/lib/format';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import {
  agentHealthDegradedText,
  agentHealthReasonText,
  agentHealthRecoveredFresh,
} from '@/components/AgentHealthIndicator';
import {
  groupByAuthor,
  initialOf,
  inboundAuthorName,
  isMessageItem,
  DayLabelPill,
  MessageGroupRow,
  SystemEventRow,
  type Author,
  type AuthorResolver,
  type SurfaceResolver,
} from '../conversation/SlackTimeline';
import { StepRow, WorkingIndicator } from './AuditRows';
import { useStickToBottom } from './useStickToBottom';
import type { Activity as ActivityRecord, AgentActivityFeedEvent } from '@shared/activity';
import type { AgentFeishuScopeAuthUrl } from '@shared/agent-config';
import type { AgentMessageRecord } from '@shared/messages';
import type { AgentStatusSummary } from '@shared/snapshot';

// ---------------------------------------------------------------------------
// Step lane — the subordinate register. A run of consecutive tool steps sits
// indented under the conversation behind a hairline rule, smaller + muted
// (chrome register), so steps read as a secondary trace beneath the Slack-style
// messages rather than competing with them. Per-step expand-for-full lives in
// StepRow itself (the depth that matters; iris-locked `795d974`).
// ---------------------------------------------------------------------------

function StepLane({ children }: { children: ReactNode }) {
  return (
    <div className="my-1 ml-1.5 border-l-2 border-border-soft/50 pl-2 md:ml-2 md:pl-3">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chronological stream model.
//
// The timeline is ONE ascending stream by real timestamp. Items split two ways:
//   SPECIAL  — Slack chat in/out, file-out, reactions, and system events
//              (reminders, onboarding, runtime restart/stop). These render as
//              their own rows in their true time slot.
//   NON-SPECIAL — thinking/OUTPUT, RAN tool steps, memory passes, IDLE/Working.
//              A contiguous run of these between two specials FOLDS in place
//              into one collapsible `▸ N steps` group sitting in its slot.
// The live (current) run's trailing fold is auto-expanded while it streams and
// collapses (animated) the moment the run completes.
// ---------------------------------------------------------------------------
type Step = Extract<ActivityFeedItem, { kind: 'step' }>;

// Within a special-run, separate centred system lines from the Slack message
// groups so a reminder/onboarding row doesn't get swept into an author group.
type DayBlock = { type: 'msgs' | 'steps' | 'system'; items: ActivityFeedItem[] };

// One entry in a day's chronological stream: a special conversation row, a
// promoted lifecycle system line, or a folded run of non-special steps.
type TimelineEntry =
  | { type: 'conv'; ts: number; timestamp: string; item: ActivityFeedItem }
  | { type: 'lifecycle'; ts: number; timestamp: string; step: Step }
  | { type: 'fold'; ts: number; timestamp: string; id: string; steps: Step[] };

// Steps promoted OUT of the fold into their own centred system line: important,
// non-chat lifecycle signals that should always show, not hide behind a fold.
// Two members: runtime restart/stop/idle-timeout (`runtime.aborted`), and the
// daily memory-coherence pass (`memory_coherence.outcome`) — its result is a
// first-class signal the owner wants to see at a glance, while the steps that
// ran inside the pass still fold beneath it. Everything else folds.
function isSpecialSystemStep(activity: ActivityRecord): boolean {
  return (
    activity.type === 'runtime.aborted' ||
    activity.type === 'memory_coherence.outcome'
  );
}

// Tie-break for atoms sharing a timestamp: inbound first, then outbound/system
// specials, then promoted lifecycle, then folded steps, with IDLE
// (runtime.completed) last so it reads as closing the slot.
function atomRank(kind: 'conv-in' | 'conv-out' | 'lifecycle' | 'fold', idle: boolean): number {
  if (kind === 'conv-in') return 0;
  if (kind === 'conv-out') return 1;
  if (kind === 'lifecycle') return 2;
  return idle ? 4 : 3;
}

function buildBlocks(items: ActivityFeedItem[]): DayBlock[] {
  const blocks: DayBlock[] = [];
  for (const item of items) {
    const type: DayBlock['type'] =
      item.kind === 'step' ? 'steps' : item.kind === 'system-event' ? 'system' : 'msgs';
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.items.push(item);
    else blocks.push({ type, items: [item] });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Folded step run — the non-special register.
//
// A contiguous run of non-special steps collapses behind a `▸ N steps`
// disclosure sitting in its own chronological slot. Expand state is keyed by
// the run's first-step activityId (stable across refetches). The body uses the
// grid 0fr/1fr trick so expand and collapse animate smoothly; the live run's
// trailing fold is forced open while streaming and animates shut on completion.
// ---------------------------------------------------------------------------

// Avatar-width left gutter so step content lines up under the message body (not
// under the avatar), mirroring MessageGroupRow's `flex gap-2.5 px-1` + `h-9 w-9`.
function StepGutter({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 px-1">
      <span className="h-9 w-9 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function StepsDisclosure({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="chrome -ml-1 mt-0.5 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-subtle transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <ChevronRight
        className={['h-3 w-3 transition-transform', expanded ? 'rotate-90' : ''].join(' ')}
        aria-hidden
      />
      {count} step{count !== 1 ? 's' : ''}
    </button>
  );
}

function StepList({ steps }: { steps: Extract<ActivityFeedItem, { kind: 'step' }>[] }) {
  return (
    <StepLane>
      {steps.map((item, si) => (
        <StepRow key={`${item.activity.activityId}:${si}`} item={item} time={clockHM(item.timestamp)} />
      ))}
    </StepLane>
  );
}

// A folded run of non-special steps in its chronological slot. The disclosure
// sits at the message gutter; the body animates open/closed via the grid
// 0fr/1fr height trick (overflow-hidden child). `motion-reduce` opts out.
function StepFold({
  steps,
  expanded,
  onToggle,
}: {
  steps: Step[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <StepGutter>
      <StepsDisclosure count={steps.length} expanded={expanded} onToggle={onToggle} />
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <StepList steps={steps} />
        </div>
      </div>
    </StepGutter>
  );
}

// A promoted lifecycle step rendered as a centred system line — same visual
// family as the reminder/onboarding SystemEventRow, so non-chat lifecycle
// signals read as special, not as steps. The icon keys off the step type
// (runtime restart/stop → Power; memory-coherence pass → BrainCircuit), and a
// failure outcome (e.g. "Memory coherence failed") tints the pill health-red.
function LifecycleLineRow({ step }: { step: Step }) {
  const row = activityRow(step.activity);
  const isMemory = step.activity.type === 'memory_coherence.outcome';
  const isFailure = row.kind === 'failure';
  const Icon = isMemory ? BrainCircuit : Power;
  const accentClass = isFailure ? 'text-health-error' : 'text-text-subtle';
  return (
    <div className="flex items-center justify-center gap-2.5 px-1 py-1.5">
      <span aria-hidden className="hidden h-px w-8 shrink-0 bg-border-soft sm:block" />
      <span
        className={[
          'inline-flex max-w-[85%] items-center gap-1.5 rounded-full border bg-surface-raised px-2.5 py-0.5',
          isFailure ? 'border-health-error/40' : 'border-border-soft',
        ].join(' ')}
      >
        <Icon className={['h-3 w-3 shrink-0', accentClass].join(' ')} aria-hidden />
        <span
          className={[
            'shrink-0 font-sans text-[9.5px] font-semibold uppercase tracking-[0.12em]',
            accentClass,
          ].join(' ')}
        >
          {row.title}
        </span>
        {row.target && (
          <span className="truncate font-sans text-[12px] text-text-muted">{row.target}</span>
        )}
        <span className="shrink-0 font-sans text-[10px] text-text-subtle">
          {clockHM(step.timestamp)}
        </span>
      </span>
      <span aria-hidden className="hidden h-px w-8 shrink-0 bg-border-soft sm:block" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ActivityStatusSummary({
  status,
  latestActivity,
  now,
}: {
  status: AgentStatusSummary | undefined;
  latestActivity: ActivityRecord | undefined;
  now: Date;
}) {
  if (!status) return null;
  const running = Boolean(status.currentItemId);
  const queued = status.queueDepth > 0;
  const health = status.health;
  const restartFailed = health?.state !== 'healthy' && health?.restart?.outcome === 'failed';
  const unhealthy = health?.state === 'unhealthy' || restartFailed;
  const recovered = !unhealthy && health ? agentHealthRecoveredFresh(health, now.getTime()) : false;
  const starting = !unhealthy && !recovered && health?.state === 'starting';
  const degraded = !unhealthy && !recovered && !starting && health?.state === 'degraded';
  const unknown = !unhealthy && !recovered && !starting && !degraded && health?.state === 'unknown';
  const state = unhealthy
    ? 'Needs attention'
    : recovered
      ? 'Recovered'
      : starting
        ? health?.reason === 'restart_pending'
          ? 'Restarting'
          : 'Starting'
        : degraded
          ? 'Retrying'
          : unknown
            ? 'Health unavailable'
            : running
              ? 'Working'
              : queued
                ? 'Queued'
                : 'Idle';
  const dot = unhealthy
    ? 'var(--color-health-error)'
    : recovered
      ? 'var(--color-health-ok)'
      : starting || degraded || unknown
        ? 'var(--color-health-idle)'
        : running
          ? 'var(--color-health-warn)'
          : queued
            ? 'var(--color-health-idle)'
            : 'var(--color-health-ok)';
  const reason = unhealthy
    ? agentHealthReasonText(health?.restart?.reason ?? health?.reason)
    : degraded
      ? agentHealthDegradedText(health?.reason)
      : undefined;
  const latest =
    latestActivity && isNarrativeStep(latestActivity) ? activityRow(latestActivity) : undefined;

  return (
    <div className="shrink-0 border-b border-border-soft bg-surface-raised/30 px-4 py-2 md:px-10">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="chrome flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: dot }} />
          {state}
        </span>
        {reason && (
          <span
            className={[
              'font-sans text-[11px]',
              unhealthy ? 'text-health-error' : 'text-text-muted',
            ].join(' ')}
          >
            {reason}
          </span>
        )}
        {!unhealthy && !recovered && running && status.currentItemStartedAt && (
          <span className="font-sans text-[11px] text-text-subtle">
            started {formatRelativeShort(status.currentItemStartedAt, now)}
          </span>
        )}
        {queued && (
          <span className="font-sans text-[11px] text-text-subtle">{status.queueDepth} queued</span>
        )}
        {latest && (
          <span className="min-w-0 flex-1 basis-64 truncate font-sans text-[11px] text-text-muted">
            latest: {latest.title}
            {latest.target ? ` · ${latest.target}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// First-run hero — the live moment.
//
// Renders in place of the generic "No activity yet." text the first time a
// freshly connected agent's feed is empty. It is an invite, not a claim: it
// never asserts the agent has messaged the owner (the proactive greeting is
// async and may not have landed), so the copy stays user-initiated. Yields the
// moment the first real activity arrives (filteredItems.length > 0).
// ---------------------------------------------------------------------------

function FirstRunHero({ agentName, platform }: { agentName?: string; platform: 'feishu' | 'slack' }) {
  const platformLabel = platform === 'feishu' ? 'Feishu' : 'Slack';
  return (
    <div className="mt-20 flex flex-col items-center px-6 text-center animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none">
      <span className="relative mb-5 flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-activity-outbound opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-activity-outbound" />
      </span>
      <p className="font-serif text-[19px] leading-tight text-text">Your agent is live.</p>
      <p className="mt-1.5 font-serif text-[15px] leading-snug text-text-muted">
        Say hi to {agentName ? <span className="font-medium text-text">{agentName}</span> : 'it'} in{' '}
        {platformLabel}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FeishuHelloBanner — the one-time, dismissible connect confirmation that sits
// atop the activity tab after a fresh Feishu connect. Decoupled from the async
// greeting: it states the hello is on its way (future tense), never that it has
// already happened, so a best-effort greeting that is slow or fails never makes
// this a lie. Dismissal is permanent for the connection (handled by the caller).
// ---------------------------------------------------------------------------

function FeishuHelloBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-border-soft bg-accent-soft/40 px-4 py-3 md:px-10">
      <p className="flex-1 font-serif text-[13px] leading-snug text-text">
        Feishu connected. Your agent will say hi in Feishu in a moment.
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface hover:text-text"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function FeishuRecommendedPermissionsConnectBanner({
  authUrl,
  authUrls,
  onDismiss,
}: {
  authUrl?: string;
  authUrls?: AgentFeishuScopeAuthUrl[];
  onDismiss: () => void;
}) {
  const links = authUrls?.length
    ? authUrls
    : authUrl
      ? [{ authUrl, label: 'Authorize in Feishu', scopes: [] }]
      : [];
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-border-soft bg-health-warn-soft/60 px-4 py-2.5 md:px-10">
      <div className="min-w-0 flex-1">
        <p className="font-serif text-[13px] leading-snug text-text">
          Connected. Your agents can message your team right away. Optional: authorize recommended
          Feishu permissions so they can use teammate names, take part in group chats with people
          and other bots, look people up by email or phone, invite members to chats, and work with
          Feishu Drive and cloud documents.
        </p>
        {links.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {links.map((link) => (
              <a
                key={`${link.label}:${link.authUrl}`}
                href={link.authUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-sans text-[12px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
              >
                {link.label} <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface hover:text-text"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity view — one Slack-style timeline plus a single "Show tool steps"
// toggle (iris-locked spec `795d974`). Layered sourcing (`1782412048`):
//   • Conversation layer = the messages feed (buildMessageFeed), ALWAYS, complete
//     history, byte-identical to the Channels tab. Reminders stay inline here.
//   • Step layer = the activity feed's curated non-conversation rows
//     (isNarrativeStep), toggle-gated, interleaved by timestamp as subordinate
//     rows. The activity feed read path is count/cursor based (not time-bounded),
//     so when steps are interleaved we auto-page it until its raw window spans
//     the loaded conversation, then state any remaining boundary explicitly. The
//     step layer is never implied to be a complete history.
// ---------------------------------------------------------------------------

export default function Activity() {
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const { data: agentStatuses = [] } = useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
    refetchInterval: refetchIntervals.agentStatuses,
  });
  const { agentId } = useParams<{ agentId: string }>();
  const agent = agents.find((a) => a.id === agentId);
  const [searchParams] = useSearchParams();
  // Dev-only, side-effect-free preview of the first-run hero for screenshots /
  // on-render review (?_previewFirstRunHero=feishu|slack). Never honored in prod.
  const previewFirstRunHero = import.meta.env.DEV
    ? ((searchParams.get('_previewFirstRunHero') as 'feishu' | 'slack' | null) ?? undefined)
    : undefined;
  const now = useNow();
  // Per-turn step expand state. Keyed by groupKey(group); a key present = expanded.
  // Default-collapsed (empty set); a concluded turn gets a fresh key so it folds
  // shut on completion. Survives polling because group keys are stable.
  const [expandedTurns, toggleTurn] = useReducer(
    (set: Set<string>, key: string) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    },
    undefined,
    () => new Set<string>(),
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Wraps the scrolling content so the scroll controller's ResizeObserver can
  // watch its height (follow the bottom, preserve position on prepend). A plain
  // static wrapper — it does not become a scroll/containing block, so the sticky
  // day headers still resolve to the scroll container.
  const contentRef = useRef<HTMLDivElement>(null);

  // Conversation layer — always loaded (complete history, Channels-identical).
  // Always both directions; the inbox/outbox sub-filter was retired.
  const messageQuery = useInfiniteQuery({
    queryKey: queryKeys.agentMessages(agentId ?? ''),
    queryFn: ({ pageParam }) =>
      fetchAgentMessages(agentId!, { before: pageParam, limit: 100 }),
    enabled: !!agentId,
    initialPageParam: undefined as string | undefined,
    // Forward pagination toward OLDER history: page[0] stays the newest page so a
    // poll/refetch (which rebuilds the page list from page[0] forward via
    // getNextPageParam) never drops the latest records once older history loads.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
    refetchInterval: agentId ? refetchIntervals.agentActivities : false,
  });

  // Step layer — always loaded now (steps fold in place in the chronological
  // stream rather than hiding behind a global toggle). The conversation is
  // still primary: an activity error or slow load never blocks or blanks the
  // message timeline (feedError / loadingActivities track the conversation only);
  // steps simply populate the folds as they arrive.
  const activityQuery = useInfiniteQuery({
    queryKey: queryKeys.agentActivities(agentId ?? ''),
    queryFn: ({ pageParam }) => fetchAgentActivities(agentId!, 100, pageParam),
    enabled: !!agentId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
    refetchInterval: agentId ? refetchIntervals.agentActivities : false,
  });

  const feedError = messageQuery.error;
  const loadingActivities = messageQuery.isLoading;

  // Merge all loaded pages into single feed pages, deduped by source id so the
  // live-refetch of the newest page never creates duplicates.
  const activitiesData = useMemo(() => {
    if (!activityQuery.data?.pages.length) return undefined;
    const eventMap = new Map<string, AgentActivityFeedEvent>();
    for (const page of activityQuery.data.pages) {
      for (const event of page.events ?? []) {
        const key =
          event.kind === 'activity'
            ? `activity:${event.activity.activityId}`
            : `inbox:${event.item.id}`;
        eventMap.set(key, event);
      }
    }
    return { events: Array.from(eventMap.values()) };
  }, [activityQuery.data]);

  const messagesData = useMemo(() => {
    if (!messageQuery.data?.pages.length) return undefined;
    const messageMap = new Map<string, AgentMessageRecord>();
    for (const page of messageQuery.data.pages) {
      for (const entry of page.entries ?? []) {
        messageMap.set(entry.messageId, entry);
      }
    }
    return { entries: Array.from(messageMap.values()) };
  }, [messageQuery.data]);

  const currentStatus = agentStatuses.find((s) => s.agentId === agentId);
  const currentItemId = currentStatus?.currentItemId;
  const currentItemStartedAt = currentStatus?.currentItemStartedAt;

  // Conversation layer items — the timeline backbone. Keep system-event rows
  // (reminder / onboarding) alongside messages: they are conversation-layer
  // timeline annotations, not tool steps.
  const conversationItems = useMemo(() => {
    if (!messagesData) return [];
    return buildMessageFeed(messagesData).filter(
      (item) => isMessageItem(item) || item.kind === 'system-event',
    );
  }, [messagesData]);

  // Identity of the newest conversation row. Changes whenever a message/event
  // arrives (count grows or a newer timestamp appears). The live-follow effect
  // keys on this so a new inbound message scrolls the viewport to the true
  // bottom: message data arrives on a different query than activity, so without
  // this the follow only fired on activity changes and landed short of the
  // freshly appended row.
  const latestMessageKey = useMemo(() => {
    if (conversationItems.length === 0) return null;
    let maxTs = conversationItems[0]!.timestamp;
    for (const item of conversationItems) {
      if (item.timestamp > maxTs) maxTs = item.timestamp;
    }
    return `${conversationItems.length}|${maxTs}`;
  }, [conversationItems]);

  // Step layer items — curated isNarrativeStep set only (never the firehose;
  // iris-locked `795d974`). Suppress a tool's started row when its failure row is
  // present so a failed tool shows once, as the failure. These feed the
  // chronological stream: foldable steps collapse into `N steps` groups in their
  // time slot, and `runtime.aborted` is promoted to a standalone lifecycle line
  // (see timelineByDay).
  const stepItems = useMemo(() => {
    if (!activitiesData) return [] as Extract<ActivityFeedItem, { kind: 'step' }>[];
    const feed = buildActivityFeed(activitiesData, false);
    const failedProviderToolIds = new Set<string>();
    for (const item of feed) {
      if (item.kind === 'step' && item.activity.type === 'tool.call.failed') {
        const pid = item.activity.payload?.['providerToolId'];
        if (typeof pid === 'string' && pid) failedProviderToolIds.add(pid);
      }
    }
    return feed.filter((item): item is Extract<ActivityFeedItem, { kind: 'step' }> => {
      if (item.kind !== 'step') return false;
      if (!isNarrativeStep(item.activity)) return false;
      if (item.activity.type === 'tool.call.started' && failedProviderToolIds.size > 0) {
        const pid = item.activity.payload?.['providerToolId'];
        if (typeof pid === 'string' && pid && failedProviderToolIds.has(pid)) return false;
      }
      return true;
    });
  }, [activitiesData]);

  // The conversation backbone — special chat rows, chronological. Used for the
  // coverage/empty/hero gates below; the rendered stream is timelineByDay.
  const filteredItems = useMemo(() => {
    return [...conversationItems].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
  }, [conversationItems]);

  // Build the single chronological stream, bucketed by day. Every timeline atom
  // (special conversation row, promoted lifecycle step, or foldable non-special
  // step) is sorted into its true time slot; within each day, contiguous runs of
  // foldable steps collapse into one `fold` entry sitting between the specials
  // that bracket them. Folds never cross a day boundary (atoms bucket by day
  // first), so the day dividers stay honest.
  const timelineByDay = useMemo<[string, TimelineEntry[]][]>(() => {
    type Atom =
      | { ts: number; timestamp: string; kind: 'conv'; item: ActivityFeedItem }
      | { ts: number; timestamp: string; kind: 'lifecycle'; step: Step }
      | { ts: number; timestamp: string; kind: 'fold'; step: Step };
    const atoms: Atom[] = [];
    for (const item of conversationItems) {
      const ts = Date.parse(item.timestamp);
      if (Number.isFinite(ts)) atoms.push({ ts, timestamp: item.timestamp, kind: 'conv', item });
    }
    for (const step of stepItems) {
      const ts = Date.parse(step.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (isSpecialSystemStep(step.activity))
        atoms.push({ ts, timestamp: step.timestamp, kind: 'lifecycle', step });
      else atoms.push({ ts, timestamp: step.timestamp, kind: 'fold', step });
    }

    const rankOf = (a: Atom): number => {
      if (a.kind === 'conv')
        return atomRank(a.item.kind === 'message-in' ? 'conv-in' : 'conv-out', false);
      if (a.kind === 'lifecycle') return atomRank('lifecycle', false);
      return atomRank('fold', a.step.activity.type === 'runtime.completed');
    };

    const days = new Map<string, Atom[]>();
    for (const a of atoms) {
      const key = dateKey(a.timestamp);
      const list = days.get(key);
      if (list) list.push(a);
      else days.set(key, [a]);
    }

    const result: [string, TimelineEntry[]][] = [];
    for (const [day, list] of days) {
      list.sort((a, b) => a.ts - b.ts || rankOf(a) - rankOf(b));
      const entries: TimelineEntry[] = [];
      let pending: Step[] = [];
      const flush = () => {
        if (pending.length === 0) return;
        const first = pending[0]!;
        entries.push({
          type: 'fold',
          ts: Date.parse(first.timestamp),
          timestamp: first.timestamp,
          id: `fold:${first.activity.activityId}`,
          steps: pending,
        });
        pending = [];
      };
      for (const a of list) {
        if (a.kind === 'fold') {
          pending.push(a.step);
          continue;
        }
        flush();
        if (a.kind === 'conv')
          entries.push({ type: 'conv', ts: a.ts, timestamp: a.timestamp, item: a.item });
        else entries.push({ type: 'lifecycle', ts: a.ts, timestamp: a.timestamp, step: a.step });
      }
      flush();
      result.push([day, entries]);
    }
    result.sort(([a], [b]) => a.localeCompare(b));
    return result;
  }, [conversationItems, stepItems]);

  // The live run's trailing steps are the last fold in the latest day. While the
  // run is current we force that fold open (auto-expand); when currentItemId
  // clears it falls back to collapsed and the grid height animates it shut.
  const liveFoldId = useMemo<string | null>(() => {
    if (!currentItemId || timelineByDay.length === 0) return null;
    const lastDay = timelineByDay[timelineByDay.length - 1]![1];
    const last = lastDay[lastDay.length - 1];
    return last && last.type === 'fold' ? last.id : null;
  }, [currentItemId, timelineByDay]);

  // --- Coverage alignment (honesty contract) --------------------------------
  // The conversation feed (messages store) and the step feed (activity store)
  // paginate independently by count, so their loaded time-windows can diverge:
  // the newest 100 activity events may span only hours while the newest 100
  // messages span days. Left unaligned, older visible messages would render with
  // no adjacent steps and read as "nothing happened" when the steps simply were
  // not paged in. Steps are always available now (folded in place in the
  // chronological stream), so we
  // always keep fetching activity pages until the loaded activity window reaches
  // at least as far back as the oldest loaded message (or the feed is exhausted).
  // The residual case — the activity store exhausted before reaching the oldest
  // loaded message (older steps no longer retained) — is made explicit with a
  // boundary notice rather than left to imply silence.
  const interleaving = true;

  // Oldest loaded conversation timestamp (the older edge of the visible window).
  const oldestMessageTs = useMemo(() => {
    let min = Infinity;
    for (const item of conversationItems) {
      const t = Date.parse(item.timestamp);
      if (Number.isFinite(t) && t < min) min = t;
    }
    return min === Infinity ? null : min;
  }, [conversationItems]);

  // Oldest loaded RAW activity event — coverage is measured by the feed window
  // we have actually paged in, NOT the curated step subset (a covered region may
  // legitimately have no narrative step; an un-paged region must not be confused
  // with it).
  const oldestActivityTs = useMemo(() => {
    if (!activitiesData?.events.length) return null;
    let min = Infinity;
    for (const ev of activitiesData.events) {
      const t = Date.parse(ev.timestamp);
      if (Number.isFinite(t) && t < min) min = t;
    }
    return min === Infinity ? null : min;
  }, [activitiesData]);

  // Step coverage reaches the loaded conversation window when the oldest loaded
  // activity event is at or before the oldest loaded message.
  const activityCoversMessages =
    oldestMessageTs === null ||
    (oldestActivityTs !== null && oldestActivityTs <= oldestMessageTs);

  // Explicit boundary: steps are interleaved and the conversation has loaded
  // messages, but the activity feed is exhausted and still does not reach the
  // oldest loaded message. Below this timestamp older steps are no longer
  // retained, so we label it instead of implying those messages had no activity.
  const stepCoverageFloorTs =
    interleaving &&
    activityQuery.hasNextPage === false &&
    !activityQuery.isFetchingNextPage &&
    oldestActivityTs !== null &&
    oldestMessageTs !== null &&
    oldestActivityTs > oldestMessageTs
      ? oldestActivityTs
      : null;

  const latestCurrentItemActivity = useMemo(() => {
    if (!currentItemId || !activitiesData) return undefined;
    const activities = activitiesData.events.flatMap((event) =>
      event.kind === 'activity' ? [event.activity] : [],
    );
    const itemActivities = currentItemStartedAt
      ? activities.filter((a) => a.createdAt >= currentItemStartedAt)
      : activities;
    if (!itemActivities.length) return undefined;
    return itemActivities.reduce((latest, a) => (a.createdAt > latest.createdAt ? a : latest));
  }, [currentItemId, currentItemStartedAt, activitiesData]);

  // Whether the current (live) turn has produced a lane-rendered step yet. Until
  // it has, the live indicator should sit at the top-level time rail (not
  // indented into the step lane), so it doesn't dangle in an empty lane with
  // nothing above it. Once a folded step exists, the indicator nests into the
  // lane and continues it (alignment confirmed correct by totoday).
  //
  // Derive this from the SAME visible step layer the timeline renders
  // (`stepItems` = buildActivityFeed(..., false) + isNarrativeStep), not raw
  // `activityRow`. Hidden runtime plumbing (runtime.started/pending, provider
  // stream internals) maps to non-`unknown` rows but is stripped by HIDDEN_TYPES
  // before render, so checking raw activities would flip this true at turn start
  // before any visible step exists — re-creating the very orphan this fixes.
  // Special system steps are excluded too: they promote to top-level rows (not
  // the lane), so the indicator should stay on the rail to align with them.
  const currentTurnHasStep = useMemo(() => {
    if (!currentItemId || !currentItemStartedAt) return false;
    return stepItems.some(
      (item) =>
        item.activity.createdAt >= currentItemStartedAt &&
        !isSpecialSystemStep(item.activity),
    );
  }, [currentItemId, currentItemStartedAt, stepItems]);

  // The live indicator's timestamp: when the latest activity in this turn
  // happened, else when the turn started, else now. Anchors it to the time
  // rail so it reads as a real timeline entry rather than a floating label.
  const workingTimeIso =
    latestCurrentItemActivity?.createdAt ?? currentItemStartedAt ?? now.toISOString();

  // First-run hero gating. Show the live-moment invite in place of the generic
  // empty text only when the feed is empty (a brand-new agent). Needs a known
  // connected platform to phrase the invite honestly.
  const connectedPlatform: 'feishu' | 'slack' | undefined = agent?.feishu?.connected
    ? 'feishu'
    : agent?.slack?.connected
      ? 'slack'
      : undefined;
  const heroPlatform = previewFirstRunHero ?? connectedPlatform;
  const showFirstRunHero =
    previewFirstRunHero !== undefined ||
    (!loadingActivities &&
      filteredItems.length === 0 &&
      stepItems.length === 0 &&
      connectedPlatform !== undefined);

  // --- Post-onboarding first landing -----------------------------------------
  // A fresh Feishu connect navigates here with router state:
  //   { onboardingConnected: 'feishu', feishuGreetingBanner?: boolean }
  // We arm the one-time greeting + recommended-permissions banners (no lens to
  // force any more — the Activity tab is the only view). The manual existing-app
  // path has no owner open_id and is left ungreeted (#154): it shows no "say hi".
  //
  // The signal is read from the *current* location every render and consumed via
  // a route-keyed effect, NOT captured at mount: React Router reuses this Activity
  // component when the user creates another agent from an existing activity page.
  const location = useLocation();
  const navigate = useNavigate();
  const landingState = location.state as
    | { onboardingConnected?: 'feishu' | 'slack'; feishuGreetingBanner?: boolean }
    | null;
  const justConnectedFeishu = landingState?.onboardingConnected === 'feishu';
  const landingWantsBanner = justConnectedFeishu && landingState?.feishuGreetingBanner === true;

  // --- One-time "say hi in Feishu" banner ------------------------------------
  // Dismissal is permanent and keyed to the connection (appId), so a fresh
  // reconnect can legitimately show it again, but within one connection it is
  // one-shot. The banner is decoupled from the async greeting: it never blocks
  // and never claims the hello already happened.
  const previewHelloBanner = import.meta.env.DEV && searchParams.get('_previewHelloBanner') === '1';
  const feishuConnKey = agent?.feishu?.connected
    ? agent.feishu.appId?.trim() || 'connected'
    : undefined;
  const [, forceHelloRerender] = useReducer((n: number) => n + 1, 0);

  // Arm + consume the landing signal. Keyed on the route + connection so it
  // survives this component being reused for a freshly created agent, and waits
  // for the connection key (appId) to resolve before persisting the arm so a late
  // appId can't drop it. The ref stops a re-arm after the consuming replace.
  const landingProcessedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!justConnectedFeishu) return;
    if (landingProcessedRef.current === location.key) return;
    if (!agentId || !feishuConnKey) return;
    try {
      localStorage.setItem(`feishu-recommended-scopes-armed:${agentId}`, feishuConnKey);
    } catch {
      /* localStorage unavailable */
    }
    if (landingWantsBanner) {
      try {
        localStorage.setItem(`feishu-hello-armed:${agentId}`, feishuConnKey);
      } catch {
        /* localStorage unavailable */
      }
    }
    landingProcessedRef.current = location.key;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [
    justConnectedFeishu,
    landingWantsBanner,
    location.key,
    location.pathname,
    location.search,
    agentId,
    feishuConnKey,
    navigate,
  ]);

  // Read the persisted arm/dismiss flags fresh each render — cheap, and always in
  // sync with the writes above and the dismissal below (each is followed by a
  // re-render: the consuming navigate, or forceHelloRerender on dismiss).
  const helloPersisted = (() => {
    if (!agentId || !feishuConnKey) return { armed: false, dismissed: false };
    try {
      return {
        armed: localStorage.getItem(`feishu-hello-armed:${agentId}`) === feishuConnKey,
        dismissed: localStorage.getItem(`feishu-hello-dismissed:${agentId}`) === feishuConnKey,
      };
    } catch {
      return { armed: false, dismissed: false };
    }
  })();
  const recommendedPermissionsPersisted = (() => {
    if (!agentId || !feishuConnKey) return { armed: false, dismissed: false };
    try {
      return {
        armed: localStorage.getItem(`feishu-recommended-scopes-armed:${agentId}`) === feishuConnKey,
        dismissed:
          localStorage.getItem(`feishu-recommended-scopes-dismissed:${agentId}`) === feishuConnKey,
      };
    } catch {
      return { armed: false, dismissed: false };
    }
  })();

  function dismissHelloBanner() {
    if (agentId && feishuConnKey) {
      try {
        localStorage.setItem(`feishu-hello-dismissed:${agentId}`, feishuConnKey);
      } catch {
        /* localStorage unavailable */
      }
    }
    forceHelloRerender();
  }

  function dismissRecommendedPermissionsBanner() {
    if (agentId && feishuConnKey) {
      try {
        localStorage.setItem(`feishu-recommended-scopes-dismissed:${agentId}`, feishuConnKey);
      } catch {
        /* localStorage unavailable */
      }
    }
    forceHelloRerender();
  }

  const showHelloBanner =
    previewHelloBanner ||
    ((landingWantsBanner || helloPersisted.armed) && !helloPersisted.dismissed);

  const shouldCheckRecommendedPermissions = Boolean(
    agentId &&
      recommendedPermissionsPersisted.armed &&
      !recommendedPermissionsPersisted.dismissed &&
      connectedPlatform === 'feishu',
  );
  const { data: feishuScopeStatus } = useQuery({
    queryKey: queryKeys.agentFeishuScopes(agentId ?? ''),
    queryFn: () => fetchAgentFeishuScopeStatus(agentId!),
    enabled: shouldCheckRecommendedPermissions,
  });
  const recommendedPermissionsState = feishuScopeStatus?.recommended.state;
  const showRecommendedPermissionsConnectBanner =
    recommendedPermissionsPersisted.armed &&
    !recommendedPermissionsPersisted.dismissed &&
    (recommendedPermissionsState === 'missing' || recommendedPermissionsState === 'unknown');

  const error =
    feedError instanceof Error ? feedError.message : feedError ? String(feedError) : null;

  // --- Author / surface resolvers for the shared Slack-style renderer --------
  // Cross-channel axis: the agent bylines its own outbound rows; inbound rows
  // byline their sender. Avatars fall back to initials cross-channel (no single
  // DM channel to pull an image from). The surface resolver adds a per-group
  // channel chip and breaks groups when the conversation jumps channels.
  const agentDisplay = agent ? agentDisplayName(agent) : (agentId ?? '');
  const agentAvatar = agentAvatarUrl(agent);
  const agentAuthor: Author = {
    key: 'agent',
    name: agentDisplay,
    ...(agentAvatar ? { avatarUrl: agentAvatar } : {}),
    initial: initialOf(agentDisplay),
    isAgent: true,
  };
  const resolveAuthor: AuthorResolver = (item) => {
    if (item.kind !== 'message-in') return agentAuthor;
    const name = inboundAuthorName(item.event);
    const uid = item.event.kind === 'slack' ? item.event.actor?.userId : undefined;
    return {
      key: `in:${uid ?? name}`,
      name,
      // Sender's real Slack avatar when resolved (see /messages enrichment);
      // falls back to the initial when absent (left workspace, no photo).
      ...(item.avatarUrl ? { avatarUrl: item.avatarUrl } : {}),
      initial: initialOf(name),
      isAgent: false,
    };
  };
  const resolveSurface: SurfaceResolver = (item) => {
    const chip = 'surface' in item ? item.surface : undefined;
    if (!chip) return { key: '' };
    return { key: `${chip.kind}:${chip.label}`, chip };
  };

  // Render a chronological run of special conversation items into centred system
  // lines + author-grouped message rows. Steps no longer bind to turns (they live
  // in their own fold entries), so every author group renders as a plain
  // MessageGroupRow. Factored out so a day can render multiple runs split by the
  // folds / lifecycle lines that break them.
  const renderConvRun = (items: ActivityFeedItem[], keyPrefix: string): ReactNode =>
    buildBlocks(items).map((block, bi) => {
      if (block.type === 'system') {
        return (
          <Fragment key={`${keyPrefix}:b:${bi}`}>
            {block.items.map((item, si) => (
              <SystemEventRow
                key={`${keyPrefix}:b:${bi}:${si}`}
                item={item as Extract<ActivityFeedItem, { kind: 'system-event' }>}
              />
            ))}
          </Fragment>
        );
      }
      return (
        <Fragment key={`${keyPrefix}:b:${bi}`}>
          {groupByAuthor(block.items, resolveAuthor, resolveSurface).map((group, gi) => (
            <MessageGroupRow
              key={`${keyPrefix}:b:${bi}:${gi}`}
              group={group}
              agentId={agentId ?? ''}
            />
          ))}
        </Fragment>
      );
    });

  // --- Infinite scroll pagination -------------------------------------------
  // Fire an older-page fetch (messages and/or activity). Position preservation
  // on the resulting prepend is owned by the scroll controller (useStickToBottom)
  // via `isFetchingOlder` — nothing here touches scrollTop.
  const fetchOlder = () => {
    if (messageQuery.hasNextPage && !messageQuery.isFetchingNextPage) {
      void messageQuery.fetchNextPage();
    }
    if (activityQuery.hasNextPage && !activityQuery.isFetchingNextPage) {
      void activityQuery.fetchNextPage();
    }
  };
  const isFetchingOlder = messageQuery.isFetchingNextPage || activityQuery.isFetchingNextPage;

  // Coverage alignment: while steps are interleaved with the conversation, keep
  // paging the activity feed (older) until it spans the loaded conversation
  // window or is exhausted. One page per settle — react-query re-renders after
  // each page and this re-evaluates, so the chain self-terminates once the
  // oldest loaded activity reaches the oldest loaded message. The prepended older
  // steps are position-preserved by the scroll controller (this counts as an
  // older-page fetch through `isFetchingOlder`).
  const autoFetchActivity = activityQuery.fetchNextPage;
  useEffect(() => {
    if (!interleaving || activityCoversMessages) return;
    if (!activityQuery.hasNextPage || activityQuery.isFetchingNextPage) return;
    void autoFetchActivity();
  }, [
    interleaving,
    activityCoversMessages,
    activityQuery.hasNextPage,
    activityQuery.isFetchingNextPage,
    autoFetchActivity,
  ]);

  const pageCount =
    (messageQuery.data?.pages.length ?? 0) + (activityQuery.data?.pages.length ?? 0);

  // The feed is still "settling" after a (re)load while its newest rows or
  // coverage are still arriving: an initial layer is loading, an activity page
  // is in flight, or coverage alignment still has older activity pages to fetch.
  const feedSettling =
    loadingActivities ||
    activityQuery.isFetchingNextPage ||
    (interleaving && !activityCoversMessages && !!activityQuery.hasNextPage);

  // Reveal-settle is stricter than feedSettling: it also waits for the initial
  // activity (step) layer, so the timeline doesn't fade in on the message-only
  // layout and then visibly pop when the first activity page lands with its step
  // folds / default-open height. The scroll controller holds the timeline hidden
  // and pinned to the bottom until this clears (bounded by its own safety valve).
  const revealSettling =
    feedSettling ||
    activityQuery.isLoading ||
    (!activitiesData && activityQuery.isFetching);

  // A signal that changes whenever loaded content grows. The scroll controller's
  // no-ResizeObserver fallback keys its bottom-follow on this; with RO present
  // (the norm) the observer drives growth and this is inert.
  const contentGrowthKey = [
    pageCount,
    latestMessageKey ?? '',
    currentItemId ?? '',
    latestCurrentItemActivity?.createdAt ?? '',
    feedSettling ? 1 : 0,
  ].join('|');

  // --- Scroll controller: the single owner of the timeline scroll position. --
  // Replaces the earlier tangle of independent scroll effects. It follows the
  // bottom when the user is there, never yanks a scrolled-up reader, preserves
  // the viewport on older-page prepends, and holds the timeline hidden until the
  // initial settle reaches a stable bottom. See useStickToBottom for the mode
  // model; the container carries `overflow-anchor: none` so every scroll write
  // is hook-owned.
  const { revealed: feedRevealed } = useStickToBottom({
    containerRef: scrollContainerRef,
    contentRef,
    feedKey: agentId ?? null,
    settling: revealSettling,
    isFetchingOlder,
    contentKey: contentGrowthKey,
    onReachTop: fetchOlder,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      {showHelloBanner && <FeishuHelloBanner onDismiss={dismissHelloBanner} />}
      {showRecommendedPermissionsConnectBanner && (
        <FeishuRecommendedPermissionsConnectBanner
          authUrl={feishuScopeStatus?.recommended.authUrl}
          authUrls={feishuScopeStatus?.recommended.authUrls}
          onDismiss={dismissRecommendedPermissionsBanner}
        />
      )}
      {error && (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-health-error/30 bg-health-error-soft px-4 py-2 text-health-error">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 font-mono text-[11px] leading-snug">Could not load activity</span>
        </div>
      )}

      <ActivityStatusSummary status={currentStatus} latestActivity={latestCurrentItemActivity} now={now} />

      <div
        ref={scrollContainerRef}
        className={`flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none] px-4 pt-3 pb-[calc(64px+env(safe-area-inset-bottom))] transition-opacity duration-200 ease-out motion-reduce:transition-none md:px-10 md:pt-5 md:pb-10 ${
          feedRevealed ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* contentRef wraps the scrolling content so the ResizeObserver above can
            watch its height and hold the bottom while the settle-pin is active. A
            plain static wrapper — it does not become a scroll/containing block, so
            the sticky day headers still resolve to the scroll container. */}
        <div ref={contentRef}>
        {/* Load-more indicator: shown at the very top while fetching an older page */}
        {isFetchingOlder && (
          <div className="flex justify-center py-3">
            <Loader2
              className="h-3.5 w-3.5 animate-spin text-text-subtle"
              aria-label="Loading older activity"
            />
          </div>
        )}
        {stepCoverageFloorTs !== null && !showFirstRunHero && filteredItems.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-prose items-start gap-2 rounded-md border border-border-soft bg-surface-raised/40 px-3 py-2 text-[11px] leading-snug text-text-muted">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-text-subtle" />
            <span>
              Tool steps load back to {dateLabel(new Date(stepCoverageFloorTs).toISOString())}.
              Messages older than that show without tool steps, because the activity history does
              not reach further back.
            </span>
          </div>
        )}
        {showFirstRunHero ? (
          <FirstRunHero agentName={agent?.profile?.displayName} platform={heroPlatform!} />
        ) : (
          timelineByDay.length === 0 && (
            <div className="mt-20 text-center">
              <p className="font-serif italic text-[15px] text-text-subtle">
                {loadingActivities ? 'Loading activity...' : 'No activity yet.'}
              </p>
            </div>
          )
        )}
        {timelineByDay.length > 0 &&
          !showFirstRunHero &&
          timelineByDay.map(([day, entries]) => {
            // Walk the day's chronological entries. Consecutive conversation
            // specials accumulate into a run (author-grouped); a fold or a
            // lifecycle line flushes the run and renders in its own time slot.
            // A fold keeps steps subordinate to an anchor (a conversation row or
            // a promoted lifecycle line). On a day with no anchor at all — a
            // collapsed fold is the *only* thing in the slot — it reads as an
            // empty stub, so there the steps ARE the content and we default the
            // day's folds open. A quiet memory-coherence day now anchors on its
            // own lifecycle line (the pass is promoted to special), so it keeps
            // the line visible with the wrapped steps folded beneath. Toggling
            // still works (XOR below); conversation days keep steps folded.
            const dayHasAnchor = entries.some(
              (e) => e.type === 'conv' || e.type === 'lifecycle',
            );
            const foldsDefaultOpen = !dayHasAnchor;
            const out: ReactNode[] = [];
            let run: ActivityFeedItem[] = [];
            let seg = 0;
            const flush = () => {
              if (run.length === 0) return;
              out.push(
                <Fragment key={`${day}:run:${seg}`}>
                  {renderConvRun(run, `${day}:run:${seg}`)}
                </Fragment>,
              );
              run = [];
              seg += 1;
            };
            for (const entry of entries) {
              if (entry.type === 'conv') {
                run.push(entry.item);
                continue;
              }
              flush();
              if (entry.type === 'lifecycle') {
                out.push(
                  <LifecycleLineRow
                    key={`${day}:life:${entry.step.activity.activityId}`}
                    step={entry.step}
                  />,
                );
              } else {
                // The live run's trailing fold is forced open while streaming;
                // when the run completes the grid height animates it shut.
                // foldsDefaultOpen flips the toggle baseline so a no-conversation
                // day shows its steps by default (XOR: a present id means
                // "opposite of default", so the toggle still opens/closes).
                const live = entry.id === liveFoldId;
                const expanded =
                  live || expandedTurns.has(entry.id) !== foldsDefaultOpen;
                out.push(
                  <StepFold
                    key={`${day}:${entry.id}`}
                    steps={entry.steps}
                    expanded={expanded}
                    onToggle={() => toggleTurn(entry.id)}
                  />,
                );
              }
            }
            flush();
            return (
              <div key={day}>
                {/* Sticky day header (Slack-style): a lone centered date pill
                    that pins to the top of the scroll viewport while its day is
                    in view, then the next day's pill pushes it up and takes
                    over. Scoped per-day `<div>`, so it's pure CSS — no scroll
                    listener. The wrapper is transparent and pointer-events-none
                    so content scrolls visibly *under* the floating pill rather
                    than being hidden behind an opaque full-bleed band; the pill
                    carries its own bg-surface + border, so its label stays
                    legible over the moving content. */}
                <div className="pointer-events-none sticky top-0 z-10 flex justify-center py-3">
                  <DayLabelPill iso={entries[0]!.timestamp} />
                </div>
                {out}
              </div>
            );
          })}
        {/* Live run: the pulsing indicator sits at the very bottom. Once the
            turn has produced a step it nests into the same step gutter + lane as
            the streaming steps, so the pulse continues their lane and the label
            aligns under the step titles. Before any step exists it sits at the
            top-level time rail instead, so it doesn't dangle in an empty lane.
            Either way it carries a timestamp so it reads as a real timeline
            entry. It disappears the moment the run completes. */}
        {currentItemId &&
          !loadingActivities &&
          !showFirstRunHero &&
          (currentTurnHasStep ? (
            <StepGutter>
              <StepLane>
                <WorkingIndicator
                  latestActivity={latestCurrentItemActivity}
                  time={clockHM(workingTimeIso)}
                />
              </StepLane>
            </StepGutter>
          ) : (
            <WorkingIndicator
              latestActivity={latestCurrentItemActivity}
              time={clockHM(workingTimeIso)}
            />
          ))}
        <div className="h-4" aria-hidden />
        </div>
      </div>
    </div>
  );
}
