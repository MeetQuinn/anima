import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { WebClient } from '@slack/web-api';

import { interactiveAskServiceForAgent } from '../asks/interactive-ask.service.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { withAnimaHome } from '../anima-home.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { InteractiveAskStore } from '../storage/schema/interactive-ask.store.js';
import { SubscriptionStore } from '../storage/schema/subscription.store.js';
import type { InteractiveAskRecord } from '../storage/schema/interactive-ask.store.js';

const cliPath = resolve('dist/server/cli/anima.js');

test('anima ask posts Block Kit buttons, stores the ask, and subscribes to typed replies', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-cli-'));
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
      assert.equal(blocks[0]?.type, 'section');
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

test('interactive ask answer enqueues one choice_response and renders a reply target', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-answer-'));
  await withAnimaHome(stateDir, async () => {
    await writeAgentConfig('scout', {
      slack: { appToken: 'xapp-test', botToken: 'xoxb-test', teamId: 'T-demo' },
    });
    const ask = await savePendingAsk({
      allowedUserIds: ['U-operator'],
      messageTs: '1770000500.000001',
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
    assert.match(prompt, /Use `anima message send --channel C-product --thread-ts 1770000500\.000001`/);
  });
});

test('interactive ask rejects non-addressee clicks without waking the agent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-forbidden-'));
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
    const storedAsk = await askService.getAsk(ask.askId);
    assert.equal(storedAsk?.status, 'pending');
    assert.match(storedAsk?.lastInteractionAt ?? '', /^\d{4}-/);
  });
});

test('interactive ask retention prunes old answered asks but keeps pending asks', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-retention-'));
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

test('anima ask rejects bot users as explicit answer targets', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-interactive-ask-bot-target-'));
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
      assert.match(run.stderr, /human Slack users, not bots/);
      assert.equal(posts.length, 0);
    });
  } finally {
    await slackApi.close();
  }
});

async function savePendingAsk(overrides: Partial<InteractiveAskRecord> = {}): Promise<InteractiveAskRecord> {
  const ask = askRecord(overrides);
  await interactiveAskServiceForAgent('scout').saveAsk(ask);
  return ask;
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
    ...(overrides.operator ? { operator: overrides.operator } : {}),
    profile: { displayName: 'Scout', role: 'Engineering agent' },
    provider: { kind: 'codex-cli', model: 'gpt-5.3-codex' },
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

async function runNode(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const child = spawn(process.execPath, args, {
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (opts.input) child.stdin.end(opts.input);
  else child.stdin.end();
  const [code] = await once(child, 'close') as [number | null];
  return { stdout, stderr, status: code };
}

async function startSlackApiMock(
  handler: (method: string, body: string, request: IncomingMessage) => unknown,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const method = request.url?.split('/').pop() ?? '';
      const payload = handler(method, body, request);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ok: false }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return {
    close: async () => {
      server.close();
      await once(server, 'close');
    },
    url: `http://127.0.0.1:${address.port}/api`,
  };
}

function slackRequestBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

function slackBlocks(body: Record<string, unknown>): Array<{
  action_id?: string;
  elements?: Array<{ action_id?: string; value?: string }>;
  type: string;
}> {
  if (Array.isArray(body['blocks'])) {
    return body['blocks'] as Array<{ type: string }>;
  }
  assert.equal(typeof body['blocks'], 'string');
  return JSON.parse(body['blocks'] as string) as Array<{ type: string }>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}
