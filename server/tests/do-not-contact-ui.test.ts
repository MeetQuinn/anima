import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildWebApp } from '../web/app.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { assertSlackContactAllowed } from '../messages/contact-policy.service.js';
import { createSlackWebClient } from '../slack/client.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { bearerToken, slackRequestBody, startSlackApiMock } from './helpers/slack-api.js';

const team = 'T123';
const member = { id: 'U123', name: 'alex', team_id: team, profile: { display_name: 'Alex', image_72: 'https://example.test/avatar.png' } };
const base = `/api/do-not-contact/${team}`;

async function fixture(run: (f: {
  app: ReturnType<typeof buildWebApp>; home: string; calls: string[];
  mode: { authTeam: string; failAuth: boolean; failUsers: boolean };
  addAgent: (id: string, teamId: string, token?: string) => Promise<void>;
}) => Promise<void>) {
  const calls: string[] = [];
  const mode = { authTeam: team, failAuth: false, failUsers: false };
  const api = await startSlackApiMock((method, body, request) => {
    const token = bearerToken(request);
    calls.push(`${token}:${method}`);
    if (method === 'auth.test') return mode.failAuth || token === 'xoxb-broken'
      ? { ok: false, error: 'invalid_auth' } : { ok: true, team_id: mode.authTeam, user_id: 'UBOT' };
    if (method === 'users.list') {
      if (mode.failUsers) return { ok: false, error: 'missing_scope' };
      return slackRequestBody(body).cursor
        ? { ok: true, members: [{ ...member, id: 'U456', name: 'alex2' }], response_metadata: { next_cursor: '' } }
        : { ok: true, members: [member, { ...member, id: 'U999', is_bot: true }], response_metadata: { next_cursor: 'page2' } };
    }
    if (method === 'users.info') return { ok: true, user: member };
    throw new Error(`Unexpected Slack operation: ${method}`);
  });
  const oldUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = api.url;
  try {
    await withTempAnimaHome(async (home) => {
      const addAgent = async (id: string, teamId: string, token = 'xoxb-fixture') => {
        await mkdir(join(home, 'agents', id), { recursive: true });
        await writeFile(join(home, 'agents', id, 'config.json'), JSON.stringify({
          id, homePath: join(home, 'agent-home'), profile: { displayName: id },
          slack: { teamId, workspaceName: 'Test workspace', botToken: token, appToken: 'xapp-fixture' },
          provider: { kind: 'codex-cli', model: 'gpt-5.5' },
        }));
      };
      await addAgent('scout', team);
      await serverConfigStore.write({ dashboardHost: '127.0.0.1', doNotContact: { TOTHER: ['UOTHER'], [team]: ['USAVED'] } });
      const app = buildWebApp();
      try { await run({ app, home, calls, mode, addAgent }); }
      finally {
        await app.close();
        assert.ok(calls.every((call) => /:(auth.test|users.list|users.info)$/.test(call)), 'directory/list edits cannot send messages, open DMs, upload or wake agents');
        await assert.rejects(readFile(join(home, 'run', 'agent.pid')), { code: 'ENOENT' });
      }
    });
  } finally {
    if (oldUrl === undefined) delete process.env.ANIMA_SLACK_API_URL; else process.env.ANIMA_SLACK_API_URL = oldUrl;
    await api.close();
  }
}

test('contact UI lists configured and disconnected workspaces without Slack calls or credentials', async () => fixture(async ({ app, calls }) => {
  const response = await app.inject('/api/do-not-contact');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json().workspaces.map((w: { id: string }) => w.id).sort(), [team, 'TOTHER'].sort());
  assert.deepEqual(response.json().workspaces.find((w: { id: string }) => w.id === 'TOTHER'), { id: 'TOTHER', name: 'TOTHER', memberIds: ['UOTHER'], canLookup: false });
  assert.ok(!/xoxb|xapp|botToken|agentId/.test(response.body));
  assert.equal(calls.length, 0);
}));

test('directory verifies token workspace and paginates only read APIs; no source selector leaks', async () => fixture(async ({ app, calls }) => {
  const response = await app.inject(`${base}/users`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().users.map((u: { slackUserId: string }) => u.slackUserId), ['U123', 'U456']);
  assert.equal(calls.filter((c) => c.endsWith(':users.list')).length, 2);
  assert.ok(!/xoxb|xapp|botToken|agentId/.test(response.body));
}));

test('wrong configured workspace never borrows an unrelated agent token', async () => fixture(async ({ app, calls, addAgent }) => {
  await addAgent('other', 'TOTHER', 'xoxb-other');
  const response = await app.inject('/api/do-not-contact/TMISSING/users');
  assert.equal(response.statusCode, 503);
  assert.equal(calls.length, 0);
}));

test('actual token identity mismatch refuses before directory cache access and before write', async () => fixture(async ({ app, calls, mode }) => {
  mode.authTeam = 'TWRONG';
  const before = await serverConfigStore.read();
  assert.equal((await app.inject({ method: 'POST', url: `${base}/members`, payload: { userId: 'U123' } })).statusCode, 503);
  assert.ok(calls.every((call) => call.endsWith(':auth.test')));
  assert.deepEqual(await serverConfigStore.read(), before);
}));

