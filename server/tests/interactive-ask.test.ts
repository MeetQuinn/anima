import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { WebClient } from '@slack/web-api';

import { InteractiveAskService, interactiveAskServiceForAgent } from '../asks/interactive-ask.service.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { withAnimaHome } from '../anima-home.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { InteractiveAskStore } from '../storage/schema/interactive-ask.store.js';
import { SubscriptionStore } from '../storage/schema/subscription.store.js';
import { slackBlocks, slackRequestBody, startSlackApiMock } from './helpers/slack-api.js';
import type { InteractiveAskRecord } from '../storage/schema/interactive-ask.store.js';
import { runNode } from './helpers/run-node.js';

import { withTempAnimaHome, writeAgentConfigs, defaultAgentConfig, waitFor } from './helpers/harness.js';
import { startRunningAgent } from '../runtime/agent-runner.js';
import { TeamRunLimiter } from '../runtime/team-run-limiter.js';
import type { AgentRuntimeInput } from '../providers/contract.js';

const cliPath = resolve('dist/server/cli/anima.js');

test('anima ask posts Block Kit buttons, stores the ask, and subscribes to typed replies', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-cli-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const posts: Array<Record<string, unknown>> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    posts.push(slackRequestBody(body));
    return { channel: 'C-product', ok: true, ts: '1770000400.000123' };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeAgentConfig('scout', {
        slack: { appToken: 'xapp-test', botToken: 'xoxb-test', teamId: 'T-demo' },
      });
      const run = await runNode(
        [
          cliPath,
          'ask',
          '--channel',
          'C-product',
          '--question',
          'Ship this change?',
          '--option',
          'Approve',
          '--option',
          'Hold',
        ],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.match(run.stdout.trim(), /^asked successfully\. channel=#product, message_ts=1770000400\.000123, ask_id=ask_/);

      assert.equal(posts.length, 1);
      assert.equal(posts[0]?.['channel'], 'C-product');
      assert.equal(posts[0]?.['text'], [
        'Ship this change?',
        '',
        'Options:',
        '1. Approve',
        '2. Hold',
        '',
        'None fit? Just reply in this thread.',
      ].join('\n'));
      const blocks = slackBlocks(posts[0] ?? {});
      // Question renders in a `markdown` block, same as regular messages.
      assert.equal(blocks[0]?.type, 'markdown');
      assert.equal(blocks[0]?.text, 'Ship this change?');
      assert.equal(blocks[1]?.type, 'actions');
      const button = blocks[1]?.elements?.[0];
      assert.ok(button?.action_id?.startsWith('anima.ask.answer'));
      assert.deepEqual(JSON.parse(String(button?.value)), {
        askId: run.stdout.match(/ask_id=([^.\s]+)/)?.[1],
        optionId: 'option_1',
      });

      const asks = await new InteractiveAskStore('scout').list();
      const ask = asks[0];
      assert.ok(ask);
      assert.equal(ask.question, 'Ship this change?');
      assert.equal(ask.messageTs, '1770000400.000123');
      assert.equal(ask.allowAnyone, true);
      assert.deepEqual(ask.options.map((option) => option.label), ['Approve', 'Hold']);

      const subscriptions = await new SubscriptionStore('scout').list();
      assert.equal(
        subscriptions.some((subscription) =>
          subscription.kind === 'thread'
          && subscription.channelId === 'C-product'
          && subscription.threadTs === '1770000400.000123'),
        true,
      );

      const completed = (await activityServiceForAgent('scout').readAll()).find((activity) =>
        activity.type === 'external.effect.completed'
        && activity.payload?.['effect'] === 'slack.ask.post');
      assert.equal(completed?.payload?.['tool'], 'anima.ask');
      assert.equal(completed?.payload?.['question'], 'Ship this change?');
    });
  } finally {
    await slackApi.close();
  }
});

