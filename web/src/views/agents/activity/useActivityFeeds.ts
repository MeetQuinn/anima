import { useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { fetchAgentActivities, fetchAgentMessages } from '@/api/agents';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import {
  buildHeldConversationItems,
  buildMessageConversationItems,
  buildStepItems,
  combineConversationItems,
  mergeActivityPages,
  mergeMessagePages,
} from '@/lib/activity-timeline';
import { mergeLatestActivityPage, mergeLatestMessagePage } from '@/lib/activity-live-merge';
import type { AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageHistoryPage } from '@shared/messages';

const PAGE_LIMIT = 100;

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
    queryFn: ({ pageParam }) => fetchAgentActivities(agentId!, PAGE_LIMIT, pageParam),
    enabled: !!agentId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
  });

  // Live tail: every poll fetches ONLY the newest page of each feed and folds
  // it into the infinite caches (append new ids to page 0, structurally share
  // the rest). An unchanged poll returns the same cache reference, so nothing
  // re-renders. The probe's own result is never read for rendering; only its
  // error is surfaced (a failing poll still shows the feed error banner). It
  // waits for both first pages to settle (success or error) so it never races
  // the initial load; an errored feed is re-kicked from the probe instead,
  // which is the retry the old per-query refetchInterval used to provide.
  const initialSettled = !messageQuery.isPending && !activityQuery.isPending;
  const liveQuery = useQuery({
    queryKey: queryKeys.agentFeedLive(agentId ?? ''),
    enabled: !!agentId && initialSettled,
    refetchInterval: refetchIntervals.agentActivities,
    queryFn: async () => {
      const id = agentId!;
      const [latestActivities, latestMessages] = await Promise.all([
        fetchAgentActivities(id, PAGE_LIMIT),
        fetchAgentMessages(id, { limit: PAGE_LIMIT }),
      ]);
      const summary = { activities: 0, messages: 0, refetched: [] as string[] };
      const bridge = (key: readonly unknown[], feed: string) => {
        summary.refetched.push(feed);
        void queryClient.invalidateQueries({ queryKey: key });
      };
      // While an infinite query is mid-fetch (older page / full refetch), its
      // result is built from the pages captured at fetch start, so anything we
      // merged in the meantime would vanish until the next poll. Skip this
      // poll's merge for that feed instead of producing a flicker.
      const activityState = queryClient.getQueryState(activitiesKey);
      if (activityState?.fetchStatus !== 'fetching') {
        const prev = queryClient.getQueryData<ActivityData>(activitiesKey);
        if (!prev && activityState?.status === 'error') {
          bridge(activitiesKey, 'activities');
        } else {
          const merged = mergeLatestActivityPage(prev, latestActivities);
          if (merged.changed) queryClient.setQueryData<ActivityData>(activitiesKey, merged.data);
          summary.activities = merged.added + merged.replaced;
          // More than a page arrived since the last poll: the newest page no
          // longer overlaps the cache, so a single page cannot bridge it. Fall
          // back to the full refetch for this one poll.
          if (merged.gap) bridge(activitiesKey, 'activities');
        }
      }
      const messageState = queryClient.getQueryState(messagesKey);
      if (messageState?.fetchStatus !== 'fetching') {
        const prev = queryClient.getQueryData<MessageData>(messagesKey);
        if (!prev && messageState?.status === 'error') {
          bridge(messagesKey, 'messages');
        } else {
          const merged = mergeLatestMessagePage(prev, latestMessages);
          if (merged.changed) queryClient.setQueryData<MessageData>(messagesKey, merged.data);
          summary.messages = merged.added + merged.replaced;
          if (merged.gap) bridge(messagesKey, 'messages');
        }
      }
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