test('directory can use another same-workspace connection without changing policy scope', async () => fixture(async ({ app, calls, addAgent }) => {
  await addAgent('aaa', team, 'xoxb-broken');
  const response = await app.inject(`${base}/users`);
  assert.equal(response.statusCode, 200);
  assert.ok(calls.includes('xoxb-broken:auth.test'));
  assert.ok(calls.includes('xoxb-fixture:users.list'));
}));

for (const failure of ['failAuth', 'failUsers'] as const) {
  test(`${failure} leaves existing IDs and other configuration unchanged`, async () => fixture(async ({ app, mode }) => {
    mode[failure] = true;
    const before = await serverConfigStore.read();
    assert.equal((await app.inject({ method: 'POST', url: `${base}/members`, payload: { userId: 'U123' } })).statusCode, 503);
    assert.deepEqual(await serverConfigStore.read(), before);
    assert.equal((await app.inject('/api/do-not-contact')).statusCode, 200);
  }));
}

test('add/remove edit only one membership, dedupe, preserve concurrent config and hot policy reads', async () => fixture(async ({ app }) => {
  const send = (userId: string) => app.inject({ method: 'POST', url: `${base}/members`, payload: { userId } });
  assert.equal((await send('U123')).statusCode, 200);
  assert.equal((await send('U123')).statusCode, 200);
  await Promise.all([send('U456'), serverConfigStore.update((config) => ({ ...config, dashboardPort: 5555 }))]);
  const config = await serverConfigStore.read();
  assert.equal(config.dashboardHost, '127.0.0.1'); assert.equal(config.dashboardPort, 5555);
  assert.deepEqual(config.doNotContact, { TOTHER: ['UOTHER'], [team]: ['USAVED', 'U123', 'U456'] });
  await assert.rejects(assertSlackContactAllowed({ agentId: 'scout', teamId: team, channelId: 'C123', content: { text: '<@U123>' }, client: createSlackWebClient('xoxb-fixture'), tool: 'anima.message.send' }), /do-not-contact list/);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members`, payload: { userId: 'U123' } })).statusCode, 200);
  await assertSlackContactAllowed({ agentId: 'scout', teamId: team, channelId: 'C123', content: { text: '<@U123>' }, client: createSlackWebClient('xoxb-fixture'), tool: 'anima.message.send' });
  assert.deepEqual((await serverConfigStore.read()).doNotContact?.[team], ['USAVED', 'U456']);
}));

test('unknown users and bots cannot be added; malformed input cannot write', async () => fixture(async ({ app }) => {
  const before = await serverConfigStore.read();
  for (const userId of ['UUNKNOWN', 'U999', 'bad']) assert.equal((await app.inject({ method: 'POST', url: `${base}/members`, payload: { userId } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `${base}/members`, payload: { userId: 'U123', agentId: 'other' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/do-not-contact/wrong/members', payload: { userId: 'USAVED' } })).statusCode, 400);
  assert.deepEqual(await serverConfigStore.read(), before);
}));

test('disconnected workspace retains IDs and permits explicit removal without Slack', async () => fixture(async ({ app, home, calls }) => {
  await rm(join(home, 'agents/scout/config.json'));
  const list = (await app.inject('/api/do-not-contact')).json().workspaces;
  assert.deepEqual(list.find((w: { id: string }) => w.id === team).memberIds, ['USAVED']);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members`, payload: { userId: 'USAVED' } })).statusCode, 200);
  assert.equal(calls.length, 0);
}));

test('invalid stored config surfaces a load error, never an empty list or overwrite', async () => fixture(async ({ app, home }) => {
  const path = join(home, 'config.json'); await writeFile(path, '{bad');
  assert.equal((await app.inject('/api/do-not-contact')).statusCode, 500);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members`, payload: { userId: 'USAVED' } })).statusCode, 500);
  assert.equal(await readFile(path, 'utf8'), '{bad');
}));

test('dashboard authentication protects list, lookup, add and remove before any Slack or writes', async () => fixture(async ({ app, calls }) => {
  await serverConfigStore.update((config) => ({ ...config, dashboardAuth: { enabled: true, passwordHash: 'fixture', sessionSecret: 'fixture-secret-at-least-16' } }));
  const before = await serverConfigStore.read();
  for (const request of [
    { method: 'GET' as const, url: '/api/do-not-contact' },
    { method: 'GET' as const, url: `${base}/users` },
    { method: 'POST' as const, url: `${base}/members`, payload: { userId: 'U123' } },
    { method: 'DELETE' as const, url: `${base}/members`, payload: { userId: 'USAVED' } },
  ]) assert.equal((await app.inject(request)).statusCode, 401);
  assert.deepEqual(await serverConfigStore.read(), before); assert.equal(calls.length, 0);
}));
