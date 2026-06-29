import test from 'node:test';
import assert from 'node:assert/strict';

import { composeChannelList } from '../web/agent-channels.js';
import { memberChannelsResultForAgent } from '../inbox/member-channels.js';
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

function message(over: Partial<AgentMessageRecord> & {
  channelId: string;
  messageId: string;
  timestamp: string;
}): AgentMessageRecord {
  return {
    direction: 'in',
    kind: 'message',
    source: { id: over.messageId, kind: 'activity' },
    text: 'hello',
    ...over,
  };
}

function channelMessage(over: Partial<AgentMessageRecord> & {
  channelId: string;
  messageId: string;
  timestamp: string;
}): AgentMessageRecord {
  return message({
    channelKind: 'channel',
    channelName: 'product',
    ...over,
  });
}

function dmMessage(over: Partial<AgentMessageRecord> & {
  channelId: string;
  messageId: string;
  timestamp: string;
}): AgentMessageRecord {
  return message({
    channelKind: 'dm',
    dmHandle: 'guoqiang',
    ...over,
  });
}

test('channels are derived from local Slack message history', () => {
  const res = composeChannelList({
    subscriptions: [],
    messages: [
      channelMessage({
        channelId: 'C1',
        channelName: 'prod',
        messageId: 'm1',
        timestamp: '2026-06-23T00:00:00.000Z',
      }),
    ],
  });
  assert.deepEqual(res.channels, [{
    id: 'C1',
    name: 'prod',
    platform: 'slack',
    kind: 'channel',
    status: 'following',
    lastActivityAt: '2026-06-23T00:00:00.000Z',
  }]);
});

test('subscription-only channels do not appear without local message history', () => {
  const res = composeChannelList({
    subscriptions: [
      channelSub({
        channelId: 'C-silent',
        mutedAt: '2026-06-21T00:00:00.000Z',
        lastActivityAt: '2026-06-22T10:00:00.000Z',
      }),
    ],
    messages: [],
  });
  assert.equal(res.channels.length, 0);
});

test('historical channels remain visible when local message history exists', () => {
  const res = composeChannelList({
    subscriptions: [],
    messages: [
      channelMessage({
        channelId: 'C-left',
        channelName: 'old-project',
        messageId: 'm-left',
        timestamp: '2026-06-10T00:00:00.000Z',
      }),
    ],
  });
  assert.deepEqual(res.channels.map((channel) => channel.id), ['C-left']);
});

test('muted subscriptions overlay status + timestamps on existing conversations', () => {
  const res = composeChannelList({
    subscriptions: [
      channelSub({
        channelId: 'C2',
        mutedAt: '2026-06-21T00:00:00.000Z',
        lastActivityAt: '2026-06-22T10:00:00.000Z',
        lastPostedAt: '2026-06-22T09:00:00.000Z',
      }),
    ],
    messages: [
      channelMessage({
        channelId: 'C2',
        channelName: 'team',
        messageId: 'm2',
        timestamp: '2026-06-20T00:00:00.000Z',
      }),
    ],
  });
  assert.equal(res.channels.length, 1);
  const c = res.channels[0]!;
  assert.equal(c.status, 'muted');
  assert.equal(c.lastActivityAt, '2026-06-22T10:00:00.000Z');
  assert.equal(c.lastPostedAt, '2026-06-22T09:00:00.000Z');
});

test('DMs are folded from message history with handle, avatar, and latest timestamp', () => {
  const res = composeChannelList({
    subscriptions: [],
    messages: [
      dmMessage({
        channelId: 'D9',
        messageId: 'd1',
        timestamp: '2026-06-23T00:00:00.000Z',
        dmHandle: 'guoqiang',
        actorAvatarUrl: 'https://avatars.example/u.png',
      }),
      dmMessage({
        channelId: 'D9',
        messageId: 'd2',
        timestamp: '2026-06-24T12:00:00.000Z',
        direction: 'out',
      }),
    ],
  });
  assert.equal(res.channels.length, 1);
  assert.deepEqual(res.channels[0], {
    id: 'D9',
    name: 'guoqiang',
    platform: 'slack',
    kind: 'dm',
    status: 'following',
    lastActivityAt: '2026-06-24T12:00:00.000Z',
    lastPostedAt: '2026-06-24T12:00:00.000Z',
    avatarUrl: 'https://avatars.example/u.png',
  });
});

test('Slack rows with no explicit platform are still treated as Slack history', () => {
  const res = composeChannelList({
    subscriptions: [],
    messages: [
      channelMessage({
        channelId: 'C-legacy',
        channelName: 'legacy',
        messageId: 'legacy',
        timestamp: '2026-06-23T00:00:00.000Z',
      }),
    ],
  });
  assert.deepEqual(res.channels.map((channel) => channel.id), ['C-legacy']);
});

test('Feishu and oc_ rows are excluded from the Slack-only Channels tab', () => {
  const res = composeChannelList({
    subscriptions: [channelSub({ channelId: 'oc_feishuchat' })],
    messages: [
      channelMessage({
        channelId: 'oc_feishuchat',
        channelName: '产品群',
        messageId: 'f1',
        platform: 'feishu',
        timestamp: '2026-06-23T00:00:00.000Z',
      }),
      channelMessage({
        channelId: 'C1',
        channelName: 'prod',
        messageId: 's1',
        platform: 'slack',
        timestamp: '2026-06-24T00:00:00.000Z',
      }),
    ],
  });
  assert.deepEqual(res.channels.map((channel) => channel.id), ['C1']);
});

test('channels are sorted by most recent local/subscription activity', () => {
  const res = composeChannelList({
    subscriptions: [channelSub({ channelId: 'C2', lastActivityAt: '2026-06-25T00:00:00.000Z' })],
    messages: [
      channelMessage({
        channelId: 'C1',
        channelName: 'aaa',
        messageId: 'c1',
        timestamp: '2026-06-22T00:00:00.000Z',
      }),
      channelMessage({
        channelId: 'C2',
        channelName: 'bbb',
        messageId: 'c2',
        timestamp: '2026-06-21T00:00:00.000Z',
      }),
      dmMessage({
        channelId: 'D9',
        messageId: 'd9',
        timestamp: '2026-06-24T00:00:00.000Z',
      }),
    ],
  });
  assert.deepEqual(
    res.channels.map((c) => c.id),
    ['C2', 'D9', 'C1'],
  );
});

test('memberChannelsResultForAgent: no Slack token is legitimately empty, not degraded', async () => {
  const res = await memberChannelsResultForAgent({ id: 'a1' });
  assert.deepEqual(res, { channels: [], degraded: false });
});
