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

function messageRecord(messageId: string, timestamp: string): AgentMessageHistoryPage['entries'][number] {
  return {
    direction: 'in',
    kind: 'message',
    messageId,
    platform: 'slack',
    source: { id: messageId, kind: 'inbox' },
    text: messageId,
    timestamp,
  };
}

function iso(minute: number): string {
  // Real timestamps (minute may exceed 59): string order == time order.
  return new Date(Date.UTC(2026, 8, 13, 10) + minute * 60_000).toISOString();
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
    for (let m = 0; m < 700; m += 1) log.push(activity(`a${m}`, iso(m)));
    activitiesMock.mockImplementation(activityServer(() => log));

    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(100));

    // Load the older page as the coverage auto-fetch / scroll-to-top would.
    await act(async () => {
      await result.current.activityQuery.fetchNextPage();
    });
    await waitFor(() => expect(result.current.activityQuery.data?.pages.length).toBe(2));
    expect(result.current.activitiesData?.events.length).toBe(600);
    const activityCallsAfterLoad = activitiesMock.mock.calls.length;
    const messageCallsAfterLoad = messagesMock.mock.calls.length;

    // Two poll intervals with a new event landing in between.
    log.push(activity('a700', iso(700)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(601));
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
    expect(ids).toContain('a700');
    expect(ids).toContain('a100');
    expect(result.current.activityQuery.data?.pages[0]?.events.at(-1)?.activityId).toBe('a700');
    // Page 1 was a full page, so its cursor still offers older history.
    expect(result.current.activityQuery.hasNextPage).toBe(true);
  });

  it('fetches older activity pages in 500-event chunks while the first page and the poll stay at 100', async () => {
    const log: Activity[] = [];
    for (let m = 0; m < 700; m += 1) log.push(activity(`a${m}`, iso(m)));
    activitiesMock.mockImplementation(activityServer(() => log));
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(100));
    await act(async () => {
      await result.current.activityQuery.fetchNextPage();
    });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(600));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    const limits = activitiesMock.mock.calls.map(([, limit, before]) => [limit, before === undefined ? 'first' : 'older']);
    expect(limits).toContainEqual([100, 'first']);
    expect(limits).toContainEqual([500, 'older']);
    // Red control on the old constant: every call was 100.
    expect(limits.filter(([, kind]) => kind === 'older').every(([limit]) => limit === 500)).toBe(true);
    expect(limits.filter(([, kind]) => kind === 'first').every(([limit]) => limit === 100)).toBe(true);
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

  // The next three are Milo's #732 HOLD repros (gate thread 1789283293.810389),
  // taken verbatim apart from formatting. All three were red on 279e424f.
  it('review: preserves a paging path when an empty feed receives more than one page', async () => {
    const log: Activity[] = [];
    activitiesMock.mockImplementation(activityServer(() => log));
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    for (let i = 0; i < 200; i++) {
      log.push(activity(`new${i}`, new Date(Date.UTC(2026, 8, 13) + i * 1000).toISOString()));
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_200);
    });
    expect(result.current.activitiesData?.events.length).toBe(100);
    expect(result.current.activityQuery.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.activityQuery.fetchNextPage();
    });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(200));
  });

  it('review: an empty conversation that receives more than a page keeps its paging path too', async () => {
    const ledger: AgentMessageHistoryPage['entries'] = [];
    messagesMock.mockImplementation(async (_agentId, opts) => {
      const before = opts?.before;
      const pool = before ? ledger.filter((e) => e.timestamp < before) : ledger;
      const entries = pool.slice(0, opts?.limit ?? 100);
      return { entries, nextCursor: entries.length >= (opts?.limit ?? 100) ? entries[entries.length - 1]!.timestamp : null };
    });
    activitiesMock.mockImplementation(activityServer(() => []));
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.messagesData?.entries.length).toBe(0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    for (let i = 199; i >= 0; i--) {
      const timestamp = new Date(Date.UTC(2026, 8, 13) + i * 1000).toISOString();
      ledger.push(messageRecord(`m${i}`, timestamp));
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_200);
    });
    expect(result.current.messagesData?.entries.length).toBe(100);
    expect(result.current.messageQuery.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.messageQuery.fetchNextPage();
    });
    await waitFor(() => expect(result.current.messagesData?.entries.length).toBe(200));
  });

  it('review: a failed message poll does not freeze healthy activity polling', async () => {
    const log = [activity('a0', iso(0))];
    activitiesMock.mockImplementation(activityServer(() => log));
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    messagesMock.mockRejectedValue(new Error('message ledger offline'));
    log.push(activity('a1', iso(1)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_200);
    });
    expect(result.current.liveError).toBeTruthy();
    expect(result.current.activitiesData?.events.map((a) => a.activityId)).toContain('a1');
  });

  it('review: a failed activity poll does not freeze healthy message polling (other direction)', async () => {
    const ledger: AgentMessageHistoryPage['entries'] = [];
    messagesMock.mockImplementation(async () => ({ entries: [...ledger], nextCursor: null }));
    activitiesMock.mockImplementation(activityServer(() => [activity('a0', iso(0))]));
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    activitiesMock.mockRejectedValue(new Error('activity log offline'));
    ledger.unshift(messageRecord('m1', iso(1)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_200);
    });
    expect(result.current.liveError).toBeTruthy();
    expect(result.current.messagesData?.entries.map((e) => e.messageId)).toContain('m1');
  });

  it('review: retries an unresolved gap after a failed bridge fetch', async () => {
    const log = [activity('a0', iso(0))];
    const server = activityServer(() => log);
    let burstCalls = 0;
    activitiesMock.mockImplementation(async (...args) => {
      if (log.length > 100 && ++burstCalls === 2) throw new Error('bridge temporarily offline');
      return server(...args);
    });
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    for (let i = 0; i < 200; i++) {
      log.push(activity(`new${i}`, new Date(Date.UTC(2026, 8, 13, 12) + i * 1000).toISOString()));
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    // Observe the cache, not the hook snapshot: nothing in the hook reads
    // `error`, so TanStack's tracked props do not re-render it on that flip.
    const activitiesKey = ['agent-activities', 'nora'];
    await waitFor(() => expect(client.getQueryState(activitiesKey)?.status).toBe('error'));
    // The gap was not papered over: the cache still holds only the old item.
    expect(result.current.activitiesData?.events.map((a) => a.activityId)).toEqual(['a0']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_200);
    });
    expect(burstCalls).toBeGreaterThanOrEqual(4);
    await waitFor(() => expect(result.current.activityQuery.hasNextPage).toBe(true));
    expect(result.current.activitiesData?.events.length).toBe(100);
  });

  it('skips the merge while an older page is in flight and picks the item up on the next poll', async () => {
    const log: Activity[] = [];
    for (let m = 0; m < 150; m += 1) log.push(activity(`a${m}`, iso(m)));
    const server = activityServer(() => log);
    let releaseOlder: (() => void) | null = null;
    activitiesMock.mockImplementation(async (agentId, limit, before) => {
      if (before) {
        // Hold the older-page fetch open until the test releases it.
        await new Promise<void>((resolve) => {
          releaseOlder = resolve;
        });
      }
      return server(agentId, limit, before);
    });
    const { result } = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(result.current.activitiesData?.events.length).toBe(100));

    act(() => {
      void result.current.activityQuery.fetchNextPage();
    });
    const activitiesKey = ['agent-activities', 'nora'];
    await waitFor(() => expect(client.getQueryState(activitiesKey)?.fetchStatus).toBe('fetching'));
    log.push(activity('a150', iso(150)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    // Poll ran (fetch without cursor happened) but did not write into a cache
    // whose fetch is still in flight.
    expect(activitiesMock.mock.calls.filter(([, , before]) => !before).length).toBeGreaterThanOrEqual(2);
    expect(result.current.activitiesData?.events.map((a) => a.activityId)).not.toContain('a150');

    act(() => {
      releaseOlder!();
    });
    await waitFor(() => expect(result.current.activityQuery.data?.pages.length).toBe(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() =>
      expect(result.current.activitiesData?.events.map((a) => a.activityId)).toContain('a150'),
    );
    expect(result.current.activitiesData?.events.length).toBe(151);
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
