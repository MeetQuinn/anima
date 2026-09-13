import { describe, expect, it } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';

import { mergeLatestActivityPage, mergeLatestMessagePage } from './activity-live-merge';
import { mergeActivityPages } from './activity-timeline';
import type { Activity, AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';

function activity(activityId: string, createdAt: string, payload = {}): Activity {
  return { activityId, type: 'tool.call.started', createdAt, payload };
}

function message(messageId: string, timestamp: string, text = messageId): AgentMessageRecord {
  return {
    direction: 'in',
    kind: 'message',
    messageId,
    platform: 'slack',
    source: { id: messageId, kind: 'inbox' },
    text,
    timestamp,
  };
}

type ActivityData = InfiniteData<AgentActivityFeedPage, string | undefined>;
type MessageData = InfiniteData<AgentMessageHistoryPage, string | undefined>;

// Two loaded activity pages: page 0 is the newest window (oldest→newest inside),
// page 1 is the older window fetched with `before`.
function activityCache(): ActivityData {
  return {
    pages: [
      {
        events: [activity('a3', '2026-09-13T10:03:00.000Z'), activity('a4', '2026-09-13T10:04:00.000Z')],
        nextCursor: '2026-09-13T10:03:00.000Z',
      },
      {
        events: [activity('a1', '2026-09-13T10:01:00.000Z'), activity('a2', '2026-09-13T10:02:00.000Z')],
        nextCursor: null,
      },
    ],
    pageParams: [undefined, '2026-09-13T10:03:00.000Z'],
  };
}

describe('mergeLatestActivityPage', () => {
  it('returns the same cache reference when the newest page brings nothing new', () => {
    const prev = activityCache();
    // The server hands back fresh (deep-equal) objects on every poll.
    const latest: AgentActivityFeedPage = {
      events: [activity('a3', '2026-09-13T10:03:00.000Z'), activity('a4', '2026-09-13T10:04:00.000Z')],
      nextCursor: '2026-09-13T10:03:00.000Z',
    };
    const result = mergeLatestActivityPage(prev, latest);
    expect(result.changed).toBe(false);
    expect(result.data).toBe(prev);
    expect(result.gap).toBe(false);

    // Positive control for the identity claim: the old path (rebuilding from
    // refetched pages) always produced a new array even for identical data.
    const rebuilt = mergeActivityPages([latest, prev.pages[1]!]);
    expect(rebuilt?.events).not.toBe(mergeActivityPages(prev.pages)?.events);
  });

  it('appends unknown events to the end of page 0 and leaves older pages by identity', () => {
    const prev = activityCache();
    const a5 = activity('a5', '2026-09-13T10:05:00.000Z');
    const latest: AgentActivityFeedPage = {
      events: [activity('a4', '2026-09-13T10:04:00.000Z'), a5],
      nextCursor: '2026-09-13T10:04:00.000Z',
    };
    const result = mergeLatestActivityPage(prev, latest);
    expect(result.changed).toBe(true);
    expect(result.added).toBe(1);
    expect(result.replaced).toBe(0);
    expect(result.gap).toBe(false);
    expect(result.data!.pages[0]!.events.map((e) => e.activityId)).toEqual(['a3', 'a4', 'a5']);
    expect(result.data!.pages[0]!.events[1]).toBe(prev.pages[0]!.events[1]);
    expect(result.data!.pages[1]).toBe(prev.pages[1]);
    expect(result.data!.pageParams).toBe(prev.pageParams);
    // The page cursor is not touched: it still points at the older window.
    expect(result.data!.pages[0]!.nextCursor).toBe(prev.pages[0]!.nextCursor);
  });

  it('replaces a rewritten record in place and keeps identical siblings by identity', () => {
    const prev = activityCache();
    const latest: AgentActivityFeedPage = {
      events: [
        activity('a3', '2026-09-13T10:03:00.000Z'),
        activity('a4', '2026-09-13T10:04:00.000Z', { error: 'timeout' }),
      ],
      nextCursor: null,
    };
    const result = mergeLatestActivityPage(prev, latest);
    expect(result.changed).toBe(true);
    expect(result.added).toBe(0);
    expect(result.replaced).toBe(1);
    expect(result.data!.pages[0]!.events[0]).toBe(prev.pages[0]!.events[0]);
    expect(result.data!.pages[0]!.events[1]!.payload).toEqual({ error: 'timeout' });
    expect(result.data!.pages[1]).toBe(prev.pages[1]);
  });

  it('flags a gap when the newest page shares nothing with a non-empty cache', () => {
    const prev = activityCache();
    const latest: AgentActivityFeedPage = {
      events: [activity('b1', '2026-09-13T11:00:00.000Z'), activity('b2', '2026-09-13T11:01:00.000Z')],
      nextCursor: '2026-09-13T11:00:00.000Z',
    };
    const result = mergeLatestActivityPage(prev, latest);
    expect(result.gap).toBe(true);
    // The events are still appended (better than dropping them); the caller
    // decides whether to bridge the gap with a full refetch.
    expect(result.added).toBe(2);
    // Control: an overlapping page is not a gap.
    expect(
      mergeLatestActivityPage(prev, {
        events: [activity('a4', '2026-09-13T10:04:00.000Z'), activity('b1', '2026-09-13T11:00:00.000Z')],
        nextCursor: null,
      }).gap,
    ).toBe(false);
  });

  it('does nothing without a loaded cache', () => {
    const latest: AgentActivityFeedPage = { events: [activity('a1', '2026-09-13T10:01:00.000Z')] };
    expect(mergeLatestActivityPage(undefined, latest)).toMatchObject({ changed: false, data: undefined });
    const empty: ActivityData = { pages: [], pageParams: [] };
    expect(mergeLatestActivityPage(empty, latest).data).toBe(empty);
  });
});

describe('mergeLatestMessagePage', () => {
  it('prepends unknown entries to page 0 (pages are newest→oldest) and shares the rest', () => {
    const prev: MessageData = {
      pages: [
        { entries: [message('m4', '2026-09-13T10:04:00.000Z'), message('m3', '2026-09-13T10:03:00.000Z')] },
        { entries: [message('m2', '2026-09-13T10:02:00.000Z'), message('m1', '2026-09-13T10:01:00.000Z')] },
      ],
      pageParams: [undefined, '2026-09-13T10:03:00.000Z'],
    };
    const same = mergeLatestMessagePage(prev, {
      entries: [message('m4', '2026-09-13T10:04:00.000Z'), message('m3', '2026-09-13T10:03:00.000Z')],
    });
    expect(same.changed).toBe(false);
    expect(same.data).toBe(prev);

    const grown = mergeLatestMessagePage(prev, {
      entries: [
        message('m5', '2026-09-13T10:05:00.000Z'),
        message('m4', '2026-09-13T10:04:00.000Z', 'edited'),
      ],
    });
    expect(grown.changed).toBe(true);
    expect(grown.added).toBe(1);
    expect(grown.replaced).toBe(1);
    expect(grown.data!.pages[0]!.entries.map((e) => [e.messageId, e.text])).toEqual([
      ['m5', 'm5'],
      ['m4', 'edited'],
      ['m3', 'm3'],
    ]);
    expect(grown.data!.pages[0]!.entries[2]).toBe(prev.pages[0]!.entries[1]);
    expect(grown.data!.pages[1]).toBe(prev.pages[1]);
  });
});
