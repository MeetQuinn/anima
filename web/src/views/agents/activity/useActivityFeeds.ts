import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchAgentActivities, fetchAgentMessages } from '@/api/agents';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import {
  buildConversationItems,
  buildStepItems,
  mergeActivityPages,
  mergeMessagePages,
} from '@/lib/activity-timeline';

export function useActivityFeeds(agentId: string | undefined) {
  const messageQuery = useInfiniteQuery({
    queryKey: queryKeys.agentMessages(agentId ?? ''),
    queryFn: ({ pageParam }) => fetchAgentMessages(agentId!, { before: pageParam, limit: 100 }),
    enabled: !!agentId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
    refetchInterval: agentId ? refetchIntervals.agentActivities : false,
  });

  const activityQuery = useInfiniteQuery({
    queryKey: queryKeys.agentActivities(agentId ?? ''),
    queryFn: ({ pageParam }) => fetchAgentActivities(agentId!, 100, pageParam),
    enabled: !!agentId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    getPreviousPageParam: () => undefined,
    refetchInterval: agentId ? refetchIntervals.agentActivities : false,
  });

  const activitiesData = useMemo(
    () => mergeActivityPages(activityQuery.data?.pages),
    [activityQuery.data],
  );

  const messagesData = useMemo(() => mergeMessagePages(messageQuery.data?.pages), [messageQuery.data]);

  const conversationItems = useMemo(() => buildConversationItems(messagesData), [messagesData]);
  const stepItems = useMemo(() => buildStepItems(activitiesData), [activitiesData]);

  return { activityQuery, messageQuery, activitiesData, messagesData, conversationItems, stepItems };
}
