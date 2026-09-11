import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { activityServiceForAgent } from '../activities/activity.service.js';
import { AgentService } from '../agents/agent.service.js';
import { assertSlackContactAllowed } from '../messages/contact-policy.service.js';
import { setCursorDeliveryEnabledForTests } from '../runtime/cursor-delivery.js';
import { createSlackWebClient } from '../slack/client.js';
import { ServerConfig } from '../storage/schema/server.store.js';
import { ObservedConversationStore } from '../storage/schema/observed-conversation.store.js';
import { runAsk } from '../tools/ask.js';
import { runFileSend } from '../tools/file-send.js';
import { runMessageSend, runMessageUpdate } from '../tools/messages.js';
import { withAnimaHome } from './anima-home.js';
import { slackRequestBody, startSlackApiMock } from './helpers/slack-api.js';

const TEAM = 'T0123ABC';
const USER = 'U0AAAA';
const refusal = "Not sent. Jialin (U0AAAA) is on this workspace's do-not-contact list: they asked never to receive messages from agents. Do not DM or @mention them, do not try another agent or channel to reach them. If something needs to reach them, hand it to your human owner.";
const policy = { doNotContact: { [TEAM]: [USER] } };

async function fixture(body: (f: {
  home: string; calls: string[]; outputs: string[];
  override: Map<string, (body: Record<string, unknown>) => Record<string, unknown>>;
  check: (input?: Partial<Parameters<typeof assertSlackContactAllowed>[0]>) => Promise<void>;
  run: (kind: string, channel: string, text: string) => Promise<void>;
  url: string;
}) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'anima-contact-policy-'));
  const calls: string[] = [];
  const outputs: string[] = [];
  const override = new Map<string, (body: Record<string, unknown>) => Record<string, unknown>>();
  const user = { id: USER, name: 'jialin', profile: { display_name: 'Jialin' } };
  const api = await startSlackApiMock((method, raw) => {
    calls.push(method);
    const data = slackRequestBody(raw);
    const custom = override.get(method);
    if (custom) return custom(data);
    if (method === 'auth.test') return { ok: true, team_id: TEAM, user_id: 'UBOT' };
    if (method === 'users.info') return { ok: true, user };
    if (method === 'users.list') return { ok: true, members: [user] };
    if (method === 'conversations.open') return { ok: true, channel: { id: 'D123', is_im: true, user: USER } };
    if (method === 'conversations.info') {
      const id = String(data.channel);
      return { ok: true, channel: { id, name: 'general', is_im: id.startsWith('D'), is_mpim: id === 'G123', user: id.startsWith('D') ? USER : undefined } };
    }
    if (method === 'conversations.members') return { ok: true, members: ['UBOT', USER] };
    if (method === 'chat.postMessage' || method === 'chat.update') return { ok: true, channel: data.channel, ts: '10.1' };
    return { ok: false, error: `unexpected_${method}` };
  });
  const oldAgent = process.env.ANIMA_AGENT_ID;
  const oldSlack = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_AGENT_ID = 'scout';
  process.env.ANIMA_SLACK_API_URL = api.url;
  setCursorDeliveryEnabledForTests(false);
  try {
    await withAnimaHome(home, async () => {
      await mkdir(join(home, 'agents/scout'), { recursive: true });
      await mkdir(join(home, 'agent-home'));
      await writeFile(join(home, 'config.json'), JSON.stringify(policy));
      await writeFile(join(home, 'agents/scout/config.json'), JSON.stringify({
        id: 'scout', homePath: join(home, 'agent-home'),
        slack: { appToken: 'xapp-test', botToken: 'xoxb-test', botUserId: 'UBOT', teamId: TEAM },
        provider: { kind: 'codex-cli', model: 'gpt-5.5' },
      }));
      const file = join(home, 'note.txt');
      await writeFile(file, 'hello');
      await body({
        home, calls, outputs, override, url: api.url,
        check: (input = {}) => assertSlackContactAllowed({
          agentId: 'scout', teamId: TEAM, channelId: 'C123', content: {},
          client: createSlackWebClient('xoxb-test'), tool: 'anima.message.send', ...input,
        }),
        run: async (kind, channel, text) => {
          const deps = { writeOutput: (line: string) => outputs.push(line) };
          if (kind === 'send') await runMessageSend({ agent: 'scout', channel, text }, deps);
          else if (kind === 'update') await runMessageUpdate({ agent: 'scout', channel, text, messageTs: '10.0' }, deps);
          else if (kind === 'file') await runFileSend({ agent: 'scout', channel, caption: text, paths: [file] });
          else await runAsk({ channel, question: text, option: ['Yes', 'No'], replyHint: true });
        },
      });
    });
  } finally {
    if (oldAgent === undefined) delete process.env.ANIMA_AGENT_ID; else process.env.ANIMA_AGENT_ID = oldAgent;
    if (oldSlack === undefined) delete process.env.ANIMA_SLACK_API_URL; else process.env.ANIMA_SLACK_API_URL = oldSlack;
    setCursorDeliveryEnabledForTests(undefined);
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
}

