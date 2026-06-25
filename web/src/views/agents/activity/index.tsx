import { Fragment, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, Loader2, X } from 'lucide-react';
import {
  fetchAgentStatuses,
  fetchAgentActivities,
  fetchAgentFeishuScopeStatus,
  fetchAgentMessages,
  fetchAgents,
} from '@/api/agents';
import { buildActivityFeed, buildMessageFeed, type ActivityFeedItem } from '@/lib/activity-feed';
import { activityIsFailure, activityRow, isNarrativeStep } from '@/lib/activities';
import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
import { clockHM, dateKey, formatRelativeShort } from '@/lib/format';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useActivityFilters, type ActivityDir } from '@/hooks/useActivityFilters';
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
  type Author,
  type AuthorResolver,
  type SurfaceResolver,
} from '../conversation/SlackTimeline';
import { StepRow, WorkingIndicator } from './AuditRows';
import type { Activity as ActivityRecord, AgentActivityFeedEvent } from '@shared/activity';
import type { AgentFeishuScopeAuthUrl } from '@shared/agent-config';
import type { AgentMessageRecord } from '@shared/messages';
import type { AgentStatusSummary } from '@shared/snapshot';

// ---------------------------------------------------------------------------
// Mobile direction sub-filter pill (All / Inbox / Outbox).
// Desktop: lives in AgentHeader (consistent header slot).
// ---------------------------------------------------------------------------

function MobileDirPill({
  dir,
  onChange,
}: {
  dir: ActivityDir;
  onChange: (v: ActivityDir) => void;
}) {
  const base =
    'chrome px-2.5 py-1.5 text-[11px] tracking-wide rounded-sm transition-colors min-h-[36px] flex items-center';
  const active = 'bg-accent/10 text-accent font-medium';
  const inactive = 'text-text-muted hover:text-text';
  return (
    <div className="flex items-center rounded-sm border border-border-soft p-0.5">
      {(['all', 'in', 'out'] as ActivityDir[]).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={[base, dir === v ? active : inactive].join(' ')}
        >
          {v === 'all' ? 'All' : v === 'in' ? 'Inbox' : 'Outbox'}
        </button>
      ))}
    </div>
  );
}

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
type DayBlock = { type: 'msgs' | 'steps'; items: ActivityFeedItem[] };

