import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAgentActivities,
  fetchAgentActivitiesAfter,
  fetchAgentMessages,
  fetchAgentMessagesAfter,
} from '@/api/agents';
import type { Activity, AgentActivityAfterPage, AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageAfterPage, AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';
import { useActivityFeeds } from './useActivityFeeds';

// The anchored live tail against a model of the `after` contract
// (server/tests/history-after.test.ts checks the real store and routes):
// positions are append indexes, a cursor names one position and the id stored
// there, `after` returns what follows it oldest first. `supportsAfter = false`
// models a runtime that predates `after`: no headCursor, and `after` ignored.

vi.mock('@/api/agents', () => ({
  fetchAgentActivities: vi.fn(),
  fetchAgentActivitiesAfter: vi.fn(),
  fetchAgentMessages: vi.fn(),
  fetchAgentMessagesAfter: vi.fn(),
}));

const activitiesMock = vi.mocked(fetchAgentActivities);
const activitiesAfterMock = vi.mocked(fetchAgentActivitiesAfter);
const messagesMock = vi.mocked(fetchAgentMessages);
const messagesAfterMock = vi.mocked(fetchAgentMessagesAfter);

const EXPIRED = 'cursor_expired: anchor_missing; reload the first page.';
const UNSTABLE = 'history_unstable: History rotated during the read; retry this page.';

function activity(activityId: string): Activity {
  return { activityId, type: 'tool.call.started', createdAt: '2026-10-05T00:00:00.000Z', payload: { tool: activityId } };
}
function messageRecord(messageId: string): AgentMessageRecord {
  return { direction: 'in', kind: 'message', messageId, platform: 'slack', source: { id: messageId, kind: 'inbox' },
    text: messageId, timestamp: '2026-10-05T00:00:00.000Z' };
}

class FakeLog<T> {
  rows: T[] = [];
  supportsAfter = true;
  private readonly tag: string;
  private readonly idOf: (row: T) => string;
  constructor(tag: string, idOf: (row: T) => string) {
    this.tag = tag;
    this.idOf = idOf;
  }
  push(...rows: T[]) { this.rows.push(...rows); }
  cursorAt(index: number) { return `${this.tag}:${index}:${this.idOf(this.rows[index]!)}`; }
  /** Throws like the server when the cursor's row is no longer at its position. */
  index(cursor: string): number {
    const [, at, ...id] = cursor.split(':');
    const index = Number(at);
    if (this.rows[index] === undefined || this.idOf(this.rows[index]!) !== id.join(':')) throw new Error(EXPIRED);
    return index;
  }
  /** Newest `limit` rows before `before`, oldest first. */
  window(limit: number, before?: string) {
    const end = before ? this.index(before) : this.rows.length;
    const start = Math.max(0, end - limit);
    const rows = this.rows.slice(start, end);
    return {
      rows,
      nextCursor: start > 0 ? this.cursorAt(start) : null,
      head: this.supportsAfter && !before ? { headCursor: rows.length ? this.cursorAt(end - 1) : null } : {},
    };
  }
  forward(cursor: string, limit: number) {
    const from = this.index(cursor) + 1;
    const rows = this.rows.slice(from, from + limit);
    return { rows, afterCursor: rows.length ? this.cursorAt(from + rows.length - 1) : null, hasMore: from + limit < this.rows.length };
  }
}

// Responses are cloned: a real response never shares objects with the cache.
function activityServer(log: FakeLog<Activity>) {
  const page = (limit = 100, before?: string): AgentActivityFeedPage => {
    const w = log.window(limit, before);
    return structuredClone({ events: w.rows, nextCursor: w.nextCursor, ...w.head });
  };
  activitiesMock.mockImplementation(async (_id, limit, before) => page(limit, before));
  activitiesAfterMock.mockImplementation(async (_id, after, limit = 100): Promise<AgentActivityAfterPage | AgentActivityFeedPage> => {
    if (!log.supportsAfter) return page(limit);
    const f = log.forward(after, limit);
    return structuredClone({ readAfter: true as const, events: f.rows, afterCursor: f.afterCursor, hasMore: f.hasMore });
  });
}
function messageServer(log: FakeLog<AgentMessageRecord>) {
  const page = (limit = 100, before?: string): AgentMessageHistoryPage => {
    const w = log.window(limit, before);
    return structuredClone({ entries: [...w.rows].reverse(), nextCursor: w.nextCursor, ...w.head });
  };
  messagesMock.mockImplementation(async (_id, input) => page(input?.limit, input?.before));
  messagesAfterMock.mockImplementation(async (_id, after, limit = 100): Promise<AgentMessageAfterPage | AgentMessageHistoryPage> => {
    if (!log.supportsAfter) return page(limit);
    const f = log.forward(after, limit);
    return structuredClone({ readAfter: true as const, entries: f.rows, afterCursor: f.afterCursor, hasMore: f.hasMore });
  });
}

const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from }, (_, i) => `${prefix}${from + i}`);
const activitiesKey = ['agent-activities', 'nora'];
const messagesKey = ['agent-messages', 'nora'];
const liveKey = ['agent-feed-live', 'nora'];

