import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildWebApp } from '../web/app.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { LinearStore } from '../storage/schema/linear.store.js';
import { assertLinearContactAllowed } from '../linear/contact-policy.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { install, seedLinear } from './helpers/linear.js';
import { linearQueryErrors } from './helpers/linear-schema.js';

const org = install.organizationId;
const otherOrg = randomUUID();
const saved = randomUUID();
const alex = randomUUID();
const base = `/api/do-not-contact/linear/${org}`;
const firstPage = [
  { id: alex, name: 'Alex Kim', displayName: 'alex', avatarUrl: 'https://public.linear.app/alex.png', app: false },
  { id: randomUUID(), name: 'Scout', displayName: 'scout', avatarUrl: null, app: true },
  { id: randomUUID(), name: 'sam@example.com', displayName: 'sam', avatarUrl: 'http://insecure.example/sam.png', app: false },
];
const secondPage = [{ id: saved.toUpperCase(), name: 'Saved Person', displayName: 'saved', avatarUrl: null, app: false }];

type Call = { query: string; variables: Record<string, unknown>; auth: string | null };

async function fixture(t: TestContext, run: (f: {
  app: ReturnType<typeof buildWebApp>; home: string; calls: Call[]; mode: { org: string; fail: boolean };
  members: (id?: string) => Promise<string[] | undefined>;
}) => Promise<void>) {
  await withTempAnimaHome(async (home) => {
    await seedLinear(home);
    const calls: Call[] = [];
    const mode = { org, fail: false };
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      assert.equal(String(url), 'https://api.linear.app/graphql', 'no token refresh or other endpoint');
      const { query, variables } = JSON.parse(String(init?.body));
      calls.push({ query, variables, auth: new Headers(init?.headers).get('authorization') });
      assert.deepEqual(linearQueryErrors(query), []);
      if (mode.fail) return new Response('{}', { status: 500 });
      const last = Boolean(variables.after);
      return Response.json({ data: { organization: { id: mode.org }, users: { nodes: last ? secondPage : firstPage, pageInfo: { hasNextPage: !last, endCursor: last ? null : 'page-2' } } } });
    });
    await serverConfigStore.update((config) => ({ ...config, dashboardHost: '127.0.0.1', doNotContact: { T123: ['U123'] }, linearDoNotContact: { [org]: [saved], [otherOrg]: [alex] } }));
    const app = buildWebApp();
    try {
      await run({ app, home, calls, mode, members: async (id = org) => (await serverConfigStore.read()).linearDoNotContact?.[id] });
    } finally {
      await app.close();
      assert.ok(calls.every((call) => !/\bmutation\b/.test(call.query)), 'directory and list edits never write to Linear');
      await assert.rejects(readFile(join(home, 'run', 'agent.pid')), { code: 'ENOENT' });
    }
  });
}

const workspace = (body: string, id: string) => JSON.parse(body).workspaces.find((w: { id: string }) => w.id === id);

test('lists connected and saved Linear workspaces by name, after Slack, without Linear calls or credentials', async (t) => fixture(t, async ({ app, calls }) => {
  const response = await app.inject('/api/do-not-contact');
  assert.equal(response.statusCode, 200);
  // Slack first, then Linear by name: a saved-only organization is named by its ID (hex sorts before "Synthetic").
  assert.deepEqual(response.json().workspaces.map((w: { platform: string; id: string }) => [w.platform, w.id]), [['slack', 'T123'], ['linear', otherOrg], ['linear', org]]);
  assert.deepEqual(workspace(response.body, org), { platform: 'linear', id: org, name: 'Synthetic workspace', memberIds: [saved], canLookup: true });
  assert.deepEqual(workspace(response.body, otherOrg), { platform: 'linear', id: otherOrg, name: otherOrg, memberIds: [alex], canLookup: false });
  assert.doesNotMatch(response.body, /sentinel|accessToken|refreshToken|clientSecret|scout/);
  assert.equal(calls.length, 0);
}));

test('directory lists people only, never email, with the agent token on the server', async (t) => fixture(t, async ({ app, calls }) => {
  const response = await app.inject(`${base}/users`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json().users, [
    { linearUserId: alex, name: 'Alex Kim', displayName: 'alex', avatarUrl: 'https://public.linear.app/alex.png' },
    { linearUserId: firstPage[2]!.id, name: 'sam', displayName: 'sam' },
    { linearUserId: saved, name: 'Saved Person', displayName: 'saved' },
  ]);
  assert.doesNotMatch(response.body, /@|sentinel|scout|insecure/);
  assert.equal(calls.length, 2, 'two pages');
  assert.deepEqual(calls.map((call) => call.variables.after), [null, 'page-2']);
  assert.ok(calls.every((call) => call.auth === `Bearer ${install.accessToken}` && /app:\{eq:false\}/.test(call.query) && !/email/.test(call.query)));
}));

