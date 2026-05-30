import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { allActivities, loadState } from './helpers/state.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { slackRuntimeDecision } from '../inbox/slack-subscription.service.js';
import { clearActiveRuntimeItem, setActiveRuntimeItem } from '../runtime/active-item.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { withAnimaHome } from './anima-home.js';

const adminCliPath = resolve('dist/server/cli/animactl.js');
const cliPath = resolve('dist/server/cli/anima.js');

test('message send records an audited Slack output', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-test-'));
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'users.list') {
      return {
        members: [{ id: 'U123', name: 'alice' }],
        ok: true,
      };
    }
    if (method === 'conversations.list') {
      return {
        channels: [{ id: 'C-product', name: 'product', name_normalized: 'product' }],
        ok: true,
      };
    }
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'conversations.members') {
      return {
        members: ['U123'],
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as { channel: string; text: string; thread_ts?: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000200.000123',
    };
  });
  try {
    await withAnimaHome(stateDir, async () => {
    await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
    await slackRuntimeDecision(
      {
        channel: 'C-product',
        channel_type: 'channel',
        text: '<@U-scout> help in channel',
        ts: '1770000100.000001',
        type: 'app_mention',
        user: 'U123',
      },
      { agentId: 'scout', nowMs: Date.now() - 60 * 60 * 1000 },
    );
    const send = await runNode(
      [cliPath, 'message', 'send', '--channel', 'C-product', '--thread-ts', '1770000200.000001'],
      {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        input: '我倾向*一起带进去*——用 @alice 和 #product，字段 *role*。',
      },
    );
    assert.equal(send.status, 0, send.stderr || send.stdout);

    assert.equal(send.stdout.trim(), 'sent successfully. channel=#product, thread_ts=1770000200.000001, message_ts=1770000200.000123.');
    assert.deepEqual(posts, [
      {
        blocks: JSON.stringify([{ type: 'markdown', text: '我倾向*一起带进去*——用 <@U123> 和 <#C-product>，字段 *role*。' }]),
        channel: 'C-product',
        text: '我倾向*一起带进去*——用 <@U123> 和 <#C-product>，字段 *role*。',
        thread_ts: '1770000200.000001',
      },
    ]);

    const activities = await activitiesForInboxItemWindow('scout', itemId);
    const completed = activities.at(-1);
    assert.equal(completed?.type, 'external.effect.completed');
    assert.equal(completed?.payload?.['effect'], 'slack.message.send');
    assert.equal(completed?.payload?.['tool'], 'anima.message.send');
    assert.equal(completed?.payload?.['status'], 'sent');
    assert.equal(completed?.payload?.['ts'], '1770000200.000123');
    assert.equal(completed?.payload?.['text'], '我倾向*一起带进去*——用 @alice 和 #product，字段 *role*。');
    assert.equal(completed?.payload?.['slackText'], '我倾向*一起带进去*——用 <@U123> 和 <#C-product>，字段 *role*。');
    assert.equal(completed?.payload?.['channelKind'], 'channel');
    assert.equal(completed?.payload?.['channelDisplayName'], '#product');
    assert.equal(completed?.payload?.['threadTs'], '1770000200.000001');
    assert.equal(completed?.payload?.['threadDisplayName'], 'Thread 1770000200.000001 in #product');
    const completedThreadSubscription = completed?.payload?.['threadSubscription'] as Record<string, unknown> | undefined;
    assert.deepEqual(completedThreadSubscription, {
      subscriptionId: 'slack-subscription:scout:C-product:thread:1770000200.000001',
      kind: 'thread',
      threadTs: '1770000200.000001',
    });
    const renewedState = await loadState();
    assert.equal(Object.values(renewedState.subscriptions).some((subscription) => subscription.kind === 'channel'), false);
    const sentThreadSubscription = Object.values(renewedState.subscriptions).find(
      (subscription) => subscription.kind === 'thread' && subscription.threadTs === '1770000200.000001',
    );
    assert.ok(sentThreadSubscription);

    const list = await runNode([cliPath, 'subscription', 'list'], {
      env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir },
    });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /Channels:\n- none/);
    assert.match(list.stdout, /\[following\] channel=C-product thread_ts=1770000100\.000001/);
    assert.match(list.stdout, /\[following\] channel=C-product thread_ts=1770000200\.000001/);

    const mute = await runNode([cliPath, 'subscription', 'mute', '--channel', 'C-product', '--thread-ts', '1770000200.000001'], {
      env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
    });
    assert.equal(mute.status, 0, mute.stderr || mute.stdout);
    assert.equal(mute.stdout.trim(), 'muted successfully. channel=C-product thread_ts=1770000200.000001.');
    const mutedState = await loadState();
    assert.ok(Object.values(mutedState.subscriptions).some(
      (subscription) => subscription.kind === 'thread' && subscription.threadTs === '1770000200.000001' && subscription.mutedAt,
    ));
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send resolves the active runtime item without ANIMA_INBOX_ITEM_ID env', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-active-item-test-'));
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as { channel: string; text: string; thread_ts?: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000300.000123',
    };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
      const workerId = 'worker-active-item-test';
      const queue = new WakeQueueService('scout');
      const claimed = await queue.claimNext(workerId);
      assert.equal(claimed?.id, itemId);
      await setActiveRuntimeItem({ agentId: 'scout', itemId, workerId });

      const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: '', ANIMA_SLACK_API_URL: slackApi.url },
        input: 'Top-level via active item.',
      });
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.deepEqual(posts, [{
        blocks: JSON.stringify([{ type: 'markdown', text: 'Top-level via active item.' }]),
        channel: 'C-product',
        text: 'Top-level via active item.',
      }]);

      const state = await loadState();
      const activities = await activitiesForInboxItemWindow('scout', itemId);
      const completed = activities.at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'slack.message.send');
      assert.equal(completed?.payload?.['tool'], 'anima.message.send');
      assert.equal(completed?.payload?.['ts'], '1770000300.000123');
      const threadSubscription = completed?.payload?.['threadSubscription'] as Record<string, unknown> | undefined;
      assert.equal(threadSubscription?.['subscriptionId'], 'slack-subscription:scout:C-product:thread:1770000300.000123');
      assert.equal(threadSubscription?.['threadTs'], '1770000300.000123');
      assert.equal(completed?.payload?.['renewedSubscription'], undefined);
      assert.equal(Object.values(state.subscriptions).some((subscription) => subscription.kind === 'channel'), false);
      assert.ok(Object.values(state.subscriptions).some(
        (subscription) => subscription.kind === 'thread' && subscription.threadTs === '1770000300.000123',
      ));
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send follows a new channel thread using an active channel subscription', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-channel-follow-test-'));
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as { channel: string; text: string; thread_ts?: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000300.000124',
    };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      await slackRuntimeDecision(
        {
          channel: 'C-product',
          channel_type: 'channel',
          text: '<@U-scout> keep an eye here',
          ts: '1770000200.000001',
          type: 'app_mention',
          user: 'U123',
        },
        { agentId: 'scout', nowMs: Date.now() - 60 * 60 * 1000 },
      );

      const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: '', ANIMA_SLACK_API_URL: slackApi.url },
        input: 'Top-level from channel context.',
      });
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.deepEqual(posts, [{
        blocks: JSON.stringify([{ type: 'markdown', text: 'Top-level from channel context.' }]),
        channel: 'C-product',
        text: 'Top-level from channel context.',
      }]);

      const state = await loadState();
      const completed = allActivities(state).find((activity) => activity.payload?.['ts'] === '1770000300.000124');
      assert.equal(completed?.type, 'external.effect.completed');
      const threadSubscription = completed?.payload?.['threadSubscription'] as Record<string, unknown> | undefined;
      assert.equal(threadSubscription?.['subscriptionId'], 'slack-subscription:scout:C-product:thread:1770000300.000124');
      assert.equal(threadSubscription?.['threadTs'], '1770000300.000124');
      assert.ok(Object.values(state.subscriptions).some(
        (subscription) => subscription.kind === 'thread' && subscription.threadTs === '1770000300.000124',
      ));
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send resolves a just-settled runtime item for audit', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-settled-item-test-'));
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as { channel: string; text: string; thread_ts?: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000300.000125',
    };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
      const workerId = 'worker-settled-item-test';
      const queue = new WakeQueueService('scout');
      const claimed = await queue.claimNext(workerId);
      assert.equal(claimed?.id, itemId);
      await setActiveRuntimeItem({ agentId: 'scout', itemId, workerId });
      await queue.complete(itemId);
      await clearActiveRuntimeItem({ agentId: 'scout', itemId, workerId });

      const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: '', ANIMA_SLACK_API_URL: slackApi.url },
        input: 'Via settled item grace.',
      });
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.deepEqual(posts, [{
        blocks: JSON.stringify([{ type: 'markdown', text: 'Via settled item grace.' }]),
        channel: 'C-product',
        text: 'Via settled item grace.',
      }]);

      const completed = allActivities(await loadState()).find((activity) => activity.payload?.['ts'] === '1770000300.000125');
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'slack.message.send');
      assert.equal(completed?.payload?.['tool'], 'anima.message.send');
      assert.equal(completed?.payload?.['ts'], '1770000300.000125');
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send records audit without an active runtime item', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-no-active-item-test-'));
  let postCount = 0;
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'chat.postMessage') {
      postCount += 1;
      return { ok: true, channel: 'C-product', ts: '1770000300.000124' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir, { teamId: 'T-config' });
      const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: '', ANIMA_SLACK_API_URL: slackApi.url },
        input: 'Posts without a item.',
      });
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(postCount, 1);
      const completed = allActivities(await loadState()).at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'slack.message.send');
      const threadSubscription = completed?.payload?.['threadSubscription'] as Record<string, unknown> | undefined;
      assert.equal(threadSubscription?.['subscriptionId'], 'slack-subscription:scout:C-product:thread:1770000300.000124');
      assert.equal(Object.hasOwn(completed ?? {}, 'itemId'), false);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send output describes DM targets', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-dm-output-test-'));
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return { channel: { id: 'D-alice', is_im: true, user: 'U-alice' }, ok: true };
    }
    if (method === 'users.info') {
      return {
        ok: true,
        user: {
          id: 'U-alice',
          name: 'alice',
          profile: { display_name: 'Alice Cooper' },
        },
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as { channel: string; text: string; thread_ts?: string });
    return {
      ok: true,
      channel: 'D-alice',
      ts: '1770000200.000125',
    };
  });
  try {
    await withAnimaHome(stateDir, async () => {
    await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

    const send = await runNode([cliPath, 'message', 'send', '--channel', 'D-alice'], {
      env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
      input: 'DM hello.',
    });
    assert.equal(send.status, 0, send.stderr || send.stdout);

    assert.equal(send.stdout.trim(), 'sent successfully. dm=@alice, message_ts=1770000200.000125.');
    assert.deepEqual(posts, [{
      blocks: JSON.stringify([{ type: 'markdown', text: 'DM hello.' }]),
      channel: 'D-alice',
      text: 'DM hello.',
    }]);

    const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
    assert.equal(completed?.payload?.['channelKind'], 'dm');
    assert.equal(completed?.payload?.['channelDisplayName'], 'DM with @alice');
    assert.equal(completed?.payload?.['dmHandle'], 'alice');
    assert.equal(completed?.payload?.['dmUserId'], 'U-alice');
    assert.equal(
      completed?.payload?.['permalink'],
      'https://slack.com/app_redirect?channel=D-alice&message_ts=1770000200.000125',
    );
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('inbox and outbox commands show recent received and sent history', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-inbox-outbox-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      await ingestEvent(
        makeSlackEvent({
          actor: { displayName: 'Alice Cooper', handle: 'alice' },
          channelId: 'C-product',
          channelName: 'product',
          eventId: 'evt_history_one',
          teamId: 'T-demo',
          text: 'Can you summarize the launch thread?',
          timestamp: '2026-05-11T00:00:00.000Z',
          threadTs: '1770000200.000001',
          ts: '1770000200.000002',
          userId: 'U-alice',
        }),
        { agentId: 'scout', stateDir },
      );
      await ingestEvent(
        makeSlackEvent({
          actor: { handle: 'bob' },
          channelId: 'C-product',
          channelName: 'product',
          eventId: 'evt_history_two',
          teamId: 'T-demo',
          text: 'Second message for pagination.',
          timestamp: '2026-05-11T00:05:00.000Z',
          ts: '1770000205.000001',
          userId: 'U-bob',
        }),
        { agentId: 'scout', stateDir },
      );
      await activityServiceForAgent('scout').record({
        createdAt: '2026-05-11T00:06:00.000Z',
        payload: {
          channel: 'D-alice',
          channelDisplayName: 'DM with @alice',
          channelKind: 'dm',
          dmHandle: 'alice',
          dmUserId: 'U-alice',
          effect: 'slack.message.send',
          permalink: 'https://anima.slack.com/archives/D-alice/p1770000206000001',
          status: 'completed',
          text: 'Sent the summary.',
          tool: 'anima.message.send',
          ts: '1770000206.000001',
        },
        type: 'external.effect.completed',
      });
    });

    const env = { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir };
    const inbox = await runNode([cliPath, 'inbox', '--limit', '1'], { env });
    assert.equal(inbox.status, 0, inbox.stderr || inbox.stdout);
    assert.match(inbox.stdout, /^Inbox \(1 entry, newest first\)/);
    assert.match(inbox.stdout, /\[time=2026-05-11T00:05:00\.000Z channel=#product channel_id=C-product message_ts=1770000205\.000001\] @bob: Second message for pagination\./);
    assert.match(inbox.stdout, /\[page has_more=true next_cursor=2026-05-11T00:05:00\.000Z\]/);

    const secondPage = await runNode([cliPath, 'inbox', '--before', '2026-05-11T00:05:00.000Z'], { env });
    assert.equal(secondPage.status, 0, secondPage.stderr || secondPage.stdout);
    assert.match(secondPage.stdout, /\[time=2026-05-11T00:00:00\.000Z channel=#product channel_id=C-product thread_ts=1770000200\.000001 message_ts=1770000200\.000002\] Alice Cooper \(@alice\): Can you summarize the launch thread\?/);

    const outbox = await runNode([cliPath, 'outbox'], { env });
    assert.equal(outbox.status, 0, outbox.stderr || outbox.stdout);
    assert.match(outbox.stdout, /^Outbox \(1 entry, newest first\)/);
    assert.match(outbox.stdout, /\[time=2026-05-11T00:06:00\.000Z channel=@alice channel_id=D-alice message_ts=1770000206\.000001\] sent: Sent the summary\./);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('inbox command defaults to twenty entries', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-inbox-default-limit-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      for (let i = 0; i < 21; i += 1) {
        const suffix = String(i).padStart(2, '0');
        await ingestEvent(
          makeSlackEvent({
            actor: { handle: `user${suffix}` },
            channelId: 'C-product',
            channelName: 'product',
            eventId: `evt_history_limit_${suffix}`,
            teamId: 'T-demo',
            text: `Message ${suffix}`,
            timestamp: `2026-05-11T00:${suffix}:00.000Z`,
            ts: `17700003${suffix}.000001`,
            userId: `U-${suffix}`,
          }),
          { agentId: 'scout', stateDir },
        );
      }
    });

    const inbox = await runNode([cliPath, 'inbox'], {
      env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir },
    });
    assert.equal(inbox.status, 0, inbox.stderr || inbox.stdout);
    assert.match(inbox.stdout, /^Inbox \(20 entries, newest first\)/);
    assert.equal(inbox.stdout.split('\n').filter((line) => line.startsWith('[time=')).length, 20);
    assert.match(inbox.stdout, /\[time=2026-05-11T00:20:00\.000Z channel=#product channel_id=C-product message_ts=1770000320\.000001\] @user20: Message 20/);
    assert.doesNotMatch(inbox.stdout, /Message 00/);
    assert.match(inbox.stdout, /\[page has_more=true next_cursor=2026-05-11T00:01:00\.000Z\]/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send normalizes raw Slack user ids outside code spans', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-raw-user-id-test-'));
  const posts: Array<{ blocks?: string; channel: string; text: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'conversations.members') {
      return {
        members: ['U123'],
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as { blocks?: string; channel: string; text: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000200.000126',
    };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        input: 'cc @U123 and `@U456`.',
      });
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(send.stdout.trim(), 'sent successfully. channel=#product, message_ts=1770000200.000126.');
      assert.deepEqual(posts, [{
        blocks: JSON.stringify([{ type: 'markdown', text: 'cc <@U123> and `@U456`.' }]),
        channel: 'C-product',
        text: 'cc <@U123> and `@U456`.',
      }]);

      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.equal(completed?.payload?.['slackText'], 'cc <@U123> and `@U456`.');
      assert.deepEqual(completed?.payload?.['resolvedMentions'], [{ id: 'U123', label: '@U123', type: 'user' }]);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send warns for unresolved and out-of-channel mentions', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-mention-warning-test-'));
  const posts: Array<{ channel: string; text: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'users.list') {
      return {
        members: [{ id: 'U123', name: 'alice' }],
        ok: true,
      };
    }
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'conversations.members') {
      return {
        members: [],
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as { channel: string; text: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000200.000129',
    };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        input: 'Heads up @alice and @missing.',
      });
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(
        send.stdout.trim(),
        'sent successfully. channel=#product, message_ts=1770000200.000129. Warning: mention did not resolve: @missing. mentioned users not in #product: @alice.',
      );
      assert.deepEqual(posts, [{
        blocks: JSON.stringify([{ type: 'markdown', text: 'Heads up <@U123> and @missing.' }]),
        channel: 'C-product',
        text: 'Heads up <@U123> and @missing.',
      }]);

      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.deepEqual(completed?.payload?.['warnings'], [
        'mention did not resolve: @missing.',
        'mentioned users not in #product: @alice.',
      ]);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send only targets a thread when explicitly requested', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-thread-default-test-'));
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.list') {
      return {
        channels: [{ id: 'C-product', name: 'product', name_normalized: 'product' }],
        ok: true,
      };
    }
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as { channel: string; text: string; thread_ts?: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000200.000124',
    };
  });
  try {
    await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

    const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
      env: {
        ...process.env,
        ANIMA_AGENT_ID: 'scout',
        ANIMA_HOME: stateDir,
        ANIMA_INBOX_ITEM_ID: itemId,
        ANIMA_SLACK_API_URL: slackApi.url,
        ANIMA_THREAD: '1770000200.000001',
        ANIMA_THREAD_TS: '1770000200.000001',
      },
      input: 'Top-level by default.',
    });
    assert.equal(send.status, 0, send.stderr || send.stdout);

    assert.deepEqual(posts, [
      {
        blocks: JSON.stringify([{ type: 'markdown', text: 'Top-level by default.' }]),
        channel: 'C-product',
        text: 'Top-level by default.',
      },
    ]);
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send uses a Slack markdown block while preserving one API call', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-send-blocks-test-'));
  const posts: Array<{ blocks?: Array<{ text: string; type: string }>; channel: string; text: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body) as unknown as { blocks?: Array<{ text: string; type: string }>; channel: string; text: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000200.000126',
    };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
      const longText = ['# Daily report', 'A'.repeat(1600), 'B'.repeat(1600), 'C'.repeat(1600)].join('\n\n');

      const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        input: longText,
      });
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(posts.length, 1);
      assert.equal(posts[0]?.channel, 'C-product');
      const blocks = slackBlocks(posts[0]);
      assert.ok(blocks);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0]?.type, 'markdown');
      assert.equal(blocks[0]?.text, longText);
      assert.ok(posts[0]?.text.length <= 3900);

      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.equal(completed?.payload?.['messageFormat'], 'markdown');
      assert.equal(completed?.payload?.['blockCount'], 1);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message read fetches a Slack thread through configured credentials', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-read-test-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'auth.test') {
      return { ok: true, team_id: 'T-demo' };
    }
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'users.info') {
      return {
        ok: true,
        user: { id: 'U1', name: 'alice' },
      };
    }
    if (method !== 'conversations.replies') throw new Error(`unexpected method ${method}`);
    return {
      ok: true,
      messages: [{ text: 'thread root', thread_ts: '1770000200.000001', ts: '1770000200.000001', type: 'message', user: 'U1' }],
    };
  });
  try {
    await writeSlackConfig(stateDir);
    const read = await runNode(
      [
        cliPath,
        'message',
        'read',
        '--channel',
        'C-product',
        '--thread-ts',
        '1770000200.000001',
      ],
      {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: '', ANIMA_SLACK_API_URL: slackApi.url },
      },
    );
    assert.equal(read.status, 0, read.stderr || read.stdout);
    assert.match(read.stdout, /\[channel=C-product thread_ts=1770000200\.000001 message_ts=1770000200\.000001/);
    assert.match(read.stdout, /@alice: thread root/);
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message update records an audited Slack output update', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-update-test-'));
  const updates: Array<{ channel: string; text: string; ts: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'users.list') {
      return {
        members: [{ id: 'U123', name: 'alice' }],
        ok: true,
      };
    }
    if (method === 'conversations.list') {
      return {
        channels: [{ id: 'C-product', name: 'product', name_normalized: 'product' }],
        ok: true,
      };
    }
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'conversations.members') {
      return {
        members: ['U123'],
        ok: true,
      };
    }
    if (method !== 'chat.update') throw new Error(`unexpected method ${method}`);
    updates.push(slackRequestBody(body) as { channel: string; text: string; ts: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000200.000123',
    };
  });
  try {
    await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

    const update = await runNode(
      [cliPath, 'message', 'update', '--channel', 'C-product', '--message-ts', '1770000200.000123'],
      {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        input: 'Updated for @alice in #product.',
      },
    );
    assert.equal(update.status, 0, update.stderr || update.stdout);

    assert.equal(update.stdout.trim(), 'updated successfully. channel=#product, message_ts=1770000200.000123.');
    assert.deepEqual(updates, [
      {
        blocks: JSON.stringify([{ type: 'markdown', text: 'Updated for <@U123> in <#C-product>.' }]),
        channel: 'C-product',
        text: 'Updated for <@U123> in <#C-product>.',
        ts: '1770000200.000123',
      },
    ]);

    const activities = await withAnimaHome(stateDir, async () => await activitiesForInboxItemWindow('scout', itemId));
    const completed = activities.at(-1);
    assert.equal(completed?.type, 'external.effect.completed');
    assert.equal(completed?.payload?.['effect'], 'slack.message.update');
    assert.equal(completed?.payload?.['tool'], 'anima.message.update');
    assert.equal(completed?.payload?.['status'], 'updated');
    assert.equal(completed?.payload?.['targetTs'], '1770000200.000123');
    assert.equal(completed?.payload?.['text'], 'Updated for @alice in #product.');
    assert.equal(completed?.payload?.['slackText'], 'Updated for <@U123> in <#C-product>.');
    assert.equal(completed?.payload?.['channelKind'], 'channel');
    assert.equal(completed?.payload?.['channelDisplayName'], '#product');
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message update uses a Slack markdown block', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-update-blocks-test-'));
  const updates: Array<{ blocks?: Array<{ text: string; type: string }>; channel: string; text: string; ts: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method !== 'chat.update') throw new Error(`unexpected method ${method}`);
    updates.push(slackRequestBody(body) as unknown as { blocks?: Array<{ text: string; type: string }>; channel: string; text: string; ts: string });
    return {
      ok: true,
      channel: 'C-product',
      ts: '1770000200.000127',
    };
  });
  try {
    await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
    const longText = ['Update report', 'A'.repeat(1600), 'B'.repeat(1600), 'C'.repeat(1600)].join('\n\n');

    const update = await runNode(
      [cliPath, 'message', 'update', '--channel', 'C-product', '--message-ts', '1770000200.000123'],
      {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        input: longText,
      },
    );
    assert.equal(update.status, 0, update.stderr || update.stdout);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.channel, 'C-product');
    assert.equal(updates[0]?.ts, '1770000200.000123');
    const blocks = slackBlocks(updates[0]);
    assert.ok(blocks);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, 'markdown');
    assert.equal(blocks[0]?.text, longText);

    const activities = await withAnimaHome(stateDir, async () => await activitiesForInboxItemWindow('scout', itemId));
    const completed = activities.at(-1);
    assert.equal(completed?.payload?.['messageFormat'], 'markdown');
    assert.equal(completed?.payload?.['blockCount'], 1);
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send rejects text that cannot fit in one Slack markdown block', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-send-too-long-blocks-test-'));
  let postCount = 0;
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'chat.postMessage') {
      postCount += 1;
      return { ok: true, channel: 'C-product', ts: '1770000200.000128' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        input: 'X'.repeat(12_001),
      });
      assert.notEqual(send.status, 0);
      assert.match(send.stderr, /too long for Slack markdown block/);
      assert.equal(postCount, 0);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('reaction add records an audited reaction add', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-react-test-'));
  const reactions: Array<{ channel: string; name: string; timestamp: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.list') {
      return {
        channels: [{ id: 'C-product', name: 'product', name_normalized: 'product' }],
        ok: true,
      };
    }
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method !== 'reactions.add') throw new Error(`unexpected method ${method}`);
    reactions.push(slackRequestBody(body) as { channel: string; name: string; timestamp: string });
    return { ok: true };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const react = await runNode(
        [cliPath, 'reaction', 'add', '--channel', 'C-product', '--message-ts', '1770000200.000123', '--name', ':white_check_mark:'],
        {
          env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        },
      );
      assert.equal(react.status, 0, react.stderr || react.stdout);
      assert.equal(
        react.stdout.trim(),
        'reaction added successfully. channel=#product, message_ts=1770000200.000123, reaction=:white_check_mark:.',
      );
      assert.deepEqual(reactions, [
        { channel: 'C-product', name: 'white_check_mark', timestamp: '1770000200.000123' },
      ]);

      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'slack.reaction');
      assert.equal(completed?.payload?.['tool'], 'anima.message.react');
      assert.equal(completed?.payload?.['action'], 'added');
      assert.equal(completed?.payload?.['name'], 'white_check_mark');
      assert.equal(completed?.payload?.['targetTs'], '1770000200.000123');
      assert.equal(completed?.payload?.['status'], 'added');
      assert.equal(completed?.payload?.['channelDisplayName'], '#product');
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('reaction aliases accept react/message react and --emoji', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-react-alias-test-'));
  const reactions: Array<{ channel: string; name: string; timestamp: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.list') {
      return { channels: [{ id: 'C-product', name: 'product', name_normalized: 'product' }], ok: true };
    }
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true };
    }
    if (method !== 'reactions.add') throw new Error(`unexpected method ${method}`);
    reactions.push(slackRequestBody(body) as { channel: string; name: string; timestamp: string });
    return { ok: true };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
      const env = {
        ...process.env,
        ANIMA_AGENT_ID: 'scout',
        ANIMA_HOME: stateDir,
        ANIMA_INBOX_ITEM_ID: itemId,
        ANIMA_SLACK_API_URL: slackApi.url,
      };

      const topLevelAlias = await runNode(
        [cliPath, 'react', 'add', '--channel', 'C-product', '--message-ts', '1770000200.000123', '--emoji', '+1'],
        { env },
      );
      assert.equal(topLevelAlias.status, 0, topLevelAlias.stderr || topLevelAlias.stdout);

      const messageAlias = await runNode(
        [cliPath, 'message', 'react', '--channel', 'C-product', '--message-ts', '1770000200.000124', '--emoji', 'white_check_mark'],
        { env },
      );
      assert.equal(messageAlias.status, 0, messageAlias.stderr || messageAlias.stdout);

      const reactionDefaultAdd = await runNode(
        [cliPath, 'reaction', '--channel', 'C-product', '--message-ts', '1770000200.000125', '--emoji', 'eyes'],
        { env },
      );
      assert.equal(reactionDefaultAdd.status, 0, reactionDefaultAdd.stderr || reactionDefaultAdd.stdout);

      assert.deepEqual(reactions, [
        { channel: 'C-product', name: '+1', timestamp: '1770000200.000123' },
        { channel: 'C-product', name: 'white_check_mark', timestamp: '1770000200.000124' },
        { channel: 'C-product', name: 'eyes', timestamp: '1770000200.000125' },
      ]);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('reaction remove calls reactions.remove and tolerates no_reaction as noop', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-react-remove-test-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'conversations.list') {
      return { channels: [{ id: 'C-product', name: 'product', name_normalized: 'product' }], ok: true };
    }
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true };
    }
    if (method !== 'reactions.remove') throw new Error(`unexpected method ${method}`);
    return { ok: false, error: 'no_reaction' };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const react = await runNode(
        [cliPath, 'reaction', 'remove', '--channel', 'C-product', '--message-ts', '1770000200.000123', '--name', 'eyes'],
        {
          env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
        },
      );
      assert.equal(react.status, 0, react.stderr || react.stdout);
      assert.equal(
        react.stdout.trim(),
        'reaction already absent (noop). channel=#product, message_ts=1770000200.000123, reaction=:eyes:.',
      );

      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'slack.reaction');
      assert.equal(completed?.payload?.['action'], 'removed');
      assert.equal(completed?.payload?.['noop'], true);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('reaction commands require --channel, --message-ts, and --name', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-react-validation-test-'));
  try {
    await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
    const baseEnv = { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId };

    const noChannel = await runNode([cliPath, 'reaction', 'add', '--message-ts', '1770000200.000123', '--name', 'eyes'], { env: baseEnv });
    assert.notEqual(noChannel.status, 0);
    assert.match(noChannel.stderr, /requires --channel/);

    const noTs = await runNode([cliPath, 'reaction', 'add', '--channel', 'C-product', '--name', 'eyes'], { env: baseEnv });
    assert.notEqual(noTs.status, 0);
    assert.match(noTs.stderr, /requires --message-ts/);

    const noName = await runNode([cliPath, 'reaction', 'add', '--channel', 'C-product', '--message-ts', '1770000200.000123'], { env: baseEnv });
    assert.notEqual(noName.status, 0);
    assert.match(noName.stderr, /requires --name/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('server preflights Socket Mode token before constructing the Slack app', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-server-slack-preflight-test-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'auth.test') return { ok: true, user_id: 'U-scout' };
    if (method === 'apps.connections.open') return { error: 'invalid_auth', ok: false };
    throw new Error(`unexpected method ${method}`);
  });
  try {
    const homePath = join(stateDir, 'home');
    const agentDir = join(stateDir, 'agents', 'scout');
    await mkdir(homePath, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(stateDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
    await writeFile(
      join(agentDir, 'config.json'),
      `${JSON.stringify({
        id: 'scout',
        provider: { kind: 'codex-cli', model: 'gpt-5.5' },
        slack: { appToken: 'xapp-valid-format', botToken: 'xoxb-valid-format' },
        homePath,
      }, null, 2)}\n`,
      'utf8',
    );

    const server = await runNode([adminCliPath, '--agent', 'scout', 'server'], {
      env: { ...process.env, ANIMA_HOME: stateDir, ANIMA_SLACK_API_URL: slackApi.url },
    });
    assert.notEqual(server.status, 0);
    assert.match(server.stderr || server.stdout, /apps\.connections\.open failed/);
    assert.doesNotMatch(server.stderr + server.stdout, /SocketModeClient/);
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});


test('message commands reject non-ts timestamp flags', async () => {
  const send = await runNode([cliPath, 'message', 'send', '--channel', 'C-product', '--thread', '1770000200.000001'], {
    input: 'legacy thread flag.',
  });
  assert.notEqual(send.status, 0);
  assert.match(send.stderr, /unknown option '--thread'/);

  const update = await runNode([cliPath, 'message', 'update', '--channel', 'C-product', '--ts', '1770000200.000123'], {
    input: 'legacy ts flag.',
  });
  assert.notEqual(update.status, 0);
  assert.match(update.stderr, /unknown option '--ts'/);
});

test('message commands reject agent and item flags', async () => {
  const agent = await runNode([cliPath, 'message', '--agent', 'scout', 'read', '--channel', 'C-product']);
  assert.notEqual(agent.status, 0);
  assert.match(agent.stderr, /unknown option '--agent'/);

  const item = await runNode([cliPath, 'message', '--item', 'turn_123', 'send', '--channel', 'C-product'], {
    input: 'legacy item flag.',
  });
  assert.notEqual(item.status, 0);
  assert.match(item.stderr, /unknown option '--item'/);
});

async function writeSlackConfig(
  configDir: string,
  slack: { appToken?: string; botToken?: string; teamId?: string } = {},
  profile: { displayName?: string; role?: string } = {},
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const agent = {
    id: 'scout',
    profile,
    slack: {
      appToken: slack.appToken ?? 'xapp-test',
      botToken: slack.botToken ?? 'xoxb-test',
      teamId: slack.teamId ?? 'T-demo',
    },
  };
  const agentDir = join(configDir, 'agents', agent.id);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  await writeFile(
    join(agentDir, 'config.json'),
    `${JSON.stringify(agent, null, 2)}\n`,
    'utf8',
  );
}

async function ingestSlackThread(stateDir: string): Promise<string> {
  return withAnimaHome(stateDir, async () => {
    const ctx = await ingestEvent(exampleSlackThread(), { agentId: 'scout', stateDir });
    return ctx.item.id;
  });
}

function exampleSlackThread() {
  return makeSlackEvent({
    channelId: 'C-product',
    channelName: 'product',
    eventId: 'evt_example_slack_thread',
    teamId: 'T-demo',
    text: 'Can you turn this discussion into a tracked product spike?',
    timestamp: '2026-05-11T00:00:00.000Z',
    threadTs: '1770000200.000001',
    ts: '1770000200.000002',
    userId: 'U-alice',
  });
}

async function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(options.input);
  const [status] = (await once(child, 'exit')) as [number | null];
  return { status, stderr, stdout };
}

async function startSlackApiMock(
  handler: (method: string, body: string) => object,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const normalizedMethod = pathname.replace(/^\/api\//, '');
      const payload = handler(normalizedMethod, body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ok: false }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected Slack API mock to listen on a TCP address.');
  }
  return {
    close: async () => {
      server.close();
      await once(server, 'close');
    },
    url: `http://127.0.0.1:${address.port}/api`,
  };
}

function slackRequestBody(body: string): Record<string, string> {
  try {
    return JSON.parse(body) as Record<string, string>;
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

function slackBlocks(body: { blocks?: unknown }): Array<{ text: string; type: string }> {
  if (Array.isArray(body.blocks)) {
    return body.blocks as Array<{ text: string; type: string }>;
  }
  assert.equal(typeof body.blocks, 'string');
  return JSON.parse(body.blocks as string) as Array<{ text: string; type: string }>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}
