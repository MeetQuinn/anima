import { describe, expect, it } from 'vitest';

import { buildActivityAuthorResolvers } from './activity-authors';
import {
  activityCoverageDecision,
  atomRank,
  buildBlocks,
  buildConversationItems,
  buildStepItems,
  buildTimelineByDay,
  currentTurnHasStep,
  isSpecialSystemStep,
  latestCurrentItemActivity,
  latestMessageKey,
  mergeActivityPages,
  mergeMessagePages,
  oldestActivityTimestamp,
  oldestConversationTimestamp,
  sortConversationItems,
  type Step,
} from './activity-timeline';
import type { ActivityFeedItem } from './activity-feed';
import type { Activity, AgentActivityFeedPage } from '@shared/activity';
import type { AgentConfig } from '@shared/agent-config';
import type { AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';

function activity(activityId: string, type: string, createdAt: string, payload = {}): Activity {
  return { activityId, type, createdAt, payload };
}

function step(activityId: string, type: string, timestamp: string, payload = {}): Step {
  const record = activity(activityId, type, timestamp, payload);
  return { kind: 'step', activity: record, timestamp };
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

function messageIn(
  messageId: string,
  timestamp: string,
): Extract<ActivityFeedItem, { kind: 'message-in' }> {
  return {
    kind: 'message-in',
    message: message(messageId, timestamp),
    timestamp,
    surface: { kind: 'channel', label: '#ops', channelId: 'C1' },
  };
}

describe('activity timeline builders', () => {
  it('merges activity pages by activityId and lets later pages replace duplicates', () => {
    const pages: AgentActivityFeedPage[] = [
      {
        events: [
          activity('a1', 'tool.call.started', '2026-07-04T10:00:00.000Z'),
          activity('dup', 'tool.call.started', '2026-07-04T10:01:00.000Z', { value: 'old' }),
        ],
        nextCursor: 'older',
      },
      {
        events: [
          activity('dup', 'tool.call.completed', '2026-07-04T10:02:00.000Z', { value: 'new' }),
          activity('a2', 'runtime.completed', '2026-07-04T10:03:00.000Z'),
        ],
        nextCursor: null,
      },
    ];

    expect(mergeActivityPages(pages)?.events.map((event) => [event.activityId, event.type])).toEqual([
      ['a1', 'tool.call.started'],
      ['dup', 'tool.call.completed'],
      ['a2', 'runtime.completed'],
    ]);
    expect(mergeActivityPages(undefined)).toBeUndefined();
  });

  it('merges message pages by messageId and lets later pages replace duplicates', () => {
    const pages: AgentMessageHistoryPage[] = [
      { entries: [message('m1', '2026-07-04T10:00:00.000Z'), message('dup', '2026-07-04T10:01:00.000Z', 'old')] },
      { entries: [message('dup', '2026-07-04T10:02:00.000Z', 'new'), message('m2', '2026-07-04T10:03:00.000Z')] },
    ];

    expect(mergeMessagePages(pages)?.entries.map((entry) => [entry.messageId, entry.text])).toEqual([
      ['m1', 'm1'],
      ['dup', 'new'],
      ['m2', 'm2'],
    ]);
    expect(mergeMessagePages(undefined)).toBeUndefined();
  });

  it('builds conversation items and keeps system events with message rows', () => {
    const items = buildConversationItems({
      entries: [
        message('m1', '2026-07-04T10:00:00.000Z'),
        {
          ...message('reminder-1', '2026-07-04T10:01:00.000Z'),
          kind: 'reminder',
          reminderTitle: 'Standup',
        },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(['message-in', 'system-event']);
  });

  it('builds narrative step items and suppresses started rows with matching failure rows', () => {
    const started = activity('started', 'tool.call.started', '2026-07-04T10:00:00.000Z', {
      providerToolId: 'toolu_1',
      providerToolName: 'Bash',
    });
    const failed = activity('failed', 'tool.call.failed', '2026-07-04T10:01:00.000Z', {
      providerToolId: 'toolu_1',
      providerToolName: 'Bash',
      error: 'nope',
    });

    expect(buildStepItems({ events: [started, failed] }).map((item) => item.activity.activityId)).toEqual([
      'failed',
    ]);
    expect(buildStepItems(undefined)).toEqual([]);
  });

  it('sorts conversation items and derives latest keys', () => {
    const items = [
      messageIn('late', '2026-07-04T10:02:00.000Z'),
      messageIn('early', '2026-07-04T10:00:00.000Z'),
    ];

    expect(
      sortConversationItems(items).map((item) => {
        if (item.kind !== 'message-in') throw new Error('expected inbound message');
        return item.message.messageId;
      }),
    ).toEqual(['early', 'late']);
    expect(latestMessageKey(items)).toBe('2|2026-07-04T10:02:00.000Z');
    expect(latestMessageKey([])).toBeNull();
  });

  it('groups blocks by adjacent system/message/step type', () => {
    const system: Extract<ActivityFeedItem, { kind: 'system-event' }> = {
      kind: 'system-event',
      eventKind: 'reminder',
      label: 'Reminder',
      body: 'Standup',
      timestamp: '2026-07-04T10:01:00.000Z',
    };

    expect(buildBlocks([messageIn('m1', '2026-07-04T10:00:00.000Z'), system, messageIn('m2', '2026-07-04T10:02:00.000Z')]).map((block) => block.type)).toEqual([
      'msgs',
      'system',
      'msgs',
    ]);
  });

  it('builds day buckets, fold runs, lifecycle rows, and fold boundaries', () => {
    const conversation = [
      messageIn('m1', '2026-07-04T10:00:00.000Z'),
      messageIn('m2', '2026-07-04T10:05:00.000Z'),
      messageIn('m3', '2026-07-05T10:00:00.000Z'),
    ];
    const steps = [
      step('s1', 'tool.call.started', '2026-07-04T10:01:00.000Z'),
      step('s2', 'tool.call.completed', '2026-07-04T10:02:00.000Z'),
      step('life', 'runtime.aborted', '2026-07-04T10:03:00.000Z'),
      step('s3', 'runtime.completed', '2026-07-04T10:04:00.000Z'),
      step('s4', 'tool.call.started', '2026-07-05T09:00:00.000Z'),
    ];

    const timeline = buildTimelineByDay(conversation, steps);

    expect(timeline.map(([day]) => day)).toEqual(['2026-07-04', '2026-07-05']);
    expect(timeline[0]![1].map((entry) => entry.type)).toEqual([
      'conv',
      'fold',
      'lifecycle',
      'fold',
      'conv',
    ]);
    expect(timeline[0]![1][1]).toMatchObject({ type: 'fold', id: 'fold:s1' });
    expect(timeline[0]![1][1]!.type === 'fold' && timeline[0]![1][1]!.steps.map((item) => item.activity.activityId)).toEqual([
      's1',
      's2',
    ]);
    expect(timeline[1]![1].map((entry) => entry.type)).toEqual(['fold', 'conv']);
  });

  it('ranks same-timestamp atoms with inbound first and idle folds last', () => {
    expect(atomRank('conv-in', false)).toBeLessThan(atomRank('conv-out', false));
    expect(atomRank('fold', true)).toBeGreaterThan(atomRank('fold', false));
    expect(isSpecialSystemStep(activity('life', 'memory_coherence.outcome', '2026-07-04T10:00:00.000Z'))).toBe(true);
  });

  it('calculates coverage decisions for spanning, non-spanning, exhausted, and empty cases', () => {
    expect(
      activityCoverageDecision({
        oldestMessageTs: Date.parse('2026-07-04T10:00:00.000Z'),
        oldestActivityTs: Date.parse('2026-07-04T09:59:00.000Z'),
        interleaving: true,
        hasNextActivityPage: true,
        isFetchingNextActivityPage: false,
      }),
    ).toEqual({ activityCoversMessages: true, shouldFetchMoreActivity: false });
    expect(
      activityCoverageDecision({
        oldestMessageTs: Date.parse('2026-07-04T10:00:00.000Z'),
        oldestActivityTs: Date.parse('2026-07-04T10:01:00.000Z'),
        interleaving: true,
        hasNextActivityPage: true,
        isFetchingNextActivityPage: false,
      }),
    ).toEqual({ activityCoversMessages: false, shouldFetchMoreActivity: true });
    expect(
      activityCoverageDecision({
        oldestMessageTs: Date.parse('2026-07-04T10:00:00.000Z'),
        oldestActivityTs: Date.parse('2026-07-04T10:01:00.000Z'),
        interleaving: true,
        hasNextActivityPage: false,
        isFetchingNextActivityPage: false,
      }),
    ).toEqual({ activityCoversMessages: false, shouldFetchMoreActivity: false });
    expect(
      activityCoverageDecision({
        oldestMessageTs: null,
        oldestActivityTs: null,
        interleaving: true,
        hasNextActivityPage: true,
        isFetchingNextActivityPage: false,
      }),
    ).toEqual({ activityCoversMessages: true, shouldFetchMoreActivity: false });
  });

  it('finds oldest loaded timestamps and latest current item activity', () => {
    const activities = {
      events: [
        activity('old', 'tool.call.started', '2026-07-04T09:00:00.000Z'),
        activity('new', 'tool.call.completed', '2026-07-04T11:00:00.000Z'),
      ],
    };

    expect(oldestConversationTimestamp([messageIn('m1', '2026-07-04T10:00:00.000Z')])).toBe(
      Date.parse('2026-07-04T10:00:00.000Z'),
    );
    expect(oldestConversationTimestamp([])).toBeNull();
    expect(oldestActivityTimestamp(activities)).toBe(Date.parse('2026-07-04T09:00:00.000Z'));
    expect(oldestActivityTimestamp(undefined)).toBeNull();
    expect(
      latestCurrentItemActivity({
        currentItemId: 'item-1',
        currentItemStartedAt: '2026-07-04T10:00:00.000Z',
        activitiesData: activities,
      })?.activityId,
    ).toBe('new');
  });

  it('detects whether the current turn has a rendered non-lifecycle step', () => {
    expect(
      currentTurnHasStep({
        currentItemId: 'item-1',
        currentItemStartedAt: '2026-07-04T10:00:00.000Z',
        stepItems: [
          step('life', 'runtime.aborted', '2026-07-04T10:01:00.000Z'),
          step('visible', 'tool.call.started', '2026-07-04T10:02:00.000Z'),
        ],
      }),
    ).toBe(true);
    expect(
      currentTurnHasStep({
        currentItemId: 'item-1',
        currentItemStartedAt: '2026-07-04T10:00:00.000Z',
        stepItems: [step('life', 'runtime.aborted', '2026-07-04T10:01:00.000Z')],
      }),
    ).toBe(false);
  });
});

describe('activity author builders', () => {
  it('builds agent, inbound, and surface resolvers', () => {
    const agent = {
      id: 'agent-1',
      profile: { displayName: 'Ada Agent' },
      slack: { connected: true, avatarUrl: 'https://example.test/avatar.png' },
    } as unknown as AgentConfig;
    const { agentAuthor, resolveAuthor, resolveSurface } = buildActivityAuthorResolvers({
      agent,
      agentId: 'agent-1',
    });
    const inbound = {
      ...messageIn('m1', '2026-07-04T10:00:00.000Z'),
      avatarUrl: 'https://example.test/user.png',
      message: {
        ...message('m1', '2026-07-04T10:00:00.000Z'),
        actorDisplayName: 'Grace Hopper',
        actorUserId: 'U123',
      },
    };

    expect(agentAuthor).toMatchObject({
      key: 'agent',
      name: 'Ada Agent',
      avatarUrl: 'https://example.test/avatar.png',
      initial: 'A',
      isAgent: true,
    });
    expect(resolveAuthor(inbound)).toEqual({
      key: 'in:U123',
      name: 'Grace Hopper',
      avatarUrl: 'https://example.test/user.png',
      initial: 'G',
      isAgent: false,
    });
    expect(resolveAuthor({ kind: 'message-out', text: 'ok', timestamp: '2026-07-04T10:01:00.000Z', surface: { kind: 'dm', label: '@totoday' }, isEdit: false })).toBe(agentAuthor);
    expect(resolveSurface(inbound)).toEqual({
      key: 'channel:#ops',
      chip: { kind: 'channel', label: '#ops', channelId: 'C1' },
    });
  });
});
