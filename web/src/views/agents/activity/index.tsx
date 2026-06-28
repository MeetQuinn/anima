import {
  Fragment,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronRight, ExternalLink, Loader2, X } from 'lucide-react';
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
  DayDivider,
  MessageGroupRow,
  SystemEventRow,
  type Author,
  type AuthorResolver,
  type MessageGroup,
  type SurfaceResolver,
} from '../conversation/SlackTimeline';
import { StepRow, WorkingIndicator } from './AuditRows';
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

// Segment a day's items into maximal runs of conversation messages vs tool
// steps, preserving chronology. Message runs render as Slack groups; step runs
// render in an indented lane. A step between two message groups naturally
// breaks the grouping, which is the interleave the spec asks for.
type DayBlock = { type: 'msgs' | 'steps' | 'system'; items: ActivityFeedItem[] };

// A day's timeline is a chronological mix of conversation items and standalone
// memory-coherence passes (which are not part of any conversational turn).
type DayEntry =
  | { type: 'conv'; ts: number; timestamp: string; item: ActivityFeedItem }
  | { type: 'mem'; ts: number; timestamp: string; pass: MemoryPass };

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
// Per-turn steps — message-bound, collapsible (replaces the global toggle).
//
// Tool steps no longer live as their own interleaved rows behind a header
// toggle. Each agent turn's curated steps attach to the agent message that
// concludes the turn and tuck beneath it, collapsed by default behind a
// `▸ N steps` disclosure. Click the disclosure OR the message to expand/collapse.
// The live (running) turn's steps render under the WorkingIndicator and stay
// auto-expanded while streaming; when the turn completes its steps fold into the
// concluding message's (default-collapsed) disclosure — so completion reads as a
// quiet collapse. Failure is shown only at the step level (existing red Row
// styling), never as a message badge: routine non-zero exits stay quiet.
// ---------------------------------------------------------------------------

// Stable identity for a message group's expand state. The first item's timestamp
// + author + surface is stable across refetches for the same turn, so the
// expanded/collapsed choice survives polling; a newly concluded turn gets a fresh
// key and so defaults to collapsed (the auto-collapse-on-done behaviour).
function groupKey(group: MessageGroup): string {
  return `${group.author.key}|${group.startTs}|${group.surfaceKey}`;
}

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