test('policy config is strict and optional', () => {
  for (const value of [{}, { doNotContact: {} }, policy]) assert.equal(ServerConfig.safeParse(value).success, true);
  for (const doNotContact of [{ bad: [USER] }, { [TEAM]: ['bad'] }, { [TEAM]: USER }, [], null]) {
    assert.equal(ServerConfig.safeParse({ doNotContact }).success, false);
  }
});

for (const kind of ['send', 'update', 'ask', 'file']) {
  for (const [channel, text] of [['D123', 'hello'], ['G123', 'hello'], ['C123', `<@${USER}> hello`]]) {
    test(`${kind} refuses ${channel} before Slack mutation, with exact failure copy`, async () => {
      await fixture(async ({ run, calls, outputs }) => {
        await assert.rejects(run(kind, channel!, text!), { message: refusal });
        assert.deepEqual(calls.filter((m) => m.startsWith('chat.') || m.startsWith('files.')), []);
        assert.deepEqual(outputs, []);
        const rows = await activityServiceForAgent('scout').readAll();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.type, 'tool.call.failed');
        assert.equal(rows[0]?.payload?.error, refusal);
        assert.equal(rows[0]?.payload.failureKind, 'do-not-contact');
      });
    });
  }
}

test('normalized handles and ask --to auto-mention are checked', async () => fixture(async ({ run, calls }) => {
  await assert.rejects(run('send', 'C123', 'hello @jialin'), { message: refusal });
  await assert.rejects(runAsk({ channel: 'C123', to: USER, question: 'Choose', option: ['A', 'B'], replyHint: true }), { message: refusal });
  assert.equal(calls.includes('chat.postMessage'), false);
}));

