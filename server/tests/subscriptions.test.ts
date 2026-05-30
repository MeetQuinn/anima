import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attentionMapForSubscriptions,
  ensureThreadSubscriptionForSentMessage,
  muteSubscriptionForAgent,
  recordChannelPost,
  shouldReply,
  slackRuntimeDecision,
} from '../inbox/slack-subscription.service.js';
import { withAnimaHome } from './anima-home.js';
import { loadState } from './helpers/state.js';

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

      await recordChannelPost({ agentId: 'scout', channelId: 'C123', nowMs: 2_000 });
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
