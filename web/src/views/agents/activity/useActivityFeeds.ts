import { useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  fetchAgentActivities,
  fetchAgentActivitiesAfter,
  fetchAgentMessages,
  fetchAgentMessagesAfter,
} from '@/api/agents';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import {
  buildHeldConversationItems,
  buildMessageConversationItems,
  buildStepItems,
  combineConversationItems,
  mergeActivityPages,
  mergeMessagePages,
} from '@/lib/activity-timeline';
import {
  mergeAfterActivityRows,
  mergeAfterMessageRows,
  mergeLatestActivityPage,
  mergeLatestMessagePage,
} from '@/lib/activity-live-merge';
import { readAfterAnchor } from '@/lib/activity-live-after';
import type { Activity, AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';

const PAGE_LIMIT = 100;
// Older activity pages (the coverage auto-fetch walking back until the step
// layer spans the loaded conversation) are fetched in larger chunks: the
// server caps a page at 500 (`normalizeHistoryLimit`). A 2300-row feed used to
// arrive as ~23 renders of a growing list, each one blocking input while the
// tab opened; five chunks do the same work with far fewer full re-renders.
// The first page and the live probe stay at 100 so the first paint is quick.
const OLDER_PAGE_LIMIT = 500;

type ActivityData = InfiniteData<AgentActivityFeedPage, string | undefined>;
type MessageData = InfiniteData<AgentMessageHistoryPage, string | undefined>;

export function useActivityFeeds(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const messagesKey = queryKeys.agentMessages(agentId ?? '');
  const activitiesKey = queryKeys.agentActivities(agentId ?? '');

  // The two infinite feeds carry NO refetchInterval on purpose: an infinite
  // refetch re-fetches every loaded page in sequence, and the coverage
  // auto-fetch below routinely holds 40+ activity pages for a busy agent. The
  // live tail is the separate single-page probe further down.
  const messageQuery = useInfiniteQuery({
    queryKey: messagesKey,
    queryFn: ({ pageParam }) =>
      fetchAgentMessages(agentId!, { before: pageParam, limit: PAGE_LIMIT }),
    enabled: !!agentId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
  });

  const activityQuery = useInfiniteQuery({
    queryKey: activitiesKey,
    queryFn: ({ pageParam }) =>
      fetchAgentActivities(agentId!, pageParam ? OLDER_PAGE_LIMIT : PAGE_LIMIT, pageParam),
    enabled: !!agentId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
  });

  // Live tail: every poll reads only what is new and folds it into the
  // infinite caches (new ids into page 0, structurally sharing the rest). An
  // unchanged poll returns the same cache reference, so nothing re-renders.
  // The probe's own result is never read for rendering; only its error is
  // surfaced (a failing poll still shows the feed error banner). It waits for
  // both first pages to settle (success or error) so it never races the
  // initial load; an errored feed is re-kicked from the probe instead, which
  // is the retry the old per-query refetchInterval used to provide. The two
  // feeds are independent: one endpoint failing never stops the other from
  // merging; the failure is re-thrown afterwards so it still surfaces.
  //
  // How a poll reads depends on cached page 0:
  //   - it carries `headCursor` (a runtime with `after` support served it):
  //     read forward from that anchor, a bounded number of requests (see
  //     activity-live-after.ts). An idle poll is one empty response;
  //   - otherwise (older runtime, or a cache that never had a head): fetch the
  //     newest page and merge it, falling back to a re-fetch on a gap.
  const initialSettled = !messageQuery.isPending && !activityQuery.isPending;
  const liveQuery = useQuery({
    queryKey: queryKeys.agentFeedLive(agentId ?? ''),
    enabled: !!agentId && initialSettled,
    refetchInterval: refetchIntervals.agentActivities,
    queryFn: async () => {
      const id = agentId!;
      const summary = { activities: 0, messages: 0, refetched: [] as string[] };
      const bridge = (key: readonly unknown[], feed: string) => {
        summary.refetched.push(feed);
        void queryClient.invalidateQueries({ queryKey: key });
      };
      // While an infinite query is mid-fetch (older page / full refetch), its
      // result is built from the pages captured at fetch start, so anything we
      // merged in the meantime would vanish until the next poll. Skip this
      // poll's merge for that feed instead of producing a flicker; the next
      // poll picks the items up. The anchor lives in page 0 for the same
      // reason: a skipped write skips it too.
      const fetching = (key: readonly unknown[]) => queryClient.getQueryState(key)?.fetchStatus === 'fetching';

      const mergeLatestActivities = (latest: AgentActivityFeedPage) => {
        if (fetching(activitiesKey)) return;
        const prev = queryClient.getQueryData<ActivityData>(activitiesKey);
        if (!prev && queryClient.getQueryState(activitiesKey)?.status === 'error') {
          bridge(activitiesKey, 'activities');
          return;
        }
        const merged = mergeLatestActivityPage(prev, latest);
        if (merged.changed) queryClient.setQueryData<ActivityData>(activitiesKey, merged.data);
        summary.activities = merged.added + merged.replaced;
        // More than a page arrived since the last poll: the newest page no
        // longer overlaps the cache, so a single page cannot bridge it.
        // Nothing was written; re-fetch the feed. If that re-fetch fails
        // the cache is unchanged, so the next poll sees the same gap and
        // asks again until it lands.
        if (merged.gap) bridge(activitiesKey, 'activities');
      };
      const mergeLatestMessages = (latest: AgentMessageHistoryPage) => {
        if (fetching(messagesKey)) return;
        const prev = queryClient.getQueryData<MessageData>(messagesKey);
        if (!prev && queryClient.getQueryState(messagesKey)?.status === 'error') {
          bridge(messagesKey, 'messages');
          return;
        }
        const merged = mergeLatestMessagePage(prev, latest);
        if (merged.changed) queryClient.setQueryData<MessageData>(messagesKey, merged.data);
        summary.messages = merged.added + merged.replaced;
        if (merged.gap) bridge(messagesKey, 'messages');
      };

      const pollActivities = async () => {
        const anchor = queryClient.getQueryData<ActivityData>(activitiesKey)?.pages[0]?.headCursor;
        if (!anchor) {
          mergeLatestActivities(await fetchAgentActivities(id, PAGE_LIMIT));
          return;
        }
        const read = await readAfterAnchor<Activity, AgentActivityFeedPage>(anchor, async (cursor) => {
          const page = await fetchAgentActivitiesAfter(id, cursor, PAGE_LIMIT);
          return 'readAfter' in page ? { after: { ...page, rows: page.events } } : { latest: page };
        });
        if (read.kind === 'not-supported') {
          mergeLatestActivities(read.latest);
          return;
        }
        if (fetching(activitiesKey)) return;
        if (read.kind !== 'complete') {
          bridge(activitiesKey, 'activities');
          return;
        }
        const prev = queryClient.getQueryData<ActivityData>(activitiesKey);
        // Commit only onto the cache the read started from: a refetch that
        // landed meanwhile carries its own anchor, and the next poll uses it.
        if (!prev || prev.pages[0]?.headCursor !== anchor || read.rows.length === 0) return;
        const merged = mergeAfterActivityRows(prev, read.rows, read.cursor);
        queryClient.setQueryData<ActivityData>(activitiesKey, merged.data);
        summary.activities = merged.added + merged.replaced;
      };
      const pollMessages = async () => {
        const anchor = queryClient.getQueryData<MessageData>(messagesKey)?.pages[0]?.headCursor;
        if (!anchor) {
          mergeLatestMessages(await fetchAgentMessages(id, { limit: PAGE_LIMIT }));
          return;
        }
        const read = await readAfterAnchor<AgentMessageRecord, AgentMessageHistoryPage>(anchor, async (cursor) => {
          const page = await fetchAgentMessagesAfter(id, cursor, PAGE_LIMIT);
          return 'readAfter' in page ? { after: { ...page, rows: page.entries } } : { latest: page };
        });
        if (read.kind === 'not-supported') {
          mergeLatestMessages(read.latest);
          return;
        }
        if (fetching(messagesKey)) return;
        if (read.kind !== 'complete') {
          bridge(messagesKey, 'messages');
          return;
        }
        const prev = queryClient.getQueryData<MessageData>(messagesKey);
        if (!prev || prev.pages[0]?.headCursor !== anchor || read.rows.length === 0) return;
        const merged = mergeAfterMessageRows(prev, read.rows, read.cursor);
        queryClient.setQueryData<MessageData>(messagesKey, merged.data);
        summary.messages = merged.added + merged.replaced;
      };

      const [activitiesResult, messagesResult] = await Promise.allSettled([pollActivities(), pollMessages()]);
      if (activitiesResult.status === 'rejected') throw activitiesResult.reason;
      if (messagesResult.status === 'rejected') throw messagesResult.reason;
      return summary;
    },
  });

  const activitiesData = useMemo(
    () => mergeActivityPages(activityQuery.data?.pages),
    [activityQuery.data],
  );

  const messagesData = useMemo(() => mergeMessagePages(messageQuery.data?.pages), [messageQuery.data]);

  // Two memo halves on purpose (see buildMessageConversationItems): message
  // items keep identity across activity-only polls, so memoised message rows
  // skip; only the rare held row rides on the activity feed.
  const messageItems = useMemo(() => buildMessageConversationItems(messagesData), [messagesData]);
  const heldItems = useMemo(() => buildHeldConversationItems(activitiesData), [activitiesData]);
  const conversationItems = useMemo(
    () => combineConversationItems(messageItems, heldItems),
    [messageItems, heldItems],
  );
  const stepItems = useMemo(() => buildStepItems(activitiesData), [activitiesData]);

  return {
    activityQuery,
    messageQuery,
    liveError: liveQuery.error,
    activitiesData,
    messagesData,
    conversationItems,
    stepItems,
  };
}
