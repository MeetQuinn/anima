import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attentionMapForSubscriptions,
  ensureThreadSubscriptionForSentMessage,
  feishuRuntimeDecision,
  muteSubscriptionForAgent,
  recordOutboundEngagement,
  shouldReply,
  slackRuntimeDecision,
} from '../inbox/slack-subscription.service.js';
import { withAnimaHome } from './anima-home.js';
import { loadState } from './helpers/state.js';
import { SubscriptionStore, type SubscriptionRecord } from '../storage/schema/subscription.store.js';
import type { FeishuInboxItem } from '../../shared/inbox.js';

test('Slack routing replies to DMs without mention', () => {
  assert.equal(
    shouldReply({
      channel: 'D123',
      channel_type: 'im',
      text: 'Can you help?',
      ts: '1770000010.000001',
      type: 'message',
      user: 'U123',
    }),
    true,
  );
});

test('Slack routing replies to explicit channel mentions', () => {
  assert.equal(
    shouldReply({
      channel: 'C123',
      channel_type: 'channel',
      text: '<@U999> summarize this',
      ts: '1770000010.000001',
      type: 'app_mention',
      user: 'U123',
    }),
    true,
  );
});

test('member channel top-level messages wake unless muted', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-channel-follow-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const topLevel = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'top-level member-channel message',
          ts: '1770000011.000001',
          type: 'message',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 2_000 },
      );
      assert.equal(topLevel.shouldStartRuntime, true);
      assert.equal(topLevel.reason, 'channel_follow');
      assert.equal(topLevel.subscription?.kind, 'channel');
      assert.equal(topLevel.subscription?.status, 'following');

      await muteSubscriptionForAgent({
        agentId: 'scout',
        channelId: 'C123',
        nowMs: 3_000,
      });
      const muted = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'muted top-level message',
          ts: '1770000012.000001',
          type: 'message',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 4_000 },
      );
      assert.equal(muted.shouldStartRuntime, false);
      assert.equal(muted.reason, 'muted');

      const mention = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: '<@U999> muted channel pierce',
          ts: '1770000013.000001',
          type: 'app_mention',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 5_000 },
      );
      assert.equal(mention.shouldStartRuntime, true);
      assert.equal(mention.reason, 'mention');

      const stillMuted = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'still muted without mention',
          ts: '1770000014.000001',
          type: 'message',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 6_000 },
      );
      assert.equal(stillMuted.shouldStartRuntime, false);
      assert.equal(stillMuted.reason, 'muted');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('subscription store preserves concurrent replaces', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-subscription-concurrent-replace-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const store = new SubscriptionStore('scout');
      await Promise.all([
        store.replace(channelSubscription({ channelId: 'C-alpha' })),
        store.replace(channelSubscription({ channelId: 'C-beta' })),
      ]);

      assert.deepEqual((await store.list()).map((subscription) => subscription.subscriptionId).sort(), [
        'slack-subscription:scout:C-alpha:channel',
        'slack-subscription:scout:C-beta:channel',
      ]);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('subscription store rejects wrong agent writes and leaves file unchanged', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-subscription-wrong-agent-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const store = new SubscriptionStore('scout');
      await store.replace(channelSubscription({ channelId: 'C-alpha' }));
      const before = await readFile(join(stateDir, 'agents', 'scout', 'subscription.json'), 'utf8');

      await assert.rejects(
        store.replace(channelSubscription({ agentId: 'other', channelId: 'C-beta' })),
        /Cannot write subscription for other through scout store/,
      );

      assert.equal(await readFile(join(stateDir, 'agents', 'scout', 'subscription.json'), 'utf8'), before);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('thread follows are permanent and mute is revived by mention', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-thread-follow-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const mention = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: '<@U999> help here',
          thread_ts: '1770000010.000001',
          ts: '1770000011.000001',
          type: 'app_mention',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 1_000 },
      );
      assert.equal(mention.shouldStartRuntime, true);
      assert.equal(mention.reason, 'mention');
      assert.equal(mention.subscription?.kind, 'thread');

      const muchLater = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'follow-up weeks later',
          thread_ts: '1770000010.000001',
          ts: '1770000012.000001',
          type: 'message',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 30 * 24 * 60 * 60 * 1000 },
      );
      assert.equal(muchLater.shouldStartRuntime, true);
      assert.equal(muchLater.reason, 'thread_follow');

      await muteSubscriptionForAgent({
        agentId: 'scout',
        channelId: 'C123',
        threadTs: '1770000010.000001',
        nowMs: 30 * 24 * 60 * 60 * 1000 + 1,
      });
      const muted = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'muted thread follow-up',
          thread_ts: '1770000010.000001',
          ts: '1770000013.000001',
          type: 'message',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 30 * 24 * 60 * 60 * 1000 + 2 },
      );
      assert.equal(muted.shouldStartRuntime, false);
      assert.equal(muted.reason, 'muted');

      const revived = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: '<@U999> come back',
          thread_ts: '1770000010.000001',
          ts: '1770000014.000001',
          type: 'app_mention',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 30 * 24 * 60 * 60 * 1000 + 3 },
      );
      assert.equal(revived.shouldStartRuntime, true);
      assert.equal(revived.reason, 'mention');
      assert.equal(revived.subscription?.status, 'following');

      const state = await loadState();
      const thread = Object.values(state.subscriptions).find(
        (subscription) => subscription.kind === 'thread' && subscription.threadTs === '1770000010.000001',
      );
      assert.equal(thread?.mutedAt, undefined);
      assert.equal('expiresAt' in (thread ?? {}), false);
      assert.equal('remainingMessages' in (thread ?? {}), false);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('sent messages follow only threads, not whole channels', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-sent-thread-follow-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const sentSubscription = await ensureThreadSubscriptionForSentMessage({
        agentId: 'scout',
        channelId: 'C123',
        messageTs: '1770000020.000001',
        nowMs: 1_000,
      });
      assert.equal(sentSubscription?.kind, 'thread');
      assert.equal(sentSubscription?.threadTs, '1770000020.000001');
      const state = await loadState();
      assert.equal(Object.values(state.subscriptions).some((subscription) => subscription.kind === 'channel'), false);

      const reply = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'replying in the agent-started thread',
          thread_ts: '1770000020.000001',
          ts: '1770000021.000001',
          type: 'message',
          user: 'U456',
        },
        { agentId: 'scout', nowMs: 2_000 },
      );
      assert.equal(reply.shouldStartRuntime, true);
      assert.equal(reply.reason, 'thread_follow');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('sent replies also follow their own message thread root', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-sent-reply-thread-follow-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const sentSubscription = await ensureThreadSubscriptionForSentMessage({
        agentId: 'scout',
        channelId: 'C123',
        messageTs: '1770000020.000123',
        nowMs: 1_000,
        threadTs: '1770000010.000001',
      });
      assert.equal(sentSubscription?.kind, 'thread');
      assert.equal(sentSubscription?.threadTs, '1770000010.000001');
      const state = await loadState();
      assert.equal(Object.values(state.subscriptions).some((subscription) => subscription.kind === 'channel'), false);
      assert.ok(Object.values(state.subscriptions).some(
        (subscription) => subscription.kind === 'thread' && subscription.threadTs === '1770000010.000001',
      ));
      assert.ok(Object.values(state.subscriptions).some(
        (subscription) => subscription.kind === 'thread' && subscription.threadTs === '1770000020.000123',
      ));

      const replyToSentReply = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'replying to the agent reply as its own thread',
          thread_ts: '1770000020.000123',
          ts: '1770000021.000001',
          type: 'message',
          user: 'U456',
        },
        { agentId: 'scout', nowMs: 2_000 },
      );
      assert.equal(replyToSentReply.shouldStartRuntime, true);
      assert.equal(replyToSentReply.reason, 'thread_follow');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('attention nudge suggests muting after repeated wakes without posting', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-attention-nudge-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      let last;
      for (let i = 0; i < 6; i += 1) {
        last = await slackRuntimeDecision(
          {
            channel: 'C123',
            channel_type: 'channel',
            text: `wake ${i}`,
            ts: `17700000${10 + i}.000001`,
            type: 'message',
            user: 'U123',
          },
          { agentId: 'scout', nowMs: 1_000 + i },
        );
      }
      assert.equal(last?.shouldStartRuntime, true);
      assert.match(last?.attentionSuggestion ?? '', /anima subscription mute --channel C123/);

      await recordOutboundEngagement({ agentId: 'scout', channelId: 'C123', nowMs: 2_000 });
      const afterPost = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'after post',
          ts: '1770000020.000001',
          type: 'message',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 2_001 },
      );
      assert.equal(afterPost.attentionSuggestion, undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('chronic attention nudge requires twelve wakes across a real silent span', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-chronic-attention-nudge-test-'));
  const sixHours = 6 * 60 * 60 * 1000;
  const seventyTwoHours = 72 * 60 * 60 * 1000;
  try {
    await withAnimaHome(stateDir, async () => {
      let last;
      for (let i = 0; i < 12; i += 1) {
        last = await slackRuntimeDecision(
          {
            channel: 'C123',
            channel_type: 'channel',
            text: `sparse wake ${i}`,
            ts: `17700001${10 + i}.000001`,
            type: 'message',
            user: 'U123',
          },
          { agentId: 'scout', nowMs: i * sixHours },
        );
      }
      assert.equal(last?.attentionSuggestion, undefined);

      last = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'after a real silent span',
          ts: '1770000200.000001',
          type: 'message',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: seventyTwoHours + 1 },
      );
      assert.match(last?.attentionSuggestion ?? '', /anima subscription mute --channel C123/);

      const state = await loadState();
      const channel = state.subscriptions['slack-subscription:scout:C123:channel'];
      assert.equal(channel?.wakesSinceLastPost, 0);
      assert.equal(channel?.silentWakeStartedAt, undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('outbound engagement resets chronic and burst attention windows', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-attention-engagement-reset-test-'));
  const eightHours = 8 * 60 * 60 * 1000;
  try {
    await withAnimaHome(stateDir, async () => {
      for (let i = 0; i < 11; i += 1) {
        await slackRuntimeDecision(
          {
            channel: 'C123',
            channel_type: 'channel',
            text: `wake ${i}`,
            ts: `17700002${10 + i}.000001`,
            type: 'message',
            user: 'U123',
          },
          { agentId: 'scout', nowMs: i * eightHours },
        );
      }

      await recordOutboundEngagement({ agentId: 'scout', channelId: 'C123', nowMs: 12 * eightHours });
      const state = await loadState();
      const channel = state.subscriptions['slack-subscription:scout:C123:channel'];
      assert.equal(channel?.wakeCount, 0);
      assert.equal(channel?.wakesSinceLastPost, 0);
      assert.equal(channel?.silentWakeStartedAt, undefined);

      const afterEngagement = await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: 'after reaction or post',
          ts: '1770000300.000001',
          type: 'message',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: 12 * eightHours + 1 },
      );
      assert.equal(afterEngagement.attentionSuggestion, undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('attention map shows member channels, muted threads, and quiet thread tails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-attention-map-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await slackRuntimeDecision(
        {
          channel: 'C123',
          channel_type: 'channel',
          text: '<@U999> recent',
          thread_ts: '1770000010.000001',
          ts: '1770000011.000001',
          type: 'app_mention',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: Date.UTC(2026, 0, 10) },
      );
      await ensureThreadSubscriptionForSentMessage({
        agentId: 'scout',
        channelId: 'C123',
        messageTs: '1770000001.000001',
        nowMs: Date.UTC(2025, 0, 1),
      });
      await muteSubscriptionForAgent({
        agentId: 'scout',
        channelId: 'C456',
        threadTs: '1770000030.000001',
        nowMs: Date.UTC(2026, 0, 11),
      });

      const subscriptions = Object.values((await loadState()).subscriptions);
      const map = attentionMapForSubscriptions({
        memberChannels: [{ id: 'C123', name: 'team' }, { id: 'C999', name: 'support' }],
        nowMs: Date.UTC(2026, 0, 12),
        subscriptions,
      });
      assert.deepEqual(
        map.channels.map((channel) => `${channel.channelId}:${channel.status}`).sort(),
        ['C999:following', 'C123:following'].sort(),
      );
      assert.equal(map.activeThreads.length, 1);
      assert.equal(map.mutedThreads.length, 1);
      assert.equal(map.quietThreadCount, 1);
      assert.equal(map.quietThreads.length, 0);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu group chats wake until muted, matching Slack channel follow semantics', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-channel-follow-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const topLevel = await feishuRuntimeDecision(
        makeFeishuItem({ messageId: 'om_follow_1', text: 'top-level group message' }),
        { agentId: 'scout', nowMs: 2_000 },
      );
      assert.equal(topLevel.shouldStartRuntime, true);
      assert.equal(topLevel.reason, 'channel_follow');
      assert.equal(topLevel.subscription?.kind, 'channel');
      assert.equal(topLevel.subscription?.status, 'following');

      await muteSubscriptionForAgent({
        agentId: 'scout',
        channelId: 'oc_group',
        nowMs: 3_000,
      });
      const muted = await feishuRuntimeDecision(
        makeFeishuItem({ messageId: 'om_follow_2', text: 'muted group message' }),
        { agentId: 'scout', nowMs: 4_000 },
      );
      assert.equal(muted.shouldStartRuntime, false);
      assert.equal(muted.reason, 'muted');

      const mention = await feishuRuntimeDecision(
        makeFeishuItem({ messageId: 'om_follow_3', text: '@Anima muted group pierce' }),
        { agentId: 'scout', mentioned: true, nowMs: 5_000 },
      );
      assert.equal(mention.shouldStartRuntime, true);
      assert.equal(mention.reason, 'mention');

      const stillMuted = await feishuRuntimeDecision(
        makeFeishuItem({ messageId: 'om_follow_4', text: 'still muted without mention' }),
        { agentId: 'scout', nowMs: 6_000 },
      );
      assert.equal(stillMuted.shouldStartRuntime, false);
      assert.equal(stillMuted.reason, 'muted');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu attention nudge suggests muting the oc chat id after repeated wakes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-attention-nudge-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      let last;
      for (let i = 0; i < 6; i += 1) {
        last = await feishuRuntimeDecision(
          makeFeishuItem({ messageId: `om_nudge_${i}`, text: `wake ${i}` }),
          { agentId: 'scout', nowMs: 1_000 + i },
        );
      }
      assert.equal(last?.shouldStartRuntime, true);
      assert.match(last?.attentionSuggestion ?? '', /anima subscription mute --chat-id oc_group/);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

function makeFeishuItem(input: {
  chatId?: string;
  chatType?: string;
  messageId: string;
  text: string;
}): FeishuInboxItem {
  return {
    actor: { openId: 'ou_alice', senderType: 'user' },
    appId: 'cli_test',
    chatId: input.chatId ?? 'oc_group',
    chatType: input.chatType ?? 'group',
    handling: {
      createdAt: '2026-06-05T07:00:00.000Z',
      queuedAt: '2026-06-05T07:00:00.000Z',
      status: 'queued',
      updatedAt: '2026-06-05T07:00:00.000Z',
    },
    id: `feishu:tenant_test:${input.chatId ?? 'oc_group'}:${input.messageId}`,
    kind: 'feishu',
    messageId: input.messageId,
    receivedAt: '2026-06-05T07:00:00.000Z',
    tenantKey: 'tenant_test',
    text: input.text,
  };
}

function channelSubscription(
  overrides: {
    agentId?: string;
    channelId: string;
    subscriptionId?: string;
    updatedAt?: string;
  },
): SubscriptionRecord {
  const agentId = overrides.agentId ?? 'scout';
  return {
    agentId,
    channelId: overrides.channelId,
    kind: 'channel',
    subscriptionId: overrides.subscriptionId ?? `slack-subscription:${agentId}:${overrides.channelId}:channel`,
    updatedAt: overrides.updatedAt ?? '2026-06-05T07:00:00.000Z',
  };
}