describe('useActivityFeeds anchored live tail (after)', () => {
  let client: QueryClient;
  let acts: FakeLog<Activity>;
  let msgs: FakeLog<AgentMessageRecord>;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const mock of [activitiesMock, activitiesAfterMock, messagesMock, messagesAfterMock]) mock.mockReset();
    acts = new FakeLog<Activity>('a', (row) => row.activityId);
    msgs = new FakeLog<AgentMessageRecord>('m', (row) => row.messageId);
    activityServer(acts);
    messageServer(msgs);
  });
  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  const activityPages = () => client.getQueryData<{ pages: AgentActivityFeedPage[] }>(activitiesKey)!.pages;
  const messagePages = () => client.getQueryData<{ pages: AgentMessageHistoryPage[] }>(messagesKey)!.pages;
  const anchorOf = (pages: { headCursor?: string | null }[]) => pages[0]?.headCursor;
  const calls = () => ({
    first: activitiesMock.mock.calls.length,
    after: activitiesAfterMock.mock.calls.length,
    mFirst: messagesMock.mock.calls.length,
    mAfter: messagesAfterMock.mock.calls.length,
  });

  /** Run one poll interval and wait until the probe and any re-fetch it started are done. */
  async function poll() {
    const before = client.getQueryState(liveKey);
    const stamp = Math.max(before?.dataUpdatedAt ?? 0, before?.errorUpdatedAt ?? 0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => {
      const state = client.getQueryState(liveKey)!;
      expect(Math.max(state.dataUpdatedAt, state.errorUpdatedAt)).toBeGreaterThan(stamp);
      expect(state.fetchStatus).toBe('idle');
      expect(client.isFetching()).toBe(0);
    });
  }

  async function mount(olderPages = 0) {
    const hook = renderHook(() => useActivityFeeds('nora'), { wrapper });
    await waitFor(() => expect(client.getQueryState(liveKey)?.status).toBe('success'));
    for (let i = 0; i < olderPages; i += 1) {
      await act(async () => {
        await hook.result.current.activityQuery.fetchNextPage();
      });
    }
    await waitFor(() => expect(client.isFetching()).toBe(0));
    return hook;
  }

  /** Every cached row, each id once, equal to the newest copy in the log (or its newest `rows`). */
  function expectActivitiesMatchLog(rows: Activity[] = acts.rows) {
    const cached = activityPages().flatMap((page) => page.events);
    const byId = new Map(rows.map((row) => [row.activityId, row]));
    expect(new Set(cached.map((row) => row.activityId)).size).toBe(cached.length);
    expect(cached.length).toBe(byId.size);
    for (const row of cached) expect(row).toEqual(byId.get(row.activityId));
  }

  it('fills 150 new events over 40 cached pages in 2 requests, without re-fetching the pages', async () => {
    acts.push(...range('s', 0, 100 + 39 * 500).map(activity));
    const { result } = await mount(39);
    expect(activityPages().length).toBe(40);
    const olderBefore = activityPages().slice(1);
    const anchor = anchorOf(activityPages());
    expect(anchor).toBe(acts.cursorAt(acts.rows.length - 1));
    const base = calls();

    acts.push(...range('n', 0, 150).map(activity));
    await poll();

    const after = activitiesAfterMock.mock.calls.slice(base.after);
    const finalAnchor = acts.cursorAt(acts.rows.length - 1);
    // The fill: from the anchor, then from the last row the first page returned.
    const fill = after.filter(([, cursor]) => cursor !== finalAnchor);
    expect(fill.map(([, cursor, limit]) => [cursor, limit])).toEqual([[anchor, 100], [acts.cursorAt(19_699), 100]]);
    expect(calls().first - base.first).toBe(0);
    expect(activityPages().length).toBe(40);
    activityPages().slice(1).forEach((page, i) => expect(page).toBe(olderBefore[i]));
    expect(anchorOf(activityPages())).toBe(finalAnchor);
    expect(activityPages()[0]!.events.slice(-150).map((e) => e.activityId)).toEqual(range('n', 0, 150));
    expectActivitiesMatchLog();
    expect(result.current.activitiesData?.events.length).toBe(19_750);
  });

  it('an idle poll is one empty read that writes nothing and keeps the anchor', async () => {
    acts.push(...range('s', 0, 300).map(activity));
    msgs.push(...range('m', 0, 50).map(messageRecord));
    const { result } = await mount(1);
    const data = client.getQueryData(activitiesKey);
    const messageData = client.getQueryData(messagesKey);
    const events = result.current.activitiesData;
    const anchor = anchorOf(activityPages());
    const base = calls();
    const writes = vi.spyOn(client, 'setQueryData');
    await poll();
    await poll();
    // No write at all: even rewriting the same anchor would stamp the feed as updated.
    expect(writes).not.toHaveBeenCalled();
    expect(calls().after - base.after).toBe(2);
    expect(calls().mAfter - base.mAfter).toBe(2);
    expect(calls().first - base.first + calls().mFirst - base.mFirst).toBe(0);
    expect(activitiesAfterMock.mock.calls.slice(base.after).every(([, cursor]) => cursor === anchor)).toBe(true);
    expect(client.getQueryData(activitiesKey)).toBe(data);
    expect(client.getQueryData(messagesKey)).toBe(messageData);
    expect(result.current.activitiesData).toBe(events);
    expect(anchorOf(activityPages())).toBe(anchor);
  });

  it('600 new events exceed the 5-request budget and fall back to re-fetching the feed', async () => {
    acts.push(...range('s', 0, 100 + 39 * 500).map(activity));
    await mount(39);
    const base = calls();
    acts.push(...range('n', 0, 600).map(activity));
    await poll();
    const pollAfter = activitiesAfterMock.mock.calls.slice(base.after);
    // Budget spent (5 reads of 100), nothing committed, then the same re-fetch
    // the newest-page probe does on a gap: all 40 pages.
    expect(pollAfter.length).toBe(5);
    expect(calls().first - base.first).toBe(40);
    expect(activityPages().length).toBe(40);
    expect(anchorOf(activityPages())).toBe(acts.cursorAt(acts.rows.length - 1));
    // A cold load of 40 pages: the newest 100 + 39 * 500 rows.
    expectActivitiesMatchLog(acts.rows.slice(-(100 + 39 * 500)));
  });

  it('410 on the anchor falls back to re-fetching, and the next poll reads from the new anchor', async () => {
    acts.push(...range('s', 0, 150).map(activity));
    await mount(1);
    // A restore rewrote the log: the anchor's position now holds another row.
    acts.rows.splice(0, acts.rows.length, ...range('r', 0, 160).map(activity));
    const base = calls();
    await poll();
    await expect(activitiesAfterMock.mock.results[base.after]!.value).rejects.toThrow(EXPIRED);
    expect(calls().first - base.first).toBe(2);
    expect(anchorOf(activityPages())).toBe(acts.cursorAt(159));
    acts.push(activity('r160'));
    const next = calls();
    await poll();
    expect(activitiesAfterMock.mock.calls[next.after]![1]).toBe(acts.cursorAt(159));
    expect(calls().first - next.first).toBe(0);
    expect(activityPages()[0]!.events.at(-1)?.activityId).toBe('r160');
  });

  it('old runtime: no headCursor, so the probe is the newest-page read, call for call', async () => {
    acts.supportsAfter = false;
    msgs.supportsAfter = false;
    acts.push(...range('s', 0, 150).map(activity));
    await mount(1);
    expect(anchorOf(activityPages())).toBeUndefined();
    const base = calls();
    acts.push(activity('n0'));
    await poll();
    expect(activitiesMock.mock.calls.slice(base.first)).toEqual([['nora', 100]]);
    expect(messagesMock.mock.calls.slice(base.mFirst)).toEqual([['nora', { limit: 100 }]]);
    expect(calls().after + calls().mAfter).toBe(0);
    expect(activityPages()[0]!.events.at(-1)?.activityId).toBe('n0');
  });

  it('a runtime that ignores after (no readAfter mark) is merged as a newest page, gap check included', async () => {
    acts.push(...range('s', 0, 150).map(activity));
    await mount(1);
    expect(anchorOf(activityPages())).toBeTruthy();
    // Rolled back under an open tab: cached page 0 still names a head.
    acts.supportsAfter = false;
    acts.push(activity('n0'), activity('n1'));
    const base = calls();
    await poll();
    expect(calls().after - base.after).toBe(1);
    expect(calls().first - base.first).toBe(0);
    expect(activityPages()[0]!.events.slice(-2).map((e) => e.activityId)).toEqual(['n0', 'n1']);
    // 150 more: the ignored-after reply is just the newest 100. Taking it as
    // "everything after the anchor" would skip 50; the gap check re-fetches.
    acts.push(...range('n', 2, 152).map(activity));
    const gap = calls();
    await poll();
    expect(calls().first - gap.first).toBe(2);
    expectActivitiesMatchLog();
  });

  it('events appended between continuations land in the same poll; the result equals the log', async () => {
    acts.push(...range('s', 0, 200).map(activity));
    await mount(1);
    acts.push(...range('n', 0, 150).map(activity));
    const server = activitiesAfterMock.getMockImplementation()!;
    let reads = 0;
    activitiesAfterMock.mockImplementation(async (...args) => {
      const page = await server(...args);
      if (++reads === 1) acts.push(...range('late', 0, 30).map(activity));
      return page;
    });
    const base = calls();
    await poll();
    expect(calls().first - base.first).toBe(0);
    expect(activityPages()[0]!.events.slice(-180).map((e) => e.activityId)).toEqual([...range('n', 0, 150), ...range('late', 0, 30)]);
    expect(anchorOf(activityPages())).toBe(acts.cursorAt(acts.rows.length - 1));
    expectActivitiesMatchLog();
  });

  it('duplicate ids: re-appended copies replace in place, a page of known ids does not end the read', async () => {
    acts.push(...range('s', 0, 200).map(activity));
    await mount(1);
    const cachedCount = activityPages().flatMap((p) => p.events).length;
    // A restore re-appends 120 cached rows (a full page of nothing new), then
    // new rows arrive, one of them twice.
    acts.push(...range('s', 80, 200).map(activity), ...range('n', 0, 40).map(activity), activity('n7'), activity('n40'));
    await poll();
    const cached = activityPages().flatMap((p) => p.events);
    expect(cached.length).toBe(cachedCount + 41);
    expect(new Set(cached.map((e) => e.activityId)).size).toBe(cached.length);
    expect(anchorOf(activityPages())).toBe(acts.cursorAt(acts.rows.length - 1));
    expectActivitiesMatchLog();
  });

  it('a poll that lands while an older page is in flight writes nothing; the next poll fills in', async () => {
    acts.push(...range('s', 0, 150).map(activity));
    const server = activitiesMock.getMockImplementation()!;
    let releaseOlder: (() => void) | null = null;
    activitiesMock.mockImplementation(async (...args) => {
      if (args[2]) await new Promise<void>((resolve) => { releaseOlder = resolve; });
      return server(...args);
    });
    const { result } = await mount();
    const anchor = anchorOf(activityPages());
    act(() => {
      void result.current.activityQuery.fetchNextPage();
    });
    await waitFor(() => expect(client.getQueryState(activitiesKey)?.fetchStatus).toBe('fetching'));
    const data = client.getQueryData(activitiesKey);
    acts.push(activity('n0'), activity('n1'));
    const base = calls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(calls().after - base.after).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(client.getQueryState(liveKey)?.fetchStatus).toBe('idle'));
    expect(client.getQueryData(activitiesKey)).toBe(data);
    expect(anchorOf(activityPages())).toBe(anchor);
    act(() => {
      releaseOlder!();
    });
    await waitFor(() => expect(activityPages().length).toBe(2));
    expect(anchorOf(activityPages())).toBe(anchor);
    await poll();
    expect(anchorOf(activityPages())).toBe(acts.cursorAt(151));
    expectActivitiesMatchLog();
  });

  it('503 on the second read leaves cache and anchor as they were; the next poll fills in', async () => {
    acts.push(...range('s', 0, 300).map(activity));
    const { result } = await mount(1);
    const data = client.getQueryData(activitiesKey);
    const anchor = anchorOf(activityPages());
    acts.push(...range('n', 0, 150).map(activity));
    const server = activitiesAfterMock.getMockImplementation()!;
    let reads = 0;
    activitiesAfterMock.mockImplementation(async (...args) => {
      if (++reads === 2) throw new Error(UNSTABLE);
      return server(...args);
    });
    await poll();
    expect(reads).toBe(2);
    expect(client.getQueryData(activitiesKey)).toBe(data);
    expect(anchorOf(activityPages())).toBe(anchor);
    await waitFor(() => expect(result.current.liveError?.message).toBe(UNSTABLE));
    const base = calls();
    await poll();
    expect(activitiesAfterMock.mock.calls[base.after]![1]).toBe(anchor);
    expect(calls().first - base.first).toBe(0);
    expect(anchorOf(activityPages())).toBe(acts.cursorAt(acts.rows.length - 1));
    expectActivitiesMatchLog();
  });

  it('a re-fetch that lands during the read wins: rows read from the old anchor are not committed', async () => {
    acts.push(...range('s', 0, 150).map(activity));
    const { result } = await mount();
    acts.push(...range('n', 0, 5).map(activity));
    const server = activitiesAfterMock.getMockImplementation()!;
    let release: (() => void) | null = null;
    activitiesAfterMock.mockImplementationOnce(async (...args) => {
      const page = await server(...args);
      await new Promise<void>((resolve) => { release = resolve; });
      return page;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(release).not.toBeNull());
    acts.push(activity('n5'));
    await act(async () => {
      await result.current.activityQuery.refetch();
    });
    const refetched = client.getQueryData(activitiesKey);
    expect(anchorOf(activityPages())).toBe(acts.cursorAt(155));
    act(() => {
      release!();
    });
    await waitFor(() => expect(client.getQueryState(liveKey)?.fetchStatus).toBe('idle'));
    expect(client.getQueryData(activitiesKey)).toBe(refetched);
    expectActivitiesMatchLog(acts.rows.slice(-100));
  });

  it('messages: fills 150 new entries newest first into page 0 in 2 requests', async () => {
    msgs.push(...range('s', 0, 300).map(messageRecord));
    const { result } = await mount();
    await act(async () => {
      await result.current.messageQuery.fetchNextPage();
    });
    await waitFor(() => expect(messagePages().length).toBe(2));
    const older = messagePages()[1];
    const anchor = anchorOf(messagePages());
    const base = calls();
    msgs.push(...range('n', 0, 150).map(messageRecord));
    await poll();
    const final = msgs.cursorAt(msgs.rows.length - 1);
    const fill = messagesAfterMock.mock.calls.slice(base.mAfter).filter(([, cursor]) => cursor !== final);
    expect(fill.map(([, cursor]) => cursor)).toEqual([anchor, msgs.cursorAt(399)]);
    expect(calls().mFirst - base.mFirst).toBe(0);
    expect(messagePages()[1]).toBe(older);
    expect(messagePages()[0]!.entries.slice(0, 150).map((e) => e.messageId)).toEqual(range('n', 0, 150).reverse());
    expect(anchorOf(messagePages())).toBe(final);
    const cached = messagePages().flatMap((p) => p.entries.map((e) => e.messageId));
    expect(new Set(cached).size).toBe(cached.length);
    expect(cached.length).toBe(350);
  });
});
