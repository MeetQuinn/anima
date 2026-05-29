import { useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { fetchAgentStatuses, fetchAgentActivities, fetchAgentMessages } from '@/api/agents';
import { buildActivityFeed, buildMessageFeed, type ActivityFeedItem } from '@/lib/activity-feed';
import { activityIsFailure, isNarrativeStep } from '@/lib/activities';
import { clockHM, dateKey } from '@/lib/format';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useActivityFilters, type ActivityLens, type ActivityDir } from '@/hooks/useActivityFilters';
import { MessageInRow, MessageOutRow, FileOutRow } from './MessageRows';
import { ReactOutRow, StepRow, WorkingIndicator, DaySection } from './AuditRows';
import type { AgentActivityFeedEvent } from '@shared/activity';
import type { AgentMessageRecord } from '@shared/messages';

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

// ---------------------------------------------------------------------------
// Activity view
// ---------------------------------------------------------------------------

export default function Activity() {
  const { data: agentStatuses = [] } = useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
  });
  const { agentId } = useParams<{ agentId: string }>();
  const { failedOnly, lens, dir, showAllSteps, setFailedOnly, setLens, setDir, setShowAllSteps } = useActivityFilters();
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
    // Each page's nextCursor is the ISO timestamp of its oldest activity.
    // getPreviousPageParam is called with pages[0] (the oldest currently-loaded
    // page) and returns the cursor needed to load the page before it.
    getPreviousPageParam: (firstPage) => firstPage.nextCursor ?? undefined,
    getNextPageParam: () => undefined,
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
    getPreviousPageParam: (firstPage) => firstPage.nextCursor ?? undefined,
    getNextPageParam: () => undefined,
    refetchInterval: agentId ? refetchIntervals.agentActivities : false,
  });
  const activitiesError = lens === 'messages' ? messageQuery.error : activityQuery.error;
  const loadingActivities = lens === 'messages' ? messageQuery.isLoading : activityQuery.isLoading;
  const fetchPreviousPage = lens === 'messages' ? messageQuery.fetchPreviousPage : activityQuery.fetchPreviousPage;
  const hasPreviousPage = lens === 'messages' ? messageQuery.hasPreviousPage : activityQuery.hasPreviousPage;
  const isFetchingPreviousPage = lens === 'messages'
    ? messageQuery.isFetchingPreviousPage
    : activityQuery.isFetchingPreviousPage;

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
      if (el!.scrollTop < TOP_THRESHOLD && hasPreviousPage && !isFetchingPreviousPage) {
        prevScrollHeightRef.current = el!.scrollHeight;
        void fetchPreviousPage();
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage]);

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

  // Always scroll to bottom when a new work item starts.
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

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-x-hidden overflow-y-auto px-4 pt-3 pb-[calc(64px+env(safe-area-inset-bottom))] md:px-10 md:pt-5 md:pb-10"
      >
        {/* Load-more indicator — shown at the very top while fetching an older page */}
        {isFetchingPreviousPage && (
          <div className="flex justify-center py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-text-subtle" aria-label="Loading older activity" />
          </div>
        )}
        {filteredItems.length === 0 && (
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
        )}
        {filteredItems.length > 0 &&
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