test('a token for another organization, or a failed lookup, is unavailable and changes nothing', async (t) => fixture(t, async ({ app, mode }) => {
  for (const failure of ['org', 'http'] as const) {
    if (failure === 'org') mode.org = otherOrg; else { mode.org = org; mode.fail = true; }
    const before = await serverConfigStore.read();
    const lookup = await app.inject(`${base}/users`);
    assert.equal(lookup.statusCode, 503);
    assert.match(lookup.body, /Linear directory unavailable/);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/members`, payload: { userId: alex } })).statusCode, 503);
    assert.deepEqual(await serverConfigStore.read(), before);
    assert.equal((await app.inject('/api/do-not-contact')).statusCode, 200);
  }
}));

test('add verifies the person in the directory, dedupes, and takes effect on the next write; remove lifts it', async (t) => fixture(t, async ({ app, members }) => {
  const identity = new LinearIdentityService('scout');
  const send = (method: 'POST' | 'DELETE', userId: string) => app.inject({ method, url: `${base}/members`, payload: { userId } });
  const check = () => assertLinearContactAllowed({ identity, tool: 'anima.linear.reply', markdown: `assigning ${alex}` });
  await check();
  assert.equal((await send('POST', alex.toUpperCase())).statusCode, 200);
  assert.equal((await send('POST', alex)).statusCode, 200);
  assert.deepEqual(await members(), [saved, alex]);
  assert.deepEqual(await members(otherOrg), [alex], 'other organizations untouched');
  assert.deepEqual((await serverConfigStore.read()).doNotContact, { T123: ['U123'] }, 'Slack lists untouched');
  await assert.rejects(check(), /do-not-contact list/);
  assert.equal((await send('DELETE', alex)).statusCode, 200);
  assert.deepEqual(await members(), [saved]);
  await check();
}));

test('unknown people, app users and malformed input cannot be added', async (t) => fixture(t, async ({ app }) => {
  const before = await serverConfigStore.read();
  for (const userId of [randomUUID(), firstPage[1]!.id]) {
    assert.equal((await app.inject({ method: 'POST', url: `${base}/members`, payload: { userId } })).statusCode, 400);
  }
  for (const request of [
    { url: `${base}/members`, payload: { userId: 'nicholas' } },
    { url: `${base}/members`, payload: { userId: alex, agentId: 'scout' } },
    { url: '/api/do-not-contact/linear/not-a-uuid/members', payload: { userId: alex } },
  ]) assert.equal((await app.inject({ method: 'POST', ...request })).statusCode, 400);
  assert.deepEqual(await serverConfigStore.read(), before);
}));

test('a disconnected, revoked or disabled connection keeps saved IDs and allows removal without Linear', async (t) => fixture(t, async ({ app, calls, members }) => {
  await new AgentStore('scout').update((agent) => ({ ...agent, enabled: false }));
  assert.equal(workspace((await app.inject('/api/do-not-contact')).body, org).canLookup, false);
  await new AgentStore('scout').update((agent) => ({ ...agent, enabled: true }));
  await new LinearStore('scout').update((file) => ({ ...file, installation: { ...file.installation!, revoked: true } }));
  assert.deepEqual(workspace((await app.inject('/api/do-not-contact')).body, org), { platform: 'linear', id: org, name: 'Synthetic workspace', memberIds: [saved], canLookup: false });
  await new LinearIdentityService('scout').remove();
  assert.deepEqual(workspace((await app.inject('/api/do-not-contact')).body, org), { platform: 'linear', id: org, name: org, memberIds: [saved], canLookup: false });
  assert.equal((await app.inject(`${base}/users`)).statusCode, 503);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members`, payload: { userId: saved } })).statusCode, 200);
  assert.deepEqual(await members(), []);
  assert.equal(calls.length, 0);
}));

test('dashboard authentication protects Linear lookup, add and remove before any Linear call or write', async (t) => fixture(t, async ({ app, calls }) => {
  await serverConfigStore.update((config) => ({ ...config, dashboardAuth: { enabled: true, passwordHash: 'fixture', sessionSecret: 'fixture-secret-at-least-16' } }));
  const before = await serverConfigStore.read();
  for (const request of [
    { method: 'GET' as const, url: `${base}/users` },
    { method: 'POST' as const, url: `${base}/members`, payload: { userId: alex } },
    { method: 'DELETE' as const, url: `${base}/members`, payload: { userId: saved } },
  ]) assert.equal((await app.inject(request)).statusCode, 401);
  assert.deepEqual(await serverConfigStore.read(), before); assert.equal(calls.length, 0);
}));