test('anima ask in a DM by channel id follows no thread', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-dm-cli-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'conversations.info') {
      return { channel: { id: 'D-alice', is_im: true, user: 'U-alice' }, ok: true };
    }
    if (method === 'users.info') {
      return { ok: true, user: { id: 'U-alice', name: 'alice', profile: { display_name: 'Alice' } } };
    }
    if (method !== 'chat.postMessage') throw new Error(`unexpected method ${method}`);
    return { channel: 'D-alice', ok: true, ts: '1770000400.000124' };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeAgentConfig('scout', {
        slack: { appToken: 'xapp-test', botToken: 'xoxb-test', teamId: 'T-demo' },
      });
      const run = await runNode(
        [cliPath, 'ask', '--channel', 'D-alice', '--question', 'Ship this change?', '--option', 'Approve', '--option', 'Hold'],
        { env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_SLACK_API_URL: slackApi.url } },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);
      // A DM always reaches the agent, so the ask needs no follow.
      assert.deepEqual(await new SubscriptionStore('scout').list(), []);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('interactive ask answer enqueues one choice_response with envelope context', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-answer-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  await withAnimaHome(stateDir, async () => {
    await writeAgentConfig('scout', {
      slack: { appToken: 'xapp-test', botToken: 'xoxb-test', teamId: 'T-demo' },
    });
    const ask = await savePendingAsk({
      allowedUserIds: ['U-operator'],
      messageTs: '1770000500.000001',
      // Formatting-sensitive question: CJK-flanked bold + glued bare URL
      // must go through the shared markdown-block transform on replacement.
      question: '**发布**：https://example.com/pr/7，可以吗',
      threadTs: undefined,
    });
    const updates: unknown[] = [];
    const client = fakeSlackClient({ updates });
    const askService = interactiveAskServiceForAgent('scout');

    const answered = await askService.answerAsk({
      askId: ask.askId,
      client,
      optionId: 'option_2',
      userId: 'U-operator',
    });
    assert.equal(answered.outcome, 'answered');
    assert.equal(answered.queued, true);
    await askService.replaceAnsweredMessage({ ask: answered.ask!, client });
    assert.equal(updates.length, 1);
    // The answered-message update must not re-trigger unfurls for question URLs.
    const update = updates[0] as {
      blocks?: Array<{ text?: string; type?: string }>;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
    };
    assert.equal(update.unfurl_links, false);
    assert.equal(update.unfurl_media, false);
    // Markdown block with the message transform applied: bare URL
    // wrapped as an autolink so it stays clickable beside the CJK comma.
    assert.equal(update.blocks?.[0]?.type, 'markdown');
    assert.equal(
      update.blocks?.[0]?.text,
      '**发布**：<https://example.com/pr/7>，可以吗\n\n✓ **Hold** — chosen by <@U-operator>',
    );

    const duplicate = await askService.answerAsk({
      askId: ask.askId,
      client,
      optionId: 'option_1',
      userId: 'U-operator',
    });
    assert.equal(duplicate.outcome, 'already_answered');

    const items = await new WakeQueueService('scout').list();
    const choice = items.find((item) => item.kind === 'choice_response');
    assert.ok(choice);
    assert.equal(choice.id, `choice:scout:${ask.askId}`);
    assert.equal(choice.kind === 'choice_response' ? choice.optionLabel : undefined, 'Hold');
    assert.equal(choice.kind === 'choice_response' ? choice.threadTs : undefined, '1770000500.000001');
    assert.equal(items.filter((item) => item.kind === 'choice_response').length, 1);

    const prompt = buildCodeAgentDeliveryPrompt(choice);
    assert.match(prompt, /^Choice response:/);
    assert.match(prompt, /Alice \(@alice, <@U-operator>\) selected: Hold/);
    assert.match(prompt, /\[ask_id=.* channel=C-product thread_ts=1770000500\.000001 message_ts=1770000500\.000001 wake=ask_answered time=/);
    assert.doesNotMatch(prompt, /Reply target:|Use `anima message send/);
  });
});

test('interactive ask rejects non-addressee clicks without waking the agent', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-forbidden-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  await withAnimaHome(stateDir, async () => {
    await writeAgentConfig('scout', {
      slack: { appToken: 'xapp-test', botToken: 'xoxb-test', teamId: 'T-demo' },
    });
    const ask = await savePendingAsk({ allowedUserIds: ['U-operator'] });
    const ephemerals: unknown[] = [];
    const client = fakeSlackClient({ ephemerals });
    const askService = interactiveAskServiceForAgent('scout');

    const result = await askService.answerAsk({
      askId: ask.askId,
      client,
      optionId: 'option_1',
      userId: 'U-other',
    });
    assert.equal(result.outcome, 'forbidden');
    await askService.notifyForbiddenClick({ ask: result.ask!, client, userId: 'U-other' });

    assert.equal((await new WakeQueueService('scout').list()).length, 0);
    assert.equal(ephemerals.length, 1);
    const ephemeral = ephemerals[0] as { unfurl_links?: boolean; unfurl_media?: boolean };
    assert.equal(ephemeral.unfurl_links, false);
    assert.equal(ephemeral.unfurl_media, false);
    const storedAsk = await askService.getAsk(ask.askId);
    assert.equal(storedAsk?.status, 'pending');
    assert.match(storedAsk?.lastInteractionAt ?? '', /^\d{4}-/);
  });
});

test('concurrent ask clicks keep the first committed choice in both record and queue', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  const service = interactiveAskServiceForAgent('scout');
  const ask = await service.saveAsk(askRecord());
  const started = [deferred(), deferred()];
  const releases = [deferred(), deferred()];
  const client = {
    users: { info: async ({ user }: { user: string }) => {
      const index = user === 'U-first' ? 0 : 1;
      started[index]!.resolve();
      await releases[index]!.promise;
      return { ok: true, user: { id: user, name: user } };
    } },
  } as unknown as WebClient;
  const first = service.answerAsk({ askId: ask.askId, client, optionId: 'option_1', userId: 'U-first' });
  const second = interactiveAskServiceForAgent('scout').answerAsk({ askId: ask.askId, client, optionId: 'option_2', userId: 'U-second' });
  await Promise.all(started.map((entry) => entry.promise));
  releases[0]!.resolve();
  assert.equal((await first).outcome, 'answered');
  releases[1]!.resolve();
  const rejected = await second;
  assert.equal(rejected.outcome, 'already_answered');
  assert.equal(rejected.ask?.chosenOptionId, 'option_1');
  const stored = await service.getAsk(ask.askId);
  const items = await new WakeQueueService('scout').list();
  assert.equal(stored?.chosenOptionId, 'option_1');
  assert.equal(stored?.answeredBy?.slackUserId, 'U-first');
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind === 'choice_response' && items[0].optionId, 'option_1');
}));

for (const outcome of ['forbidden', 'invalid_option'] as const) test(`late ${outcome} click cannot revert a committed answer`, async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  const store = new InteractiveAskStore('scout');
  const ask = await store.create(askRecord({ allowedUserIds: ['U-operator'] }));
  const started = deferred();
  const release = deferred();
  store.find = async () => { started.resolve(); await release.promise; return ask; };
  const late = new InteractiveAskService('scout', store).answerAsk({
    askId: ask.askId, client: fakeSlackClient(),
    optionId: outcome === 'invalid_option' ? 'missing' : 'option_2',
    userId: outcome === 'forbidden' ? 'U-other' : 'U-operator',
  });
  await started.promise;
  await interactiveAskServiceForAgent('scout').answerAsk({ askId: ask.askId, client: fakeSlackClient(), optionId: 'option_1', userId: 'U-operator' });
  release.resolve();
  assert.equal((await late).outcome, outcome);
  const saved = await new InteractiveAskStore('scout').find(ask.askId);
  assert.equal(saved?.status, 'answered');
  assert.equal(saved?.chosenOptionId, 'option_1');
  assert.equal(saved?.deliveryPending, undefined);
}));

for (const recovery of ['click', 'poll'] as const) test(`ask delivery retries after enqueue failure via ${recovery}`, async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  const store = new InteractiveAskStore('scout');
  const queue = new WakeQueueService('scout');
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = async () => { throw new Error('synthetic write failure'); };
  const service = new InteractiveAskService('scout', store, queue);
  const ask = await service.saveAsk(askRecord());
  const input = { askId: ask.askId, client: fakeSlackClient(), optionId: 'option_1', userId: 'U-operator' };
  await assert.rejects(service.answerAsk(input), /synthetic write failure/);
  assert.equal((await store.find(ask.askId))?.deliveryPending, true);
  assert.deepEqual(await new WakeQueueService('scout').list(), []);
  queue.enqueue = enqueue;
  const restarted = interactiveAskServiceForAgent('scout');
  if (recovery === 'click') {
    const result = await restarted.answerAsk({ ...input, optionId: 'option_2' });
    assert.equal(result.outcome, 'already_answered');
    assert.equal(result.queued, true);
  } else await restarted.retryPendingAnswers();
  const items = await new WakeQueueService('scout').list();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind === 'choice_response' && items[0].optionId, 'option_1');
  assert.equal((await store.find(ask.askId))?.deliveryPending, undefined);
  await restarted.retryPendingAnswers();
  assert.equal((await new WakeQueueService('scout').list()).length, 1);
}));

test('ask recovery after enqueue succeeded but receipt update failed does not re-run a settled choice', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  const store = new InteractiveAskStore('scout');
  const update = store.update.bind(store);
  let updates = 0;
  store.update = async (...args: Parameters<InteractiveAskStore['update']>) => {
    if (++updates === 2) throw new Error('synthetic receipt failure');
    return update(...args);
  };
  const service = new InteractiveAskService('scout', store);
  const ask = await service.saveAsk(askRecord());
  await assert.rejects(service.answerAsk({ askId: ask.askId, client: fakeSlackClient(), optionId: 'option_1', userId: 'U-operator' }), /synthetic receipt failure/);
  const queue = new WakeQueueService('scout');
  assert.equal((await queue.list()).length, 1);
  await queue.complete(`choice:scout:${ask.askId}`);
  await interactiveAskServiceForAgent('scout').retryPendingAnswers();
  assert.deepEqual(await queue.list(), []);
  assert.equal((await new InteractiveAskStore('scout').find(ask.askId))?.deliveryPending, undefined);
}));

test('ask retention keeps pending delivery and recovery does not replay legacy answers', async () => withTempAnimaHome(async () => {
  const store = new InteractiveAskStore('scout');
  const old = askRecord({ status: 'answered', answeredAt: '2000-01-01T00:00:00.000Z', answeredBy: { slackUserId: 'U-operator' }, chosenOptionId: 'option_1' });
  await store.create({ ...old, askId: 'old-pending-delivery', deliveryPending: true });
  await store.create({ ...old, askId: 'old-delivered' });
  await store.pruneAnsweredBefore(new Date().toISOString());
  assert.deepEqual((await store.list()).map((ask) => ask.askId), ['old-pending-delivery']);
  await store.create({ ...old, askId: 'legacy-answer' });
  await interactiveAskServiceForAgent('scout').retryPendingAnswers();
  const items = await new WakeQueueService('scout').list();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'choice:scout:old-pending-delivery');
}));

test('running agent recovers a durable ask answer on startup without a new click', async (t) => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [{ ...defaultAgentConfig('scout'), slack: { appToken: '', botToken: '' } }]);
  t.mock.method(console, 'log', () => {});
  const store = new InteractiveAskStore('scout');
  await store.create(askRecord({ askId: 'restart-answer', status: 'answered', answeredAt: new Date().toISOString(), answeredBy: { slackUserId: 'U-operator' }, chosenOptionId: 'option_2', deliveryPending: true }));
  const calls: AgentRuntimeInput[] = [];
  const runtime = {
    kind: 'synthetic',
    async run(input: AgentRuntimeInput) { calls.push(input); return { text: 'done' }; },
    async appendToActiveRun() { return { accepted: false }; },
    async close() {},
  };
  const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home, homePath: join(home, 'agent-homes', 'scout'), runtimeEnv: {}, runLimiter: new TeamRunLimiter(1) });
  try {
    await waitFor(async () => calls.length === 1 && (await new WakeQueueService('scout').list()).length === 0);
    assert.match(calls[0]!.prompt, /selected: Hold/);
    assert.equal((await store.find('restart-answer'))?.deliveryPending, undefined);
  } finally { await runner.stop(); }
}));

test('interactive ask retention prunes old answered asks but keeps pending asks', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-retention-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  await withAnimaHome(stateDir, async () => {
    const store = new InteractiveAskStore('scout');
    await store.create(askRecord({
      answeredAt: '2000-01-01T00:00:00.000Z',
      answeredBy: { slackUserId: 'U-operator' },
      askId: 'ask-old-answered',
      chosenOptionId: 'option_1',
      createdAt: '2000-01-01T00:00:00.000Z',
      status: 'answered',
    }));
    await store.create(askRecord({
      askId: 'ask-old-pending',
      createdAt: '2000-01-01T00:00:00.000Z',
      status: 'pending',
    }));

    await interactiveAskServiceForAgent('scout').saveAsk(askRecord({ askId: 'ask-new-pending' }));

    assert.deepEqual((await store.list()).map((ask) => ask.askId).sort(), ['ask-new-pending', 'ask-old-pending']);
  });
});

test('interactive ask store preserves concurrent creates', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-concurrent-create-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  await withAnimaHome(stateDir, async () => {
    const store = new InteractiveAskStore('scout');
    await Promise.all([
      store.create(askRecord({ askId: 'ask-concurrent-a' })),
      store.create(askRecord({ askId: 'ask-concurrent-b' })),
    ]);

    assert.deepEqual((await store.list()).map((ask) => ask.askId).sort(), [
      'ask-concurrent-a',
      'ask-concurrent-b',
    ]);
  });
});

test('interactive ask duplicate create throws and leaves file unchanged', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-duplicate-create-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  await withAnimaHome(stateDir, async () => {
    const store = new InteractiveAskStore('scout');
    const ask = askRecord({ askId: 'ask-duplicate' });
    await store.create(ask);
    const before = await readFile(join(stateDir, 'agents', 'scout', 'asks.json'), 'utf8');

    await assert.rejects(
      store.create(askRecord({ askId: 'ask-duplicate', question: 'Overwrite?' })),
      /Interactive ask already exists: ask-duplicate/,
    );

    assert.equal(await readFile(join(stateDir, 'agents', 'scout', 'asks.json'), 'utf8'), before);
  });
});

test('anima ask rejects bot users as explicit answer targets', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-bot-target-'));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const posts: Array<Record<string, unknown>> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'users.list') {
      return {
        members: [{ id: 'UBOT', is_bot: true, name: 'buildbot' }],
        ok: true,
      };
    }
    if (method === 'chat.postMessage') {
      posts.push(slackRequestBody(body));
      return { channel: 'C-product', ok: true, ts: '1770000500.000002' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeAgentConfig('scout', {
        slack: { appToken: 'xapp-test', botToken: 'xoxb-test', teamId: 'T-demo' },
      });
      const run = await runNode(
        [
          cliPath,
          'ask',
          '--channel',
          'C-product',
          '--question',
          'Ship this change?',
          '--option',
          'Approve',
          '--option',
          'Hold',
          '--to',
          '@buildbot',
        ],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );

      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /input\.invalid_ask_target/);
      assert.match(run.stderr, /anima message send with an @mention/);
      assert.doesNotMatch(run.stderr, /anima\.unexpected|ask the operator/);
      assert.equal(posts.length, 0);
      assert.deepEqual(await new InteractiveAskStore('scout').list(), []);
    });
  } finally {
    await slackApi.close();
  }
});

test('anima ask rejects deleted human targets with an actionable input error', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-deleted-target-'));
  const methods: string[] = [];
  const slackApi = await startSlackApiMock((method) => {
    methods.push(method);
    if (method === 'conversations.info') return {
      channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true,
    };
    if (method === 'users.info') return { user: { id: 'UOLD', deleted: true, name: 'former' }, ok: true };
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeAgentConfig('scout', { slack: { appToken: 'xapp-test', botToken: 'xoxb-test', teamId: 'T-demo' } });
      const run = await runNode([cliPath, 'ask', '--channel', 'C-product', '--question', 'Ship?', '--option', 'Ship', '--option', 'Hold', '--to', 'UOLD'], {
        env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_SLACK_API_URL: slackApi.url },
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /input\.invalid_ask_target/);
      assert.match(run.stderr, /Choose an active human Slack user/);
      assert.doesNotMatch(run.stderr, /anima\.unexpected/);
      assert.equal(methods.includes('chat.postMessage'), false);
      assert.deepEqual(await new InteractiveAskStore('scout').list(), []);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function savePendingAsk(overrides: Partial<InteractiveAskRecord> = {}): Promise<InteractiveAskRecord> {
  const ask = askRecord(overrides);
  await interactiveAskServiceForAgent('scout').saveAsk(ask);
  return ask;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function askRecord(overrides: Partial<InteractiveAskRecord> = {}): InteractiveAskRecord {
  const now = new Date().toISOString();
  return {
    agentId: 'scout',
    askId: `ask_${Math.random().toString(36).slice(2)}`,
    channelId: 'C-product',
    channelName: '#product',
    createdAt: now,
    messageTs: '1770000500.000001',
    options: [
      { optionId: 'option_1', label: 'Approve' },
      { optionId: 'option_2', label: 'Hold' },
    ],
    question: 'Ship this change?',
    status: 'pending',
    teamId: 'T-demo',
    ...overrides,
  };
}

async function writeAgentConfig(
  agentId: string,
  overrides: {
    operator?: { displayName: string; handle?: string; slackUserId: string };
    slack?: { appToken?: string; botToken?: string; teamId?: string };
  } = {},
): Promise<void> {
  const homePath = join(process.cwd(), '.tmp-home', agentId);
  await mkdir(homePath, { recursive: true });
  await new AgentStore(agentId).write({
    createdAt: '2026-05-26T00:00:00.000Z',
    enabled: true,
    homePath,
    id: agentId,
    teamId: 'default',
    ...(overrides.operator ? { operator: overrides.operator } : {}),
    profile: { displayName: 'Scout', role: 'Engineering agent' },
    provider: { kind: 'codex-cli', model: 'gpt-5.5' },
    feishu: {
      appId: '',
      appSecret: '',
      connected: false,
      encryptKey: '',
      verificationToken: '',
    },
    slack: {
      appToken: overrides.slack?.appToken ?? '',
      botToken: overrides.slack?.botToken ?? '',
      connected: Boolean(overrides.slack?.appToken && overrides.slack?.botToken),
      manifestVersion: 0,
      teamId: overrides.slack?.teamId ?? '',
      workspaceIconUrl: '',
      workspaceName: '',
    },
  });
}

function fakeSlackClient(output: { ephemerals?: unknown[]; updates?: unknown[] } = {}): WebClient {
  return {
    chat: {
      postEphemeral: async (body: unknown) => {
        output.ephemerals?.push(body);
        return { ok: true };
      },
      update: async (body: unknown) => {
        output.updates?.push(body);
        return { ok: true };
      },
    },
    users: {
      info: async ({ user }: { user: string }) => ({
        ok: true,
        user: user === 'U-operator'
          ? {
              id: 'U-operator',
              name: 'alice',
              profile: { display_name: 'Alice' },
            }
          : { id: user, name: 'other' },
      }),
    },
  } as unknown as WebClient;
}