function buildBlocks(items: ActivityFeedItem[]): DayBlock[] {
  const blocks: DayBlock[] = [];
  for (const item of items) {
    const type: DayBlock['type'] = item.kind === 'step' ? 'steps' : 'msgs';
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.items.push(item);
    else blocks.push({ type, items: [item] });
  }
  return blocks;
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
//     rows. Inherits the activity feed's 30-day retention — honest, never
//     implied to be a complete step history.
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
  const { failedOnly, dir, showToolSteps, setFailedOnly, setDir, setShowToolSteps } =
    useActivityFilters();
  const now = useNow();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // True when the user is near (or at) the bottom of the scroll container.
  const isAtBottomRef = useRef(true);
  // Scroll height snapshot taken just before a previous-page fetch so we can
  // restore the user's viewport position after the prepend.
  const prevScrollHeightRef = useRef(0);

  // The step layer is needed when the user asks for steps, OR for the failed-only
  // filter (failures are steps). Failed-only is a focused debugging filter: it
  // shows only failure steps (the conversation is hidden), matching the retired
  // lens behaviour and the filter's name.
  const stepsNeeded = showToolSteps || failedOnly;

  const messageDirection = dir === 'all' ? undefined : dir;
  // Conversation layer — always loaded (complete history, Channels-identical).
  const messageQuery = useInfiniteQuery({
    queryKey: queryKeys.agentMessages(agentId ?? '', dir),
    queryFn: ({ pageParam }) =>
      fetchAgentMessages(agentId!, { before: pageParam, direction: messageDirection, limit: 100 }),
    enabled: !!agentId,
    initialPageParam: undefined as string | undefined,
    // Forward pagination toward OLDER history: page[0] stays the newest page so a
    // poll/refetch (which rebuilds the page list from page[0] forward via
    // getNextPageParam) never drops the latest records once older history loads.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
    refetchInterval: agentId ? refetchIntervals.agentActivities : false,
  });

  // Step layer — only loaded when steps are needed.
  const activityQuery = useInfiniteQuery({
    queryKey: queryKeys.agentActivities(agentId ?? ''),
    queryFn: ({ pageParam }) => fetchAgentActivities(agentId!, 100, pageParam),
    enabled: !!agentId && stepsNeeded,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
    refetchInterval: agentId && stepsNeeded ? refetchIntervals.agentActivities : false,
  });

  const feedError = messageQuery.error ?? (stepsNeeded ? activityQuery.error : null);
  const loadingActivities =
    messageQuery.isLoading || (stepsNeeded && activityQuery.isLoading);

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

  // Conversation layer items (hidden entirely under the failed-only debug filter).
  const conversationItems = useMemo(() => {
    if (failedOnly || !messagesData) return [];
    return buildMessageFeed(messagesData).filter((item) => {
      if (!isMessageItem(item)) return false;
      if (dir === 'in' && item.kind !== 'message-in') return false;
      if (dir === 'out' && item.kind === 'message-in') return false;
      return true;
    });
  }, [messagesData, failedOnly, dir]);

  // Step layer items — curated isNarrativeStep set only (never the firehose;
  // iris-locked `795d974`). Suppress a tool's started row when its failure row is
  // present so a failed tool shows once, as the failure.
  const stepItems = useMemo(() => {
    if (!stepsNeeded || !activitiesData) return [];
    const feed = buildActivityFeed(activitiesData, false);
    const failedProviderToolIds = new Set<string>();
    for (const item of feed) {
      if (item.kind === 'step' && item.activity.type === 'tool.call.failed') {
        const pid = item.activity.payload?.['providerToolId'];
        if (typeof pid === 'string' && pid) failedProviderToolIds.add(pid);
      }
    }
    return feed.filter((item) => {
      if (item.kind !== 'step') return false;
      if (!isNarrativeStep(item.activity)) return false;
      if (item.activity.type === 'tool.call.started' && failedProviderToolIds.size > 0) {
        const pid = item.activity.payload?.['providerToolId'];
        if (typeof pid === 'string' && pid && failedProviderToolIds.has(pid)) return false;
      }
      if (failedOnly && !activityIsFailure(item.activity)) return false;
      return true;
    });
  }, [activitiesData, stepsNeeded, failedOnly]);

  // The single interleaved timeline: conversation + steps, chronological.
  const filteredItems = useMemo(() => {
    const merged = [...conversationItems, ...stepItems];
    merged.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return merged;
  }, [conversationItems, stepItems]);

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
  // empty text only when the DEFAULT, unfiltered feed is empty (a brand-new
  // agent), not when a filter (failed-only / direction) emptied the view. Needs a
  // known connected platform to phrase the invite honestly.
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
      !failedOnly &&
      dir === 'all' &&
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

  const byDay = useMemo(() => {
    const m = new Map<string, ActivityFeedItem[]>();
    for (const item of filteredItems) {
      const k = dateKey(item.timestamp);
      let list = m.get(k);
      if (!list) {
        list = [];
        m.set(k, list);
      }
      list.push(item);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredItems]);

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
    return { key: `in:${uid ?? name}`, name, initial: initialOf(name), isAgent: false };
  };
  const resolveSurface: SurfaceResolver = (item) => {
    const chip = 'surface' in item ? item.surface : undefined;
    if (!chip) return { key: '' };
    return { key: `${chip.kind}:${chip.label}`, chip };
  };

  // Track which feed we've already scrolled to the bottom for, so we only do
  // the initial-load scroll once per agent/filter navigation.
  const initialScrollFeedRef = useRef<string | null>(null);

  // --- Infinite scroll: keep pagination drivers in a ref so the scroll listener
  // stays mounted once and always reads the latest message/step page state.
  const fetchOlder = () => {
    if (messageQuery.hasNextPage && !messageQuery.isFetchingNextPage) {
      prevScrollHeightRef.current = scrollContainerRef.current?.scrollHeight ?? 0;
      void messageQuery.fetchNextPage();
    }
    if (stepsNeeded && activityQuery.hasNextPage && !activityQuery.isFetchingNextPage) {
      void activityQuery.fetchNextPage();
    }
  };
  const hasOlder = messageQuery.hasNextPage || (stepsNeeded && !!activityQuery.hasNextPage);
  const isFetchingOlder =
    messageQuery.isFetchingNextPage || (stepsNeeded && activityQuery.isFetchingNextPage);
  const paginationRef = useRef({ fetchOlder, hasOlder, isFetchingOlder });
  // Keep the ref current after each render (refs must not be written during
  // render — React Compiler lint). The scroll listener reads the latest drivers
  // through this ref, so it can stay mounted once.
  useEffect(() => {
    paginationRef.current = { fetchOlder, hasOlder, isFetchingOlder };
  });

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
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // After an older page loads, restore the scroll position so the viewport
  // doesn't jump. The delta between old and new scrollHeight equals the height
  // of newly prepended content.
  const pageCount =
    (messageQuery.data?.pages.length ?? 0) + (activityQuery.data?.pages.length ?? 0);
  useEffect(() => {
    if (prevScrollHeightRef.current === 0) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      if (delta > 0) el.scrollTop += delta;
      prevScrollHeightRef.current = 0;
    });
  }, [pageCount]);

  // Scroll to bottom when feed data first loads for this agent/filter.
  useEffect(() => {
    const feedKey = agentId ? `${agentId}:${dir}:${stepsNeeded ? 's' : 'c'}:${failedOnly ? 'f' : ''}` : null;
    const feedLoaded = failedOnly ? activitiesData : (messagesData ?? activitiesData);
    if (!feedLoaded || !feedKey || initialScrollFeedRef.current === feedKey) return;
    initialScrollFeedRef.current = feedKey;
    isAtBottomRef.current = true;
    const el = scrollContainerRef.current;
    if (!el) return;
    let inner: number;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [agentId, activitiesData, messagesData, dir, stepsNeeded, failedOnly]);

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

      {/* Mobile filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-soft px-4 py-2 md:hidden">
        <MobileDirPill dir={dir} onChange={setDir} />
        <label className="chrome inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 px-1 text-[11px] tracking-wide text-text-muted">
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => setFailedOnly(e.target.checked)}
            className="h-3 w-3 accent-[color:var(--color-accent)]"
          />
          Failed only
        </label>
        <label className="chrome inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 px-1 text-[11px] tracking-wide text-text-muted">
          <input
            type="checkbox"
            checked={showToolSteps}
            onChange={(e) => setShowToolSteps(e.target.checked)}
            className="h-3 w-3 accent-[color:var(--color-accent)]"
          />
          Show tool steps
        </label>
      </div>

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
        {showFirstRunHero ? (
          <FirstRunHero agentName={agent?.profile?.displayName} platform={heroPlatform!} />
        ) : (
          filteredItems.length === 0 && (
            <div className="mt-20 text-center">
              <p className="font-serif italic text-[15px] text-text-subtle">
                {loadingActivities
                  ? 'Loading activity...'
                  : dir !== 'all'
                    ? `No ${dir === 'in' ? 'inbox' : 'outbox'} messages yet.`
                    : failedOnly
                      ? 'No failures to show.'
                      : 'No activity yet.'}
              </p>
            </div>
          )
        )}
        {filteredItems.length > 0 &&
          !showFirstRunHero &&
          byDay.map(([day, items]) => (
            <div key={day}>
              <DayDivider iso={items[0]!.timestamp} />
              {buildBlocks(items).map((block, bi) =>
                block.type === 'msgs' ? (
                  <Fragment key={`${day}:b:${bi}`}>
                    {groupByAuthor(block.items, resolveAuthor, resolveSurface).map((group, gi) => (
                      <MessageGroupRow
                        key={`${day}:b:${bi}:${gi}`}
                        group={group}
                        agentId={agentId ?? ''}
                      />
                    ))}
                  </Fragment>
                ) : (
                  <StepLane key={`${day}:b:${bi}`}>
                    {block.items.map((item, si) => (
                      <StepRow
                        key={`${day}:b:${bi}:${si}`}
                        item={item as Extract<ActivityFeedItem, { kind: 'step' }>}
                        time={clockHM(item.timestamp)}
                      />
                    ))}
                  </StepLane>
                ),
              )}
            </div>
          ))}
        {stepsNeeded && currentItemId && !loadingActivities && (
          <WorkingIndicator latestActivity={latestCurrentItemActivity} />
        )}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
}
