import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAgentChannelList, composeChannelList } from '../web/agent-channels.js';
import type { AvatarEnrichmentDeps } from '../web/message-profiles.js';
import { memberChannelsResultForAgent } from '../inbox/member-channels.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import type { SubscriptionRecord } from '../inbox/slack-subscription.service.js';
import type { AgentMessageRecord } from '../../shared/messages.js';
import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';

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

test('buildAgentChannelList decorates DM rows with the inbound sender avatar', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-channels-dm-avatar-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      // Seed one inbound Slack DM (channel id starts with 'D'). The durable
      // ledger never persists the sender avatar, so the row can only get a photo
      // via read-time enrichment.
      await new WakeQueueService('scout').enqueue(
        makeSlackEvent({
          channelId: 'D-bob',
          teamId: 'T-demo',
          text: 'ping',
          userId: 'UBOB1',
          eventId: 'evt-dm-avatar',
          ts: '1770000200.000001',
          timestamp: '2026-05-12T00:00:00.000Z',
        }),
      );

      // Stub the avatar resolver so no real Slack IO happens; it stands in for
      // the cache-first workspace-directory lookup the /messages feed shares.
      const deps: AvatarEnrichmentDeps = {
        loadAgent: async () => ({
          id: 'scout',
          slack: { botToken: 'xoxb-test', teamId: 'T-demo' },
        }),
        getWebClient: async () => ({}),
        resolveAvatar: async ({ userId }) =>
          userId === 'UBOB1' ? 'https://avatars.example/bob.png' : undefined,
      };

      const res = await buildAgentChannelList('scout', deps);
      const dm = res.channels.find((c) => c.id === 'D-bob');
      assert.ok(dm, 'DM channel should be present');
      assert.equal(dm.kind, 'dm');
      assert.equal(dm.avatarUrl, 'https://avatars.example/bob.png');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('buildAgentChannelList leaves DM avatar unset when resolution finds no photo', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-channels-dm-noavatar-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await new WakeQueueService('scout').enqueue(
        makeSlackEvent({
          channelId: 'D-bob',
          teamId: 'T-demo',
          text: 'ping',
          userId: 'UBOB1',
          eventId: 'evt-dm-noavatar',
          ts: '1770000201.000001',
          timestamp: '2026-05-12T00:00:00.000Z',
        }),
      );

      const deps: AvatarEnrichmentDeps = {
        loadAgent: async () => ({
          id: 'scout',
          slack: { botToken: 'xoxb-test', teamId: 'T-demo' },
        }),
        getWebClient: async () => ({}),
        // No photo on file: row degrades to the initial-letter fallback.
        resolveAvatar: async () => undefined,
      };

      const res = await buildAgentChannelList('scout', deps);
      const dm = res.channels.find((c) => c.id === 'D-bob');
      assert.ok(dm, 'DM channel should be present');
      assert.equal(dm.avatarUrl, undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});