test('plain channel/thread messages and code mentions pass; final blocks are authoritative', async () => fixture(async ({ run, check, calls }) => {
  await run('send', 'C123', 'hello');
  await run('update', 'C123', '`<@U0AAAA>`');
  await runMessageSend({ agent: 'scout', channel: 'C123', threadTs: '1.0', text: 'reply without mention' }, { writeOutput: () => {} });
  for (const type of ['plain_text', 'mrkdwn']) {
    await check({ content: { text: '<@U0AAAA>', blocks: [{ type: 'section', text: { type, text: type === 'mrkdwn' ? '`<@U0AAAA>`' : '<@U0AAAA>' } }] } });
  }
  await assert.rejects(check({ content: { text: 'short fallback', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<@U0AAAA>' } }] } }), { message: refusal });
  assert.equal(calls.filter((m) => m === 'chat.postMessage').length, 2);
  assert.equal(calls.filter((m) => m === 'chat.update').length, 1);
}));

test('same-process atomic edits apply to every agent, workspace-isolated, and survive agent removal', async () => fixture(async ({ home, check, run }) => {
  const change = async (value: unknown) => {
    await writeFile(join(home, 'config.next'), JSON.stringify(value));
    await rename(join(home, 'config.next'), join(home, 'config.json'));
  };
  await change({});
  await run('send', 'D123', 'hello');
  await change(policy);
  await assert.rejects(run('send', 'D123', 'hello'), { message: refusal });
  await assert.rejects(check({ agentId: 'second', dmUserId: USER }), { message: refusal });
  await check({ teamId: 'TOTHER', dmUserId: USER });
  const oldAgent = await new AgentService('scout').removeAgent();
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), policy);
  await assert.rejects(check({ agentId: 'replacement', dmUserId: USER }), { message: refusal });
  await new AgentService('scout').createAgent(oldAgent);
  await change({ doNotContact: { [TEAM]: [] } });
  await run('send', 'D123', 'hello');
}));

test('MPIM walks all membership pages; unknown/private channel classification fails closed', async () => fixture(async ({ check, override }) => {
  override.set('conversations.members', (data) => data.cursor
    ? { ok: true, members: [USER] }
    : { ok: true, members: ['UBOT'], response_metadata: { next_cursor: 'page2' } });
  await assert.rejects(check({ channelId: 'G123' }), { message: refusal });
  override.set('conversations.info', (data) => ({ ok: true, channel: { id: data.channel, is_mpim: false } }));
  await check({ channelId: 'GPRIVATE' });
  override.set('conversations.info', (data) => ({ ok: true, channel: { id: data.channel } }));
  await assert.rejects(check({ channelId: 'GUNKNOWN' }), /could not verify/);
}));

for (const response of [{ ok: false, error: 'missing_scope' }, { ok: true }, { ok: true, members: [] }, { ok: true, members: [null] }]) {
  test(`membership failure refuses: ${JSON.stringify(response)}`, async () => fixture(async ({ check, override }) => {
    override.set('conversations.members', () => response);
    await assert.rejects(check({ channelId: 'G123' }), /could not verify/);
  }));
}

test('raw DM lookup failure refuses; absent name uses ID alone', async () => fixture(async ({ home, check, override }) => {
  override.set('conversations.info', () => ({ ok: false, error: 'channel_not_found' }));
  await assert.rejects(check({ channelId: 'DUNKNOWN' }), /could not verify/);
  override.set('users.info', () => ({ ok: false, error: 'user_not_found' }));
  await writeFile(join(home, 'config.json'), JSON.stringify({ doNotContact: { TNONAME: [USER] } }));
  await assert.rejects(check({ teamId: 'TNONAME', dmUserId: USER }), { message: refusal.replace('Jialin (U0AAAA)', 'U0AAAA') });
}));

test('corrupt and unreadable config refuse with a safe actionable failure', async () => fixture(async ({ home, run, calls }) => {
  for (const invalid of ['{"SECRET":', '{"doNotContact":{"T0123ABC":"SECRET"}}']) {
    await writeFile(join(home, 'config.json'), invalid);
    await assert.rejects(run('send', 'C123', 'hello'), /Not sent.*configuration.*human owner/);
  }
  await rm(join(home, 'config.json'));
  await mkdir(join(home, 'config.json'));
  await assert.rejects(run('send', 'C123', 'hello'), /Not sent.*configuration.*human owner/);
  assert.equal(calls.includes('chat.postMessage'), false);
  const rows = await activityServiceForAgent('scout').readAll();
  assert.equal(rows.length, 3);
  assert.equal(JSON.stringify(rows).includes('SECRET'), false);
}));

test('policy refusal precedes hold and never advances its cursor', async () => fixture(async ({ run }) => {
  setCursorDeliveryEnabledForTests(true);
  const store = new ObservedConversationStore('scout');
  await store.observe({ teamId: TEAM, channelId: 'C123', messageTs: '1.0', text: 'new', userId: 'UOTHER' });
  const before = await store.getCursor(`slack:${TEAM}:C123`);
  await assert.rejects(run('send', 'C123', '<@U0AAAA>'), { message: refusal });
  const after = await store.getCursor(`slack:${TEAM}:C123`);
  assert.deepEqual(after, before);
  assert.equal((await activityServiceForAgent('scout').readAll()).some((row) => row.type === 'tool.call.held'), false);
}));

for (const kind of ['send', 'update', 'ask', 'file']) {
test(`${kind} CLI exits 1, stderr carries exact refusal, stdout has no success`, async () => fixture(async ({ home, url }) => {
  const command = kind === 'ask' ? ['ask', '--question', 'Choose', '--option', 'Yes', '--option', 'No']
    : kind === 'file' ? ['file', 'send', join(home, 'note.txt')]
    : ['message', kind, ...(kind === 'update' ? ['--message-ts', '10.0'] : [])];
  const child = spawn(process.execPath, [resolve('dist/server/cli/anima.js'), ...command, '--channel', 'D123'], {
    env: { PATH: process.env.PATH, ANIMA_HOME: home, ANIMA_AGENT_ID: 'scout', ANIMA_SLACK_API_URL: url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('hello');
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit, reject) => { child.on('error', reject); child.on('exit', resolveExit); });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr.trim(), `error anima.do_not_contact (not retryable): ${refusal}`);
}));
}

test('group membership is rechecked at send time and a failed later page refuses', async () => fixture(async ({ check, override }) => {
  override.set('conversations.members', () => ({ ok: true, members: ['UBOT', 'UOTHER'] }));
  await check({ channelId: 'G123' });
  override.set('conversations.members', () => ({ ok: true, members: ['UBOT', USER] }));
  await assert.rejects(check({ channelId: 'G123' }), { message: refusal });
  override.set('conversations.members', (data) => data.cursor ? { ok: false, error: 'missing_scope' }
    : { ok: true, members: ['UBOT'], response_metadata: { next_cursor: 'page2' } });
  await assert.rejects(check({ channelId: 'G123' }), /could not verify/);
}));

test('operator guide retains the shipped heading and rule', async () => {
  const guide = await readFile(resolve('docs/guide/working-with-your-agent.md'), 'utf8');
  assert.ok(guide.includes('## Do-not-contact list\n\nAgents on this host connected to this workspace will not DM or @mention these people. Channel messages are unaffected.'));
});