// One agent turn: the message group plus its collapsible step trace. Clicking
// anywhere on the message toggles the steps too (a convenience over the
// disclosure button), except on links/buttons inside the message, which keep
// their own behaviour.
function AgentTurnRow({
  group,
  agentId,
  steps,
  expanded,
  onToggle,
}: {
  group: MessageGroup;
  agentId: string;
  steps: Extract<ActivityFeedItem, { kind: 'step' }>[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasSteps = steps.length > 0;
  const handleMessageClick = (e: ReactMouseEvent) => {
    if (!hasSteps) return;
    if ((e.target as HTMLElement).closest('a,button')) return;
    if (window.getSelection()?.toString()) return; // don't toggle on text selection
    onToggle();
  };
  return (
    <div>
      <div onClick={handleMessageClick} className={hasSteps ? 'cursor-pointer' : undefined}>
        <MessageGroupRow group={group} agentId={agentId} />
      </div>
      {hasSteps && (
        <StepGutter>
          <StepsDisclosure count={steps.length} expanded={expanded} onToggle={onToggle} />
          {expanded && <StepList steps={steps} />}
        </StepGutter>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory-coherence pass — a standalone, non-conversational entry.
//
// A scheduled memory-coherence pass is tool-only work with no outbound reply:
// the agent reads its MEMORY.md + notes, maybe writes, and records a
// `memory_coherence.outcome`. Its steps must NOT bind to the next chat reply
// (that would be false attribution). Instead each pass renders standalone at
// its own time: the outcome row (red when failed, via the existing
// activityIsFailure path) plus a `▸ N steps` disclosure for the surrounding
// reads/writes. The pass is keyed by its outcome activityId; the read/write
// steps are gathered by the outcome's [startedAt, completedAt] window.
// ---------------------------------------------------------------------------
interface MemoryPass {
  id: string;
  timestamp: string; // outcome timestamp — placement in the timeline
  ts: number; // completedAt epoch — sort key
  steps: Extract<ActivityFeedItem, { kind: 'step' }>[]; // window steps incl. the outcome
}

function MemoryPassRow({
  pass,
  expanded,
  onToggle,
}: {
  pass: MemoryPass;
  expanded: boolean;
  onToggle: () => void;
}) {
  const outcome = pass.steps.find((s) => s.activity.type === 'memory_coherence.outcome');
  const detail = pass.steps.filter((s) => s.activity.type !== 'memory_coherence.outcome');
  return (
    <StepGutter>
      {outcome && <StepRow item={outcome} time={clockHM(outcome.timestamp)} />}
      {detail.length > 0 && (
        <div>
          <StepsDisclosure count={detail.length} expanded={expanded} onToggle={onToggle} />
          {expanded && <StepList steps={detail} />}
        </div>
      )}
    </StepGutter>
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
  const bottomRef = useRef<HTMLDivElement>(null);
  // True when the user is near (or at) the bottom of the scroll container.
  const isAtBottomRef = useRef(true);
  // Scroll height snapshot taken just before a previous-page fetch so we can
  // restore the user's viewport position after the prepend.
  const prevScrollHeightRef = useRef(0);
  // While true, keep the viewport pinned to the newest row as the feed settles
  // after a filter/toggle change (activity steps page in, coverage aligns). Set
  // when a new feed is first shown; released once the feed settles or the user
  // scrolls away from the bottom. Without it, toggling Show tool steps would
  // scroll to the conversation's bottom before the newest steps (activity
  // page[0], some newer than the last message) finish loading, stranding the
  // viewport above the true newest row.
  const bottomPinUntilSettleRef = useRef(false);

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

  // Step layer — always loaded now (steps are per-turn, always available behind
  // a collapsed disclosure rather than a global toggle). The conversation is
  // still primary: an activity error or slow load never blocks or blanks the
  // message timeline (feedError / loadingActivities track the conversation only);
  // steps simply populate the disclosures as they arrive.
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

  // Step layer items — curated isNarrativeStep set only (never the firehose;
  // iris-locked `795d974`). Suppress a tool's started row when its failure row is
  // present so a failed tool shows once, as the failure. These no longer render
  // as their own timeline rows; they attach to the agent turn that concluded them
  // (see stepsByTurn).
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

  // Pull scheduled memory-coherence passes out of the conversational stream. Each
  // `memory_coherence.outcome` defines a [startedAt, completedAt] window; every
  // narrative step in that window (the reads/writes + the outcome) belongs to the
  // pass, not to any chat turn. These steps are CLAIMED so the turn sweep below
  // never attaches them to a later outbound reply (the false-attribution bug). A
  // memory pass runs as its own runtime item, so no conversational turn overlaps
  // its window — claiming the whole window is safe.
  const { memoryPasses, claimedSteps } = useMemo(() => {
    const passes: MemoryPass[] = [];
    const claimed = new Set<ActivityFeedItem>();
    const outcomes = stepItems.filter((s) => s.activity.type === 'memory_coherence.outcome');
    if (outcomes.length === 0) return { memoryPasses: passes, claimedSteps: claimed };
    const sorted = [...stepItems].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    for (const outcome of outcomes) {
      const payload = outcome.activity.payload as
        | { startedAt?: string; completedAt?: string }
        | undefined;
      const outcomeTs = Date.parse(outcome.timestamp);
      const startMs = Date.parse(payload?.startedAt ?? outcome.timestamp);
      const endMs = Date.parse(payload?.completedAt ?? outcome.timestamp);
      const lo = Number.isFinite(startMs) ? startMs : outcomeTs;
      const hi = Number.isFinite(endMs) ? endMs : outcomeTs;
      const windowSteps: Extract<ActivityFeedItem, { kind: 'step' }>[] = [];
      for (const s of sorted) {
        if (s === outcome || claimed.has(s)) continue;
        // Each outcome is its own pass; never fold one pass's outcome into another.
        if (s.activity.type === 'memory_coherence.outcome') continue;
        const ts = Date.parse(s.timestamp);
        if (Number.isFinite(ts) && ts >= lo && ts <= hi) {
          windowSteps.push(s);
          claimed.add(s);
        }
      }
      claimed.add(outcome);
      passes.push({
        id: `mem:${outcome.activity.activityId}`,
        timestamp: outcome.timestamp,
        ts: Number.isFinite(hi) ? hi : outcomeTs,
        steps: [...windowSteps, outcome].sort(
          (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
        ),
      });
    }
    return { memoryPasses: passes, claimedSteps: claimed };
  }, [stepItems]);

  // Bind each step to the agent turn it belongs to. Steps carry no turn id, so we
  // attach each step to the first agent OUTBOUND item at or after the step's time
  // (the reply that concluded that stretch of work) — the inbound→steps→reply
  // shape the timeline reads as. Steps after the last outbound item are
  // "trailing": the live running turn (no reply yet) or a completed tool-only
  // turn. We key the per-turn map by the outbound item reference so a message
  // group can gather the steps of all its outbound items.
  const { stepsByItem, trailingSteps } = useMemo(() => {
    const outbound = conversationItems
      .filter(
        (it) =>
          it.kind === 'message-out' || it.kind === 'file-out' || it.kind === 'reaction-out',
      )
      .map((it) => ({ it, ts: Date.parse(it.timestamp) }))
      .filter((x) => Number.isFinite(x.ts))
      .sort((a, b) => a.ts - b.ts);
    const map = new Map<ActivityFeedItem, Extract<ActivityFeedItem, { kind: 'step' }>[]>();
    const trailing: Extract<ActivityFeedItem, { kind: 'step' }>[] = [];
    // Skip steps claimed by a standalone memory-coherence pass — they render in
    // their own entry, never under a chat reply.
    const steps = stepItems
      .filter((s) => !claimedSteps.has(s))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    let oi = 0;
    for (const step of steps) {
      const sts = Date.parse(step.timestamp);
      if (!Number.isFinite(sts)) continue;
      while (oi < outbound.length && outbound[oi]!.ts < sts) oi += 1;
      if (oi < outbound.length) {
        const target = outbound[oi]!.it;
        const arr = map.get(target);
        if (arr) arr.push(step);
        else map.set(target, [step]);
      } else {
        trailing.push(step);
      }
    }
    return { stepsByItem: map, trailingSteps: trailing };
  }, [conversationItems, stepItems, claimedSteps]);

  // The rendered timeline is the conversation, chronological. Steps live inside
  // the agent turns (stepsByItem) and at the bottom (trailingSteps), not as rows.
  const filteredItems = useMemo(() => {
    return [...conversationItems].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
  }, [conversationItems]);

  // --- Coverage alignment (honesty contract) --------------------------------
  // The conversation feed (messages store) and the step feed (activity store)
  // paginate independently by count, so their loaded time-windows can diverge:
  // the newest 100 activity events may span only hours while the newest 100
  // messages span days. Left unaligned, older visible messages would render with
  // no adjacent steps and read as "nothing happened" when the steps simply were
  // not paged in. Steps are always available now (per-turn disclosures), so we
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
      memoryPasses.length === 0 &&
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

  // Day buckets carry a chronological mix of conversation items and standalone
  // memory-coherence passes. Within a day, conversation entries flow through the
  // message-group renderer; a memory pass breaks the run and renders on its own.
  const byDay = useMemo(() => {
    const m = new Map<string, DayEntry[]>();
    const push = (k: string, e: DayEntry) => {
      let list = m.get(k);
      if (!list) {
        list = [];
        m.set(k, list);
      }
      list.push(e);
    };
    for (const item of filteredItems) {
      push(dateKey(item.timestamp), {
        type: 'conv',
        ts: Date.parse(item.timestamp),
        timestamp: item.timestamp,
        item,
      });
    }
    for (const pass of memoryPasses) {
      push(dateKey(pass.timestamp), {
        type: 'mem',
        ts: pass.ts,
        timestamp: pass.timestamp,
        pass,
      });
    }
    for (const list of m.values()) list.sort((a, b) => a.ts - b.ts);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredItems, memoryPasses]);

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

  // Render a chronological run of conversation items (no memory passes) into
  // system rows + author-grouped message/agent-turn rows. Factored out so a day
  // can render multiple runs split by interleaved standalone memory passes.
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
      // Conversation messages. Agent turns gather their bound steps into a
      // collapsible disclosure; inbound groups render plain.
      return (
        <Fragment key={`${keyPrefix}:b:${bi}`}>
          {groupByAuthor(block.items, resolveAuthor, resolveSurface).map((group, gi) => {
            if (!group.author.isAgent) {
              return (
                <MessageGroupRow
                  key={`${keyPrefix}:b:${bi}:${gi}`}
                  group={group}
                  agentId={agentId ?? ''}
                />
              );
            }
            const turnSteps = group.items.flatMap(({ item }) => stepsByItem.get(item) ?? []);
            const key = groupKey(group);
            return (
              <AgentTurnRow
                key={`${keyPrefix}:b:${bi}:${gi}`}
                group={group}
                agentId={agentId ?? ''}
                steps={turnSteps}
                expanded={expandedTurns.has(key)}
                onToggle={() => toggleTurn(key)}
              />
            );
          })}
        </Fragment>
      );
    });

  // Track which feed we've already scrolled to the bottom for, so we only do
  // the initial-load scroll once per agent/filter navigation.
  const initialScrollFeedRef = useRef<string | null>(null);

  // --- Infinite scroll: keep pagination drivers in a ref so the scroll listener
  // stays mounted once and always reads the latest message/step page state.
  // Snapshot scroll height just before ANY older-page fetch (message OR
  // activity) so the post-prepend restore keeps the viewport pinned. Guarded so
  // a message + activity fetch that fire together don't clobber the baseline.
  const snapshotScrollHeight = () => {
    if (prevScrollHeightRef.current === 0) {
      prevScrollHeightRef.current = scrollContainerRef.current?.scrollHeight ?? 0;
    }
  };
  const fetchOlder = () => {
    if (messageQuery.hasNextPage && !messageQuery.isFetchingNextPage) {
      snapshotScrollHeight();
      void messageQuery.fetchNextPage();
    }
    if (activityQuery.hasNextPage && !activityQuery.isFetchingNextPage) {
      snapshotScrollHeight();
      void activityQuery.fetchNextPage();
    }
  };
  const hasOlder = messageQuery.hasNextPage || !!activityQuery.hasNextPage;
  const isFetchingOlder = messageQuery.isFetchingNextPage || activityQuery.isFetchingNextPage;
  const paginationRef = useRef({ fetchOlder, hasOlder, isFetchingOlder });
  // Keep the ref current after each render (refs must not be written during
  // render — React Compiler lint). The scroll listener reads the latest drivers
  // through this ref, so it can stay mounted once.
  useEffect(() => {
    paginationRef.current = { fetchOlder, hasOlder, isFetchingOlder };
  });

  // Coverage alignment: while steps are interleaved with the conversation, keep
  // paging the activity feed (older) until it spans the loaded conversation
  // window or is exhausted. One page per settle — react-query re-renders after
  // each page and this re-evaluates, so the chain self-terminates once the
  // oldest loaded activity reaches the oldest loaded message. Snapshot first so
  // the prepended older steps don't shift the viewport.
  const autoFetchActivity = activityQuery.fetchNextPage;
  useEffect(() => {
    if (!interleaving || activityCoversMessages) return;
    if (!activityQuery.hasNextPage || activityQuery.isFetchingNextPage) return;
    if (prevScrollHeightRef.current === 0) {
      prevScrollHeightRef.current = scrollContainerRef.current?.scrollHeight ?? 0;
    }
    void autoFetchActivity();
  }, [
    interleaving,
    activityCoversMessages,
    activityQuery.hasNextPage,
    activityQuery.isFetchingNextPage,
    autoFetchActivity,
  ]);

  // Keep isAtBottomRef in sync as the user scrolls; trigger an older-page fetch
  // when the user reaches the top. Mounted once — reads latest via the ref.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const BOTTOM_THRESHOLD = 80;
    const TOP_THRESHOLD = 100;
    function handleScroll() {
      isAtBottomRef.current = el!.scrollHeight - el!.scrollTop - el!.clientHeight < BOTTOM_THRESHOLD;
      const { hasOlder: more, isFetchingOlder: busy, fetchOlder: load } = paginationRef.current;
      if (el!.scrollTop < TOP_THRESHOLD && more && !busy) load();
    }
    // A deliberate wheel/touch gesture means the user is taking over scrolling,
    // so drop the post-toggle bottom-pin (stop forcing them to the newest row).
    // We use the gesture, not a derived "not at bottom" check, because coverage
    // prepends fire scroll events that would momentarily read as not-at-bottom
    // and release the pin before the feed has settled.
    function releasePin() {
      bottomPinUntilSettleRef.current = false;
    }
    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('wheel', releasePin, { passive: true });
    el.addEventListener('touchstart', releasePin, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('wheel', releasePin);
      el.removeEventListener('touchstart', releasePin);
    };
  }, []);

  // After an older page loads, restore the scroll position so the viewport
  // doesn't jump. The delta between old and new scrollHeight equals the height
  // of newly prepended content.
  const pageCount =
    (messageQuery.data?.pages.length ?? 0) + (activityQuery.data?.pages.length ?? 0);

  // The feed is still "settling" after a (re)load while its newest rows or
  // coverage are still arriving: an initial layer is loading, an activity page
  // is in flight, or coverage alignment still has older activity pages to
  // fetch. Drives how long the post-toggle bottom-pin stays active.
  const feedSettling =
    loadingActivities ||
    activityQuery.isFetchingNextPage ||
    (interleaving && !activityCoversMessages && !!activityQuery.hasNextPage);

  useEffect(() => {
    // While the post-toggle bottom-pin is active it owns the scroll position
    // (it forces the newest row into view), so skip the prepend anchor to avoid
    // a tug-of-war, and clear any height snapshot a coverage fetch left behind
    // so a later (post-pin) prepend doesn't restore against a stale baseline.
    if (bottomPinUntilSettleRef.current) {
      prevScrollHeightRef.current = 0;
      return;
    }
    if (prevScrollHeightRef.current === 0) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      if (delta > 0) el.scrollTop += delta;
      prevScrollHeightRef.current = 0;
    });
  }, [pageCount]);

  // When a new feed (agent) is first shown, pin to the newest row and keep it
  // pinned while the feed settles (see the pin effect below). Fires once per
  // feed identity.
  useEffect(() => {
    const feedKey = agentId ?? null;
    const feedLoaded = messagesData ?? activitiesData;
    if (!feedLoaded || !feedKey || initialScrollFeedRef.current === feedKey) return;
    initialScrollFeedRef.current = feedKey;
    isAtBottomRef.current = true;
    bottomPinUntilSettleRef.current = true;
  }, [agentId, activitiesData, messagesData]);

  // Bottom-pin: while active, the pin owns the scroll position. Force the newest
  // row into view on every content or settle change so late-arriving newest
  // steps (activity page[0]) and coverage prepends never strand the viewport
  // above the true bottom. Release only when the feed settles (one final scroll
  // included) or the user takes over via a wheel/touch gesture (see the mount
  // effect). We deliberately do NOT release on isAtBottomRef: coverage prepends
  // briefly read as "not at bottom" and would drop the pin mid-settle.
  useEffect(() => {
    if (!bottomPinUntilSettleRef.current) return;
    const settledNow = !feedSettling;
    const el = scrollContainerRef.current;
    if (el) {
      requestAnimationFrame(() => {
        const node = scrollContainerRef.current;
        if (node && (bottomPinUntilSettleRef.current || settledNow)) {
          node.scrollTop = node.scrollHeight;
        }
      });
    }
    if (settledNow) bottomPinUntilSettleRef.current = false;
  }, [activitiesData, messagesData, pageCount, feedSettling]);

  // Always scroll to bottom when new work starts.
  useEffect(() => {
    if (!currentItemId) return;
    isAtBottomRef.current = true;
    const el = scrollContainerRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [currentItemId]);

  // Sticky scroll: follow live activity only when already at the bottom.
  useEffect(() => {
    if (!latestCurrentItemActivity || !isAtBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [latestCurrentItemActivity]);

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
        className="flex-1 overflow-x-hidden overflow-y-auto px-4 pt-3 pb-[calc(64px+env(safe-area-inset-bottom))] md:px-10 md:pt-5 md:pb-10"
      >
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
          byDay.length === 0 && (
            <div className="mt-20 text-center">
              <p className="font-serif italic text-[15px] text-text-subtle">
                {loadingActivities ? 'Loading activity...' : 'No activity yet.'}
              </p>
            </div>
          )
        )}
        {byDay.length > 0 &&
          !showFirstRunHero &&
          byDay.map(([day, entries]) => {
            // Walk the day's chronological entries, flushing accumulated
            // conversation items into a run whenever a standalone memory pass
            // interrupts, so passes never merge into a conversational group.
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
              } else {
                flush();
                out.push(
                  <MemoryPassRow
                    key={`${day}:${entry.pass.id}`}
                    pass={entry.pass}
                    expanded={expandedTurns.has(entry.pass.id)}
                    onToggle={() => toggleTurn(entry.pass.id)}
                  />,
                );
              }
            }
            flush();
            return (
              <div key={day}>
                <DayDivider iso={entries[0]!.timestamp} />
                {out}
              </div>
            );
          })}
        {/* Completed trailing steps with no concluding reply (rare: a tool-only
            turn). Not live, so keep them quiet behind a collapsed disclosure
            rather than lost. */}
        {!currentItemId && trailingSteps.length > 0 && !showFirstRunHero && (
          <StepGutter>
            <StepsDisclosure
              count={trailingSteps.length}
              expanded={expandedTurns.has('__trailing__')}
              onToggle={() => toggleTurn('__trailing__')}
            />
            {expandedTurns.has('__trailing__') && <StepList steps={trailingSteps} />}
          </StepGutter>
        )}
        {/* Live turn: indicator + its streaming steps, auto-expanded. When the
            turn completes its steps fold into the concluding message's
            (collapsed) disclosure — completion reads as a quiet collapse. */}
        {currentItemId && !loadingActivities && !showFirstRunHero && (
          <>
            <WorkingIndicator latestActivity={latestCurrentItemActivity} />
            {trailingSteps.length > 0 && (
              <StepGutter>
                <StepList steps={trailingSteps} />
              </StepGutter>
            )}
          </>
        )}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
}
