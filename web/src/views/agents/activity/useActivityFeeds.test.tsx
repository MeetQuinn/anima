import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAgentActivities, fetchAgentMessages } from '@/api/agents';
import type { Activity, AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageHistoryPage } from '@shared/messages';
import { useActivityFeeds } from './useActivityFeeds';

vi.mock('@/api/agents', () => ({
  fetchAgentActivities: vi.fn(),
  fetchAgentMessages: vi.fn(),
}));

const activitiesMock = vi.mocked(fetchAgentActivities);
const messagesMock = vi.mocked(fetchAgentMessages);

function activity(activityId: string, createdAt: string): Activity {
  return { activityId, type: 'tool.call.started', createdAt, payload: { tool: 'claude.read' } };
}

// Server model: `all` is the full oldest→newest log; a page is the newest
// `limit` events before the cursor, oldest→newest inside the page.
function activityServer(all: () => Activity[]) {
  return async (_agentId: string, limit = 100, before?: string): Promise<AgentActivityFeedPage> => {
    const pool = before ? all().filter((a) => a.createdAt < before) : all();
    const events = pool.slice(-limit);
    return { events, nextCursor: events.length >= limit ? (events[0]?.createdAt ?? null) : null };
  };
}

function iso(minute: number): string {
  return `2026-09-13T10:${String(minute).padStart(2, '0')}:00.000Z`;
}

describe('useActivityFeeds live tail', () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    activitiesMock.mockReset();
    messagesMock.mockReset();
    const emptyMessages: AgentMessageHistoryPage = { entries: [], nextCursor: null };
    messagesMock.mockResolvedValue(emptyMessages);
  });
  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it('polls only the newest page and merges it into the loaded pages', async () => {
    const log: Activity[] = [];
    for (let m = 0; m < 150; m += 1) log.push(activity(`a${m}`, iso(m)));
    activitiesMock.mockImplementation(activityServer(() => log));

    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(100));

    // Load the older page as the coverage auto-fetch / scroll-to-top would.
    await act(async () => {
      await result.current.activityQuery.fetchNextPage();
    });
    await waitFor(() => expect(result.current.activityQuery.data?.pages.length).toBe(2));
    expect(result.current.activitiesData?.events.length).toBe(150);
    const activityCallsAfterLoad = activitiesMock.mock.calls.length;
    const messageCallsAfterLoad = messagesMock.mock.calls.length;

    // Two poll intervals with a new event landing in between.
    log.push(activity('a150', iso(50).replace('T10:', 'T11:')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(151));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    const pollActivityCalls = activitiesMock.mock.calls.slice(activityCallsAfterLoad);
    const pollMessageCalls = messagesMock.mock.calls.slice(messageCallsAfterLoad);
    // Old behaviour (red control): every poll re-fetched BOTH loaded activity
    // pages (one with a `before` cursor) → 4 activity calls for two polls.
    expect(pollActivityCalls.length).toBe(2);
    expect(pollActivityCalls.every(([, , before]) => before === undefined)).toBe(true);
    expect(pollMessageCalls.length).toBe(2);
    expect(pollMessageCalls.every(([, input]) => input?.before === undefined)).toBe(true);

    // The merged event sits at the end of page 0; the older page kept identity.
    const ids = result.current.activitiesData!.events.map((e) => e.activityId);
    expect(ids).toContain('a150');
    expect(ids).toContain('a0');
    expect(result.current.activityQuery.data?.pages[0]?.events.at(-1)?.activityId).toBe('a150');
    expect(result.current.activityQuery.hasNextPage).toBe(true);
  });

  it('keeps the merged events reference-stable across an unchanged poll', async () => {
    const log: Activity[] = [activity('a0', iso(0)), activity('a1', iso(1))];
    activitiesMock.mockImplementation(activityServer(() => log));
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(2));
    const before = result.current.activitiesData;
    const stepsBefore = result.current.stepItems;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(activitiesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.activitiesData).toBe(before);
    expect(result.current.stepItems).toBe(stepsBefore);
  });

  it('re-kicks a feed whose first page failed, so the error banner recovers on the next poll', async () => {
    const log: Activity[] = [activity('a0', iso(0))];
    activitiesMock.mockImplementation(activityServer(() => log));
    let messagesDown = true;
    messagesMock.mockImplementation(async () => {
      if (messagesDown) throw new Error('ledger offline');
      return { entries: [], nextCursor: null } as AgentMessageHistoryPage;
    });
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.messageQuery.isError).toBe(true));
    expect(result.current.messagesData).toBeUndefined();

    messagesDown = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(result.current.messageQuery.isSuccess).toBe(true));
    expect(result.current.messagesData?.entries).toEqual([]);
    expect(result.current.messageQuery.error).toBeNull();
  });

  it('falls back to a full refetch when the newest page no longer overlaps the cache', async () => {
    const log: Activity[] = [];
    for (let m = 0; m < 5; m += 1) log.push(activity(`a${m}`, iso(m)));
    activitiesMock.mockImplementation(activityServer(() => log));
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(5));

    // 200 events arrive between polls: the newest 100 share nothing with the cache.
    for (let m = 0; m < 200; m += 1) log.push(activity(`b${m}`, `2026-09-13T12:${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}.000Z`));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(result.current.activityQuery.isFetching).toBe(false));
    // The gap poll re-ran the infinite query: newest 100 events, cursor restored
    // for older paging.
    expect(result.current.activityQuery.data?.pages.length).toBe(1);
    expect(result.current.activityQuery.data?.pages[0]?.events.length).toBe(100);
    expect(result.current.activityQuery.hasNextPage).toBe(true);
  });
});
