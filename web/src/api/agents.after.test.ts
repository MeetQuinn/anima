import { afterEach, expect, it, vi } from 'vitest';

import { fetchAgentActivities, fetchAgentActivitiesAfter, fetchAgentMessagesAfter } from './agents';
import { isAnchorRejected } from '@/lib/activity-live-after';

afterEach(() => vi.unstubAllGlobals());

function serve(status: number, body: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    void url;
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const event = { activityId: 'a1', type: 'tool.call.started', createdAt: '2026-10-05T00:00:00.000Z' };
const entry = { messageId: 'm1', direction: 'in', kind: 'message', platform: 'slack',
  source: { id: 'm1', kind: 'inbox' }, text: 'm1', timestamp: '2026-10-05T00:00:00.000Z' };

it('an after page is recognised only by its readAfter mark', async () => {
  const marked = { readAfter: true, events: [event], afterCursor: 'c1.x', hasMore: false };
  const fetchMock = serve(200, marked);
  expect(await fetchAgentActivitiesAfter('nora', 'c1.anchor', 100)).toEqual(marked);
  const url = new URL(fetchMock.mock.calls[0]![0], 'http://x');
  expect(url.pathname).toBe('/api/agents/nora/activities');
  expect([...url.searchParams]).toEqual([['after', 'c1.anchor'], ['limit', '100']]);

  // A runtime that ignores `after` answers with its newest page: no mark.
  serve(200, { events: [event], nextCursor: 'c1.older' });
  const legacy = await fetchAgentActivitiesAfter('nora', 'c1.anchor');
  expect('readAfter' in legacy).toBe(false);
  expect(legacy).toEqual({ events: [event], nextCursor: 'c1.older' });
  serve(200, { entries: [entry], nextCursor: null });
  const legacyMessages = await fetchAgentMessagesAfter('nora', 'c1.anchor');
  expect('readAfter' in legacyMessages).toBe(false);
  expect(legacyMessages.entries).toEqual([entry]);

  // A half-formed mark is not a mark.
  serve(200, { readAfter: true, events: [event] });
  expect('readAfter' in (await fetchAgentActivitiesAfter('nora', 'c1.anchor'))).toBe(false);
  serve(200, { readAfter: 'yes', entries: [entry], afterCursor: null, hasMore: false });
  expect('readAfter' in (await fetchAgentMessagesAfter('nora', 'c1.anchor'))).toBe(false);
});

it('a first page keeps headCursor through normalisation, and an older runtime simply has none', async () => {
  serve(200, { events: [event], nextCursor: null, headCursor: 'c1.head' });
  expect((await fetchAgentActivities('nora', 100)).headCursor).toBe('c1.head');
  serve(200, { events: [event], nextCursor: null });
  expect('headCursor' in (await fetchAgentActivities('nora', 100))).toBe(false);
});

it('410 and 400 cursor errors are anchor rejections; 503 is a retryable failure', async () => {
  serve(410, { error: 'cursor_expired: anchor_missing; reload the first page.' });
  const expired = await fetchAgentActivitiesAfter('nora', 'c1.anchor').catch((error: unknown) => error);
  expect(isAnchorRejected(expired)).toBe(true);
  serve(400, { error: 'cursor_invalid: Invalid history cursor; reload the first page.' });
  const invalid = await fetchAgentMessagesAfter('nora', 'c1.anchor').catch((error: unknown) => error);
  expect(isAnchorRejected(invalid)).toBe(true);
  serve(503, { error: 'history_unstable: History rotated during the read; retry this page.' });
  const unstable = await fetchAgentActivitiesAfter('nora', 'c1.anchor').catch((error: unknown) => error);
  expect(unstable).toBeInstanceOf(Error);
  expect(isAnchorRejected(unstable)).toBe(false);
});
