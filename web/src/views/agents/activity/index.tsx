import { useEffect, useMemo, useReducer, useRef } from 'react';
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
import { clockHM, dateKey, formatRelativeShort } from '@/lib/format';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import {
  applyLensOverride,
  clearLensOverride,
  useActivityFilters,
  type ActivityLens,
  type ActivityDir,
} from '@/hooks/useActivityFilters';
import { useNow } from '@/hooks/useNow';
import {
  agentHealthDegradedText,
  agentHealthReasonText,
  agentHealthRecoveredFresh,
} from '@/components/AgentHealthIndicator';
import { MessageInRow, MessageOutRow, FileOutRow } from './MessageRows';
import { ReactOutRow, StepRow, WorkingIndicator, DaySection } from './AuditRows';
import type { Activity as ActivityRecord, AgentActivityFeedEvent } from '@shared/activity';
import type { AgentFeishuScopeAuthUrl } from '@shared/agent-config';
import type { AgentMessageRecord } from '@shared/messages';
import type { AgentStatusSummary } from '@shared/snapshot';

// ---------------------------------------------------------------------------
// Mobile direction sub-filter pill (All / Inbox / Outbox).
// Desktop: lives in AgentHeader next to the lens pill (consistent header slot).
// ---------------------------------------------------------------------------

