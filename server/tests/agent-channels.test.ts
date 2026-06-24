import test from 'node:test';
import assert from 'node:assert/strict';

import { composeChannelList } from '../web/agent-channels.js';
import type { SubscriptionRecord } from '../inbox/slack-subscription.service.js';
import type { AgentMessageRecord } from '../../shared/messages.js';

function channelSub(over: Partial<SubscriptionRecord> & { channelId: string }): SubscriptionRecord {
  return {
    kind: 'channel',
    agentId: 'a1',
    subscriptionId: `sub-${over.channelId}`,
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...over,
  } as SubscriptionRecord;
}

function dmMessage(over: Partial<AgentMessageRecord> & { channelId: string; timestamp: string }): AgentMessageRecord {
  return {
    direction: 'in',
    kind: 'message',
    messageId: `m-${over.channelId}-${over.timestamp}`,
    source: { id: 's', kind: 'activity' },
    text: 'hi',
    channelKind: 'dm',
    ...over,
  };
}

test('member channels appear as following even with no subscription or messages', () => {
  const res = composeChannelList({
    memberChannels: [{ id: 'C1', name: 'prod' }],
    subscriptions: [],
    messages: [],
  });
  assert.equal(res.channels.length, 1);
  assert.deepEqual(res.channels[0], {
    id: 'C1',
    name: 'prod',
    platform: 'slack',
    kind: 'channel',
    status: 'following',
  });
});

test('muted subscription carries status + activity timestamps', () => {
  const res = composeChannelList({
    memberChannels: [{ id: 'C2', name: 'team' }],
    subscriptions: [
      channelSub({
        channelId: 'C2',
        mutedAt: '2026-06-21T00:00:00.000Z',
        lastActivityAt: '2026-06-22T10:00:00.000Z',
        lastPostedAt: '2026-06-22T09:00:00.000Z',
      }),
    ],
    messages: [],
  });
  assert.equal(res.channels.length, 1);
  const c = res.channels[0]!;
  assert.equal(c.status, 'muted');
  assert.equal(c.lastActivityAt, '2026-06-22T10:00:00.000Z');
  assert.equal(c.lastPostedAt, '2026-06-22T09:00:00.000Z');
});

test('Feishu (oc_) subscriptions are excluded in Slack-only v1', () => {
  const res = composeChannelList({
    memberChannels: [],
    subscriptions: [channelSub({ channelId: 'oc_feishuchat' })],
    messages: [],
  });
  assert.equal(res.channels.length, 0);
});

test('DMs are folded from message history with dmHandle as name', () => {
  const res = composeChannelList({
    memberChannels: [],
    subscriptions: [],
    messages: [dmMessage({ channelId: 'D9', timestamp: '2026-06-23T00:00:00.000Z', dmHandle: 'guoqiang' })],
  });
  assert.equal(res.channels.length, 1);
  assert.deepEqual(res.channels[0], {
    id: 'D9',
    name: 'guoqiang',
    platform: 'slack',
    kind: 'dm',
    status: 'following',
    lastActivityAt: '2026-06-23T00:00:00.000Z',
  });
});

test('duplicate DM messages collapse to one row at the latest timestamp', () => {
  const res = composeChannelList({
    memberChannels: [],
    subscriptions: [],
    messages: [
      dmMessage({ channelId: 'D9', timestamp: '2026-06-23T00:00:00.000Z', dmHandle: 'guoqiang' }),
      dmMessage({ channelId: 'D9', timestamp: '2026-06-24T12:00:00.000Z', direction: 'out' }),
    ],
  });
  assert.equal(res.channels.length, 1);
  assert.equal(res.channels[0]!.lastActivityAt, '2026-06-24T12:00:00.000Z');
  assert.equal(res.channels[0]!.name, 'guoqiang');
});

test('a DM muted as a subscription still renders with kind dm (D-prefix)', () => {
  const res = composeChannelList({
    memberChannels: [],
    subscriptions: [channelSub({ channelId: 'D5', mutedAt: '2026-06-21T00:00:00.000Z' })],
    messages: [],
  });
  assert.equal(res.channels.length, 1);
  assert.equal(res.channels[0]!.kind, 'dm');
  assert.equal(res.channels[0]!.status, 'muted');
});

test('channels are sorted by most recent activity, undated last', () => {
  const res = composeChannelList({
    memberChannels: [{ id: 'C1', name: 'aaa' }],
    subscriptions: [channelSub({ channelId: 'C2', lastActivityAt: '2026-06-22T00:00:00.000Z' })],
    messages: [dmMessage({ channelId: 'D9', timestamp: '2026-06-24T00:00:00.000Z', dmHandle: 'z' })],
  });
  assert.deepEqual(
    res.channels.map((c) => c.id),
    ['D9', 'C2', 'C1'],
  );
});