function MobileDirPill({
  dir,
  onChange,
}: {
  dir: ActivityDir;
  onChange: (v: ActivityDir) => void;
}) {
  const base = 'chrome px-2.5 py-1.5 text-[11px] tracking-wide rounded-sm transition-colors min-h-[36px] flex items-center';
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
// LensPill — mobile lens toggle (mirrors desktop AgentHeader version)
// ---------------------------------------------------------------------------

function MobileLensPill({
  lens,
  onChange,
}: {
  lens: ActivityLens;
  onChange: (v: ActivityLens) => void;
}) {
  const base = 'chrome px-2.5 py-1.5 text-[11px] tracking-wide rounded-sm transition-colors min-h-[36px] flex items-center';
  const active = 'bg-accent/10 text-accent font-medium';
  const inactive = 'text-text-muted hover:text-text';
  return (
    <div className="flex items-center rounded-sm border border-border-soft p-0.5">
      <button
        type="button"
        onClick={() => onChange('messages')}
        className={[base, lens === 'messages' ? active : inactive].join(' ')}
      >
        Conversation
      </button>
      <button
        type="button"
        onClick={() => onChange('activity')}
        className={[base, lens === 'activity' ? active : inactive].join(' ')}
      >
        Activity
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMessageItem(item: ActivityFeedItem): boolean {
  return (
    item.kind === 'message-in' ||
    item.kind === 'message-out' ||
    item.kind === 'file-out' ||
    item.kind === 'reaction-out'
  );
}

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
        ? health?.reason === 'restart_pending' ? 'Restarting' : 'Starting'
        : degraded
          ? 'Retrying'
          : unknown
            ? 'Health unavailable'
            : running ? 'Working' : queued ? 'Queued' : 'Idle';
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
  const latest = latestActivity && isNarrativeStep(latestActivity)
    ? activityRow(latestActivity)
    : undefined;

  return (
    <div className="shrink-0 border-b border-border-soft bg-surface-raised/30 px-4 py-2 md:px-10">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="chrome flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: dot }} />
          {state}
        </span>
        {reason && (
          <span className={['font-sans text-[11px]', unhealthy ? 'text-health-error' : 'text-text-muted'].join(' ')}>
            {reason}
          </span>
        )}
        {!unhealthy && !recovered && running && status.currentItemStartedAt && (
          <span className="font-sans text-[11px] text-text-subtle">
            started {formatRelativeShort(status.currentItemStartedAt, now)}
          </span>
        )}
        {queued && (
          <span className="font-sans text-[11px] text-text-subtle">
            {status.queueDepth} queued
          </span>
        )}
        {latest && (
          <span className="min-w-0 flex-1 basis-64 truncate font-sans text-[11px] text-text-muted">
            latest: {latest.title}{latest.target ? ` · ${latest.target}` : ''}
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

function FirstRunHero({
  agentName,
  platform,
}: {
  agentName?: string;
  platform: 'feishu' | 'slack';
}) {
  const platformLabel = platform === 'feishu' ? 'Feishu' : 'Slack';
  return (
    <div className="mt-20 flex flex-col items-center px-6 text-center animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none">
      <span className="relative mb-5 flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-activity-outbound opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-activity-outbound" />
      </span>
      <p className="font-serif text-[19px] leading-tight text-text">Your agent is live.</p>
      <p className="mt-1.5 font-serif text-[15px] leading-snug text-text-muted">
        Say hi to{' '}
        {agentName ? <span className="font-medium text-text">{agentName}</span> : 'it'} in{' '}
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
// Activity view
// ---------------------------------------------------------------------------

export default function Activity() {
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const { data: agentStatuses = [] } = useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
    refetchInterval: refetchIntervals.agentStatuses,
  });
  const { agentId } = useParams<{ agentId: string }>();
  const [searchParams] = useSearchParams();
  // Dev-only, side-effect-free preview of the first-run hero for screenshots /
  // on-render review (?_previewFirstRunHero=feishu|slack). Never honored in prod.
  const previewFirstRunHero = import.meta.env.DEV
    ? ((searchParams.get('_previewFirstRunHero') as 'feishu' | 'slack' | null) ?? undefined)
    : undefined;
  const { failedOnly, lens, dir, showAllSteps, setFailedOnly, setLens, setDir, setShowAllSteps } = useActivityFilters();
  const now = useNow();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // True when the user is near (or at) the bottom of the scroll container.
  const isAtBottomRef = useRef(true);
  // Scroll height snapshot taken just before a previous-page fetch so we can
  // restore the user's viewport position after the prepend.
  const prevScrollHeightRef = useRef(0);

  const activityQuery = useInfiniteQuery({
    queryKey: queryKeys.agentActivities(agentId ?? ''),
    queryFn: ({ pageParam }) => fetchAgentActivities(agentId!, 100, pageParam),
    enabled: !!agentId && lens === 'activity',
    initialPageParam: undefined as string | undefined,
    // Forward pagination toward OLDER history. page[0] is always the newest
    // page (initialPageParam undefined); each page's nextCursor is the ISO
    // timestamp of its oldest activity, so getNextPageParam loads the page of
    // older activities that comes after it. We deliberately do NOT use
    // getPreviousPageParam: on a poll/refetch react-query rebuilds the page
    // list starting from page[0] and walking forward via getNextPageParam. If
    // the newest page were not page[0], that walk would drop every page it
    // can't reach, silently discarding the latest logs once the user has
    // loaded older history. Display order is timestamp-sorted downstream, so
    // array order has no effect on what the user sees.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
    refetchInterval: agentId ? refetchIntervals.agentActivities : false,
  });
  const messageDirection = dir === 'all' ? undefined : dir;
  const messageQuery = useInfiniteQuery({
    queryKey: queryKeys.agentMessages(agentId ?? '', dir),
    queryFn: ({ pageParam }) => fetchAgentMessages(agentId!, {
      before: pageParam,
      direction: messageDirection,
      limit: 100,
    }),
    enabled: !!agentId && lens === 'messages',
    initialPageParam: undefined as string | undefined,
    // Same forward-toward-older pagination as the activity query above, for the
    // same refetch-reconstruction reason. page[0] stays the newest page.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
    refetchInterval: agentId ? refetchIntervals.agentActivities : false,
  });
  const activitiesError = lens === 'messages' ? messageQuery.error : activityQuery.error;
  const loadingActivities = lens === 'messages' ? messageQuery.isLoading : activityQuery.isLoading;
  // "Older history" maps to react-query's forward (next) direction — see the
  // pagination comment on activityQuery above.
  const fetchOlder = lens === 'messages' ? messageQuery.fetchNextPage : activityQuery.fetchNextPage;
  const hasOlder = lens === 'messages' ? messageQuery.hasNextPage : activityQuery.hasNextPage;
  const isFetchingOlder = lens === 'messages'
    ? messageQuery.isFetchingNextPage
    : activityQuery.isFetchingNextPage;

  // Merge all loaded pages into a single feed page.
  // Feed events are deduplicated by their source IDs so that the
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
    return {
      events: Array.from(eventMap.values()),
    };
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

  // Build the feed. In Activity lens, showAllSteps controls whether hidden
  // lifecycle plumbing (HIDDEN_TYPES) is included — same as the old
  // showHidden param. Messages lens always builds full (comms items are
  // never in HIDDEN_TYPES, so it makes no difference, but full is correct).
  const activityFeed = useMemo(
    () => {
      if (lens === 'messages') return messagesData ? buildMessageFeed(messagesData) : [];
      return activitiesData ? buildActivityFeed(activitiesData, showAllSteps) : [];
    },
    [activitiesData, messagesData, lens, showAllSteps],
  );

  const filteredItems = useMemo(() => {
    if (lens === 'messages') {
      // Messages lens: communication rows only, direction sub-filter applied.
      return activityFeed.filter((item) => {
        if (!isMessageItem(item)) return false;
        if (dir === 'in' && item.kind !== 'message-in') return false;
        if (dir === 'out' && item.kind === 'message-in') return false;
        return true;
      });
    }

    // Activity lens — curated (showAllSteps=false) or full firehose (showAllSteps=true).
    if (!showAllSteps) {
      // Curated view: restore the pre-30d71f3 isNarrativeStep filter.
      // Collect failed tool providerToolIds so we can suppress the matching
      // started row (only the failure row should show, not both).
      const failedProviderToolIds = new Set<string>();
      for (const item of activityFeed) {
        if (item.kind === 'step' && item.activity.type === 'tool.call.failed') {
          const pid = item.activity.payload?.['providerToolId'];
          if (typeof pid === 'string' && pid) failedProviderToolIds.add(pid);
        }
      }
      return activityFeed.filter((item) => {
        if (item.kind === 'step') {
          if (!isNarrativeStep(item.activity)) return false;
          if (item.activity.type === 'tool.call.started' && failedProviderToolIds.size > 0) {
            const pid = item.activity.payload?.['providerToolId'];
            if (typeof pid === 'string' && pid && failedProviderToolIds.has(pid)) return false;
          }
        }
        if (failedOnly && (item.kind !== 'step' || !activityIsFailure(item.activity))) return false;
        return true;
      });
    }

    // Full firehose (showAllSteps=true): everything, with optional failed-only filter.
    return activityFeed.filter((item) => {
      if (failedOnly && (item.kind !== 'step' || !activityIsFailure(item.activity))) return false;
      return true;
    });
  }, [activityFeed, lens, dir, failedOnly, showAllSteps]);

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
  // agent), not when a filter (failed-only / direction) emptied the view — those
  // keep their own specific "no matches" copy. Needs a known connected platform
  // to phrase the invite ("in Feishu" / "in Slack") honestly; absent it, fall
  // back to the plain empty text.
  const agent = agents.find((a) => a.id === agentId);
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
      !(lens === 'messages' && dir !== 'all') &&
      connectedPlatform !== undefined);

  // --- Post-onboarding first landing -----------------------------------------
  // A fresh Feishu connect navigates here with router state:
  //   { onboardingConnected: 'feishu', feishuGreetingBanner?: boolean }
  // On that arrival we (a) force the activity view regardless of the user's
  // stored lens preference — the "agent is alive" payoff — without persisting
  // that override, and (b) arm the one-time greeting banner, but ONLY when the
  // app was auto-registered (feishuGreetingBanner true). The manual existing-app
  // path has no owner open_id and is left ungreeted (#154), so it jumps to the
  // activity view but shows no "say hi" promise.
  //
  // The signal is read from the *current* location every render and consumed via
  // a route-keyed effect, NOT captured at mount: React Router reuses this Activity
  // component when the user creates another agent from an existing activity page,
  // so a mount-only read would miss the freshly arrived state.
  const location = useLocation();
  const navigate = useNavigate();
  const landingState = location.state as
    | { onboardingConnected?: 'feishu' | 'slack'; feishuGreetingBanner?: boolean }
    | null;
  const justConnectedFeishu = landingState?.onboardingConnected === 'feishu';
  const landingWantsBanner = justConnectedFeishu && landingState?.feishuGreetingBanner === true;

  // Force the activity lens for any fresh connect landing (auto or manual).
  // applyLensOverride is idempotent and non-persisting.
  useEffect(() => {
    if (justConnectedFeishu) applyLensOverride('activity');
  }, [location.key, justConnectedFeishu]);

  // The transient override applies only to the agent we landed on; drop it when
  // the user navigates to a different agent (the route stays mounted across param
  // changes) or leaves the activity view entirely.
  useEffect(() => clearLensOverride, [agentId]);

  // --- One-time "say hi in Feishu" banner ------------------------------------
  // Dismissal is permanent and keyed to the connection (appId), so a fresh
  // reconnect can legitimately show it again, but within one connection it is
  // one-shot. The banner is decoupled from the async greeting: it never blocks
  // and never claims the hello already happened.
  const previewHelloBanner = import.meta.env.DEV && searchParams.get('_previewHelloBanner') === '1';
  const feishuConnKey = agent?.feishu?.connected
    ? (agent.feishu.appId?.trim() || 'connected')
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
    // Wait for the appId; the effect re-fires when feishuConnKey resolves. The
    // recommended-permissions banner is keyed to the connection, including manual
    // existing-app connects where the greeting banner is intentionally absent.
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
    // Consume the signal so a reload / back-navigation never replays it. The
    // navigate re-renders, so the render-body read below picks up the new arm.
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

  const error = activitiesError instanceof Error ? activitiesError.message : activitiesError ? String(activitiesError) : null;

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

  // Track which feed we've already scrolled to the bottom for, so we only do
  // the initial-load scroll once per agent/lens/filter navigation.
  const initialScrollFeedRef = useRef<string | null>(null);

  // Keep isAtBottomRef in sync as the user scrolls. Also trigger a previous-page
  // fetch when the user reaches the top of the container.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const BOTTOM_THRESHOLD = 80;
    const TOP_THRESHOLD = 100;
    function handleScroll() {
      isAtBottomRef.current = el!.scrollHeight - el!.scrollTop - el!.clientHeight < BOTTOM_THRESHOLD;
      // Load older history when the user scrolls near the top.
      if (el!.scrollTop < TOP_THRESHOLD && hasOlder && !isFetchingOlder) {
        prevScrollHeightRef.current = el!.scrollHeight;
        void fetchOlder();
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [hasOlder, isFetchingOlder, fetchOlder]);

  // After a previous page loads, restore the scroll position so the viewport
  // doesn't jump. We recorded scrollHeight before the fetch; the delta between
  // old and new scrollHeight equals the height of newly prepended content.
  const pageCount = lens === 'messages'
    ? (messageQuery.data?.pages.length ?? 0)
    : (activityQuery.data?.pages.length ?? 0);
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

  // Scroll to bottom when activity data first loads for this agent.
  useEffect(() => {
    const feedKey = agentId ? `${agentId}:${lens}:${dir}` : null;
    const feedLoaded = lens === 'messages' ? messagesData : activitiesData;
    if (!feedLoaded || !feedKey || initialScrollFeedRef.current === feedKey) return;
    initialScrollFeedRef.current = feedKey;
    isAtBottomRef.current = true;
    const el = scrollContainerRef.current;
    if (!el) return;
    let inner: number;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [agentId, activitiesData, messagesData, lens, dir]);

  // Always scroll to bottom when new work starts.
  useEffect(() => {
    if (!currentItemId) return;
    isAtBottomRef.current = true;
    const el = scrollContainerRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(id);
  }, [currentItemId]);

  // Sticky scroll: follow live activity only when already at the bottom.
  useEffect(() => {
    if (!latestCurrentItemActivity || !isAtBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(id);
  }, [latestCurrentItemActivity]);

  // messageRowMode controls the follow-up marker on MessageInRow.
  // Show the ↳ marker only when in the full firehose (all context visible).
  const messageRowMode = (lens === 'activity' && showAllSteps) ? 'audit' : 'conversation';

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
          <span className="flex-1 font-mono text-[11px] leading-snug">
            Could not load activity
          </span>
        </div>
      )}

      {/* Mobile filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-soft px-4 py-2 md:hidden">
        <MobileLensPill lens={lens} onChange={setLens} />
        {lens === 'messages' && (
          <MobileDirPill dir={dir} onChange={setDir} />
        )}
        {lens === 'activity' && (
          <>
            <label className="chrome inline-flex cursor-pointer items-center gap-1.5 min-h-[36px] px-1 text-[11px] tracking-wide text-text-muted">
              <input
                type="checkbox"
                checked={failedOnly}
                onChange={(e) => setFailedOnly(e.target.checked)}
                className="h-3 w-3 accent-[color:var(--color-accent)]"
              />
              Failed only
            </label>
            <label className="chrome inline-flex cursor-pointer items-center gap-1.5 min-h-[36px] px-1 text-[11px] tracking-wide text-text-muted">
              <input
                type="checkbox"
                checked={showAllSteps}
                onChange={(e) => setShowAllSteps(e.target.checked)}
                className="h-3 w-3 accent-[color:var(--color-accent)]"
              />
              Show all steps
            </label>
          </>
        )}
      </div>

      <ActivityStatusSummary
        status={currentStatus}
        latestActivity={latestCurrentItemActivity}
        now={now}
      />

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-x-hidden overflow-y-auto px-4 pt-3 pb-[calc(64px+env(safe-area-inset-bottom))] md:px-10 md:pt-5 md:pb-10"
      >
        {/* Load-more indicator: shown at the very top while fetching an older page */}
        {isFetchingOlder && (
          <div className="flex justify-center py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-text-subtle" aria-label="Loading older activity" />
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
                  : lens === 'messages' && dir !== 'all'
                    ? `No ${dir === 'in' ? 'inbox' : 'outbox'} messages yet.`
                    : lens === 'messages'
                      ? 'No messages yet.'
                      : failedOnly
                        ? 'No activity matches the current filters.'
                        : 'No activity yet.'}
              </p>
            </div>
          )
        )}
        {filteredItems.length > 0 &&
          !showFirstRunHero &&
          byDay.map(([day, items]) => {
            let lastTime = '';
            return (
              <DaySection key={day} date={items[0]!.timestamp}>
                {items.map((item, i) => {
                  const hm = clockHM(item.timestamp);
                  const time = hm === lastTime ? '' : hm;
                  lastTime = hm;
                  const key = `${day}::${i}`;
                  if (item.kind === 'message-in')
                    return (
                      <MessageInRow
                        key={key}
                        item={item}
                        time={time}
                        agentId={agentId ?? ''}
                        mode={messageRowMode}
                      />
                    );
                  if (item.kind === 'message-out')
                    return <MessageOutRow key={key} item={item} time={time} />;
                  if (item.kind === 'file-out')
                    return <FileOutRow key={key} item={item} time={time} agentId={agentId ?? ''} />;
                  if (item.kind === 'reaction-out')
                    return <ReactOutRow key={key} item={item} time={time} />;
                  return <StepRow key={key} item={item} time={time} />;
                })}
              </DaySection>
            );
          })}
        {currentItemId && !loadingActivities && (
          <WorkingIndicator latestActivity={latestCurrentItemActivity} />
        )}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
}
