import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearApiError, LinearClient } from '../linear/client.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { redactAgentConfig } from '../agents/agent-config-ops.js';
import { buildWebApp } from '../web/app.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { withTempAnimaHome, writeAgentConfigs } from './helpers/harness.js';
import { FakeLinear, created, install, seedLinear, sessionId } from './helpers/linear.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';

const request = { clientId: install.clientId, clientSecret: install.clientSecret!, signingSecret: install.signingSecret, callbackUrl: 'http://localhost:14174/api/linear/oauth/callback' };
// Values that must never leave the private Linear store: the app secret and
// anything Linear wrote in an error body.
const PRIVATE = [install.clientSecret!, 'private-description-sentinel', 'private-upstream-sentinel', 'candidate-secret-sentinel'];
const assertNoPrivate = (text: string) => { for (const value of PRIVATE) assert.equal(text.includes(value), false, `leaked ${value.slice(0, 12)}`); };
async function publicSurfaces(home: string, identity: LinearIdentityService): Promise<string> {
  const config = await new AgentStore('scout').read();
  return JSON.stringify([await identity.status(), redactAgentConfig(config), config]) + await readFile(join(home, 'agents/scout/config.json'), 'utf8');
}
// An installation made before Anima kept the client secret.
async function seedLegacy(home: string, fake = new FakeLinear(), expired = true) {
  const seeded = await seedLinear(home, fake);
  await seeded.store.update((file) => ({ ...file, installation: { ...file.installation!, clientSecret: undefined, ...(expired ? { expiresAt: 0 } : {}) } }));
  return seeded;
}
// Compare stored records as written to disk.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('install exchanges the code with the client secret and PKCE verifier and keeps the secret only in the private store', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [{ id: 'scout' } as any]);
  const fake = new FakeLinear();
  const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
  const authorizationUrl = (await identity.begin(request, 'binding')).authorizationUrl;
  assert.equal(authorizationUrl.includes(install.clientSecret!), false, 'The browser never sees the secret');
  assert.equal((await identity.store.read()).pending?.clientSecret, install.clientSecret);
  await identity.finish(new URL(authorizationUrl).searchParams.get('state')!, 'synthetic-code', 'binding');
  assert.deepEqual(fake.tokenRequests, [{ grant: 'authorization_code', clientSecret: true, verifier: true }]);
  const file = await identity.store.read();
  assert.equal(file.pending, undefined);
  assert.equal(file.installation?.clientSecret, install.clientSecret);
  const status = await identity.status();
  assert.equal(status.state, 'connected'); assert.equal(status.clientSecretSaved, true);
  assert.equal(status.clientRejected, undefined); assert.equal(status.installationId, file.installation!.id);
  assertNoPrivate(await publicSurfaces(home, identity));
  assert.equal((await stat(join(home, 'agents/scout/linear.json'))).mode & 0o777, 0o600);
  // A later refresh carries the stored secret.
  await identity.store.update((current) => ({ ...current, installation: { ...current.installation!, expiresAt: 0 } }));
  assert.equal(await identity.accessToken(file.installation!.id), 'new-access-sentinel');
  assert.deepEqual(fake.tokenRequests.at(-1), { grant: 'refresh_token', clientSecret: true, verifier: false });
  await identity.remove();
  assert.equal((await readFile(join(home, 'agents/scout/linear.json'), 'utf8')).includes(install.clientSecret!), false);
}));

for (const sent of ['missing', 'wrong'] as const) {
  test(`a code exchange Linear rejects as invalid_client (${sent} secret) fails the attempt, keeps nothing and reports only the code`, async () => withTempAnimaHome(async (home) => {
    await writeAgentConfigs(home, [{ id: 'scout' } as any]);
    const fake = new FakeLinear();
    if (sent === 'wrong') fake.clientSecret = 'the-apps-real-secret';
    const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
    const state = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
    // An attempt prepared before this field existed stays readable.
    if (sent === 'missing') await identity.store.update((file) => ({ ...file, pending: { ...file.pending!, clientSecret: undefined } }));
    await assert.rejects(identity.finish(state, 'synthetic-code', 'binding'), (error: Error) => {
      assert.match(error.message, /HTTP 400 invalid_client/); assert.match(error.message, /client secret/);
      assertNoPrivate(error.message); return true;
    });
    assert.deepEqual(fake.tokenRequests, [{ grant: 'authorization_code', clientSecret: sent === 'wrong', verifier: true }]);
    const file = await identity.store.read();
    assert.equal(file.installation, undefined); assert.equal(file.pending, undefined);
    assert.match(file.lastError!, /invalid_client/);
    assertNoPrivate(JSON.stringify(file));
    assertNoPrivate(await publicSurfaces(home, identity));
  }));
}

test('a legacy installation without a secret refreshes as before while Linear allows it', async () => withTempAnimaHome(async (home) => {
  const { identity, fake } = await seedLegacy(home);
  assert.equal((await identity.status()).clientSecretSaved, false);
  assert.equal(await identity.accessToken(install.id), 'new-access-sentinel');
  assert.deepEqual(fake.tokenRequests, [{ grant: 'refresh_token', clientSecret: false, verifier: false }]);
  const status = await identity.status();
  assert.equal(status.state, 'connected'); assert.equal(status.clientRejected, undefined);
}));

test('invalid_client on refresh keeps the grant and tokens until a working secret is added', async () => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(); fake.refreshRequiresSecret = true;
  const { identity, store, agentStore } = await seedLegacy(home, fake);
  const before = (await store.read()).installation!;
  await assert.rejects(identity.accessToken(install.id), (error: unknown) => {
    assert.ok(error instanceof LinearApiError); assert.equal(error.oauthError, 'invalid_client'); assert.equal(error.revoked, false);
    assertNoPrivate(error.message); return true;
  });
  await assert.rejects(identity.request('mutation{synthetic}', {}, z.unknown()));
  assert.equal(fake.calls.length, 0, 'No GraphQL write is attempted without a token');
  assert.equal(fake.tokenCalls, 2, 'One refresh per request, no automatic retry');
  const rejected = (await store.read()).installation!;
  assert.deepEqual(plain(rejected), plain({ ...before, clientRejected: true }));
  assert.equal((await agentStore.read()).linear?.connected, true);
  let status = await identity.status();
  assert.equal(status.state, 'connected'); assert.equal(status.clientRejected, true); assert.equal(status.clientSecretSaved, false);

  assert.equal(await identity.saveClientSecret(install.id, 'candidate-secret-sentinel'), 'rejected');
  assert.deepEqual(plain((await store.read()).installation), plain(rejected), 'A rejected secret changes nothing');
  assert.equal(await identity.saveClientSecret(install.id, install.clientSecret!), 'saved');
  const saved = (await store.read()).installation!;
  assert.deepEqual(plain(saved), plain({ ...before, clientSecret: install.clientSecret, accessToken: 'new-access-sentinel', refreshToken: 'new-refresh-sentinel', expiresAt: saved.expiresAt }));
  assert.ok(saved.expiresAt > Date.now() + 60_000);
  status = await identity.status();
  assert.equal(status.clientSecretSaved, true); assert.equal(status.clientRejected, undefined);
  // The fresh token is used without another refresh; the next refresh sends the secret.
  assert.equal(await identity.accessToken(install.id), 'new-access-sentinel');
  assert.equal(fake.tokenCalls, 4);
  await store.update((file) => ({ ...file, installation: { ...file.installation!, expiresAt: 0 } }));
  assert.equal(await identity.accessToken(install.id), 'new-access-sentinel');
  assert.deepEqual(fake.tokenRequests.at(-1), { grant: 'refresh_token', clientSecret: true, verifier: false });
  assertNoPrivate(await publicSurfaces(home, identity));
}));

// A token-endpoint answer that is not an explicit invalid_grant never clears credentials.
const unknownRefreshFailures = {
  server_error: (fake: FakeLinear) => { fake.refreshFailure = 'server_error'; },
  unreadable: (fake: FakeLinear) => { fake.refreshFailure = 'unreadable'; },
  network: (fake: FakeLinear) => { fake.refreshFailure = 'network'; },
  'unknown 401': (fake: FakeLinear) => wrapRefresh(fake, () => new Response('private-upstream-sentinel', { status: 401 })),
  'unlisted code': (fake: FakeLinear) => wrapRefresh(fake, () => new Response(JSON.stringify({ error: 'private-description-sentinel' }), { status: 400 })),
  invalid_request: (fake: FakeLinear) => wrapRefresh(fake, () => new Response(JSON.stringify({ error: 'invalid_request', error_description: 'private-description-sentinel' }), { status: 400 })),
  // A code is read only from a token rejection (400/401), never from a 5xx or other status.
  '503 invalid_grant': (fake: FakeLinear) => wrapRefresh(fake, () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private-description-sentinel' }), { status: 503 })),
  '500 invalid_grant': (fake: FakeLinear) => wrapRefresh(fake, () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 500 })),
  '403 invalid_grant': (fake: FakeLinear) => wrapRefresh(fake, () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 403 })),
  '503 invalid_client': (fake: FakeLinear) => wrapRefresh(fake, () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'private-description-sentinel' }), { status: 503 })),
};
function wrapRefresh(fake: FakeLinear, respond: () => Response) {
  const fetch = fake.fetch;
  fake.fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/token') && new URLSearchParams(init?.body as URLSearchParams).get('grant_type') === 'refresh_token') { fake.tokenCalls++; return respond(); }
    return fetch(url, init);
  };
}

for (const [failure, arrange] of Object.entries(unknownRefreshFailures)) {
  test(`refresh failure keeps the installation and tokens: ${failure}`, async () => withTempAnimaHome(async (home) => {
    const fake = new FakeLinear(); arrange(fake);
    const { identity, store, agentStore } = await seedLinear(home, fake);
    await store.update((file) => ({ ...file, installation: { ...file.installation!, expiresAt: 0 } }));
    const before = (await store.read()).installation!;
    await assert.rejects(identity.accessToken(install.id), (error: Error) => { assertNoPrivate(error.message); return true; });
    assert.deepEqual(plain((await store.read()).installation), plain(before));
    assert.equal((await agentStore.read()).linear?.connected, true);
    const status = await identity.status();
    assert.equal(status.state, 'connected'); assert.equal(status.clientRejected, undefined);
    assertNoPrivate(await publicSurfaces(home, identity));

    // The same answers to a save change nothing and never call the secret wrong.
    assert.equal(await identity.saveClientSecret(install.id, install.clientSecret!), failure === 'unreadable' ? 'unsaved' : 'unavailable');
    assert.deepEqual(plain((await store.read()).installation), plain(before));
    assert.equal(fake.tokenCalls, 2);
  }));
}

for (const [via, status] of [['refresh', 400], ['save', 400], ['refresh', 401], ['save', 401]] as const) {
  test(`only an explicit invalid_grant clears the credentials, including the client secret (${via}, HTTP ${status})`, async () => withTempAnimaHome(async (home) => {
    const fake = new FakeLinear();
    if (status === 400) fake.refreshFailure = 'invalid_grant';
    else wrapRefresh(fake, () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private-description-sentinel' }), { status }));
    const { identity, store, agentStore } = await seedLinear(home, fake);
    await store.update((file) => ({ ...file, installation: { ...file.installation!, expiresAt: 0 } }));
    if (via === 'refresh') await assert.rejects(identity.accessToken(install.id), /revoked/);
    else assert.equal(await identity.saveClientSecret(install.id, install.clientSecret!), 'expired');
    const after = (await store.read()).installation!;
    assert.equal(after.revoked, true); assert.equal(after.accessToken, ''); assert.equal(after.refreshToken, '');
    assert.equal(after.signingSecret, ''); assert.equal(after.clientSecret, undefined); assert.equal(after.clientRejected, undefined);
    assert.equal((await agentStore.read()).linear?.connected, false);
    assert.equal((await identity.status()).state, 'revoked');
    assertNoPrivate(await readFile(join(home, 'agents/scout/linear.json'), 'utf8'));
    assert.equal(fake.tokenCalls, 1);
  }));
}

// A write whose credential cannot be obtained never reaches Linear, so its intent
// is released: once the secret is added, an explicit retry sends it exactly once.
test('a response stopped by a rejected refresh is never sent and can be retried once the secret is added', async () => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(); fake.refreshRequiresSecret = true;
  const { identity, service, store } = await seedLinear(home, fake);
  await service.receive(created(), install);
  const queue = new WakeQueueService('scout'); const item = (await queue.list())[0]!;
  await service.markStarted(item, item.id); await queue.complete(item.id); await service.markSettled(item);
  await store.update((file) => ({ ...file, installation: { ...file.installation!, clientSecret: undefined, expiresAt: 0 } }));
  const mutation = 'agentActivityCreate';
  const sent = () => fake.calls.filter((call) => call.query.includes(mutation) && !call.variables.input?.ephemeral).length;
  const send = () => service.respond(sessionId, 'response', 'Synthetic complete', item.id);
  const before = sent();

  await assert.rejects(send(), (error: LinearApiError) => error.oauthError === 'invalid_client');
  assert.equal(sent(), before, 'nothing reached Linear');
  assert.deepEqual((await store.read()).operations, {}, 'the unsent intent is released');
  assert.equal((await identity.status()).clientRejected, true);

  assert.equal(await identity.saveClientSecret(install.id, install.clientSecret!), 'saved');
  await send();
  await send();
  assert.equal(sent(), before + 1, 'one explicit retry sends it once; the accepted write is not resent');
  assert.deepEqual(Object.values((await store.read()).operations).map((op) => op.state), ['accepted']);
  assert.equal(fake.posts.filter((p) => !p.ephemeral).length, 1);
}));

test('revocation and removal clear a stored client secret', async () => withTempAnimaHome(async (home) => {
  const { identity, store } = await seedLinear(home);
  await identity.revoke(install.id);
  assert.equal((await store.read()).installation?.clientSecret, undefined);
  assertNoPrivate(await readFile(join(home, 'agents/scout/linear.json'), 'utf8'));
  await store.update((file) => ({ ...file, installation: { ...install } }));
  await identity.remove();
  assertNoPrivate(await readFile(join(home, 'agents/scout/linear.json'), 'utf8'));
}));

test('saving a secret only fixes the current, non-revoked installation', async () => withTempAnimaHome(async (home) => {
  const { identity, store, fake } = await seedLegacy(home);
  assert.equal(await identity.saveClientSecret(randomUUID(), install.clientSecret!), 'changed');
  await store.update((file) => ({ ...file, installation: { ...file.installation!, revoked: true } }));
  assert.equal(await identity.saveClientSecret(install.id, install.clientSecret!), 'changed');
  await identity.remove();
  assert.equal(await identity.saveClientSecret(install.id, install.clientSecret!), 'changed');
  assert.equal(fake.tokenCalls, 0);
  assert.equal((await store.read()).installation, undefined);
}));

test('a save queued behind an automatic refresh uses the rotated refresh token', async () => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(), fetch = fake.fetch, sent: string[] = [];
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  fake.fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) { sent.push(new URLSearchParams(init?.body as URLSearchParams).get('refresh_token')!); entered(); }
    return fetch(url, init);
  };
  const { identity, store } = await seedLegacy(home, fake);
  let release!: () => void; fake.tokenGate = new Promise<void>((resolve) => { release = resolve; });
  // A separate service instance models another process sharing this home.
  const refresh = new LinearIdentityService('scout', new LinearClient(fake.fetch)).accessToken(install.id);
  await started;
  const save = identity.saveClientSecret(install.id, install.clientSecret!);
  await settle(); release();
  assert.equal(await refresh, 'new-access-sentinel');
  assert.equal(await save, 'saved');
  assert.deepEqual(sent, [install.refreshToken, 'new-refresh-sentinel']);
  assert.equal((await store.read()).installation?.clientSecret, install.clientSecret);
}));

test('a removal queued behind a save still removes the installation and its secret', async () => withTempAnimaHome(async (home) => {
  const { identity, store, fake } = await seedLegacy(home);
  let release!: () => void; fake.tokenGate = new Promise<void>((resolve) => { release = resolve; });
  const save = identity.saveClientSecret(install.id, install.clientSecret!);
  while (fake.tokenCalls === 0) await settle();
  const removal = new LinearIdentityService('scout', new LinearClient(fake.fetch)).remove();
  await settle(); release();
  assert.equal(await save, 'saved'); await removal;
  assert.equal((await store.read()).installation, undefined);
  assertNoPrivate(await readFile(join(home, 'agents/scout/linear.json'), 'utf8'));
}));

test('a save waiting on the lock never writes into a replacement installation', async (t) => withTempAnimaHome(async (home) => {
  const { identity, store, fake } = await seedLegacy(home);
  const update = store.update.bind(store);
  let queued!: () => void; const waiting = new Promise<void>((resolve) => { queued = resolve; });
  t.mock.method(store, 'update', (op: Parameters<typeof update>[0]) => { queued(); return update(op); });
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const replacement = { ...install, id: randomUUID(), clientSecret: undefined, accessToken: 'replacement-access', refreshToken: 'replacement-refresh' };
  const replace = update(async (file) => { await held; return { ...file, installation: replacement }; });
  const save = identity.saveClientSecret(install.id, install.clientSecret!);
  await waiting; await settle(); release(); await replace;
  assert.equal(await save, 'changed');
  assert.deepEqual(plain((await store.read()).installation), plain(replacement));
  assert.equal(fake.tokenCalls, 0);
}));

test('a refresh that succeeds remotely but cannot be stored is reported unsaved and changes nothing', async (t) => withTempAnimaHome(async (home) => {
  const { identity, store, fake } = await seedLegacy(home);
  const before = (await store.read()).installation!;
  const update = store.update.bind(store);
  const failing = t.mock.method(store, 'update', (op: Parameters<typeof update>[0]) => update(async (file) => { await op(file); throw new Error('synthetic-disk-full'); }));
  assert.equal(await identity.saveClientSecret(install.id, install.clientSecret!), 'unsaved');
  failing.mock.restore();
  assert.equal(fake.tokenCalls, 1);
  assert.deepEqual(plain((await store.read()).installation), plain(before));
}));

test('the client secret route is an authenticated same-origin write bound to the installation', async (t) => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(); fake.refreshRequiresSecret = true;
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const { store } = await seedLegacy(home, fake, false);
  await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
  const app = buildWebApp();
  const url = '/api/agents/scout/linear/client-secret';
  const payload = { installationId: install.id, clientSecret: install.clientSecret! };
  try {
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'synthetic-dashboard-password' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    for (const headers of [{ cookie, 'sec-fetch-site': 'cross-site' }, { cookie, 'sec-fetch-site': 'same-site' }, { cookie, host: 'localhost', origin: 'https://evil.example' }]) {
      assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 403);
    }
    // Only the secret can be supplied; never another client, workspace or token.
    for (const extra of [{ clientId: 'b123456789012345678901234567890c5' }, { workspaceName: 'Other' }, { accessToken: 'x' }, { refreshToken: 'x' }]) {
      assert.equal((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { ...payload, ...extra } })).statusCode, 400);
    }
    for (const clientSecret of ['short', 'has a space inside', '']) {
      assert.equal((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { ...payload, clientSecret } })).statusCode, 400);
    }
    assert.equal(fake.tokenCalls, 0);
    const other = await app.inject({ method: 'POST', url, headers: { cookie }, payload: { ...payload, installationId: randomUUID() } });
    assert.deepEqual(other.json(), { result: 'changed' });
    const saved = await app.inject({ method: 'POST', url, headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload });
    assert.equal(saved.statusCode, 200); assert.equal(saved.headers['cache-control'], 'no-store');
    assert.deepEqual(saved.json(), { result: 'saved' });
    assert.equal((await store.read()).installation?.clientSecret, install.clientSecret);
    const status = await app.inject({ url: '/api/agents/scout/linear', headers: { cookie } });
    assert.equal(status.json().clientSecretSaved, true);
    assertNoPrivate(saved.body + other.body + status.body);
    assert.deepEqual(fake.tokenRequests, [{ grant: 'refresh_token', clientSecret: true, verifier: false }]);
  } finally { await app.close(); }
}));

test('GraphQL error messages stay on the error for the agent, never in its message or serialized form', async () => {
  const answer = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const errors = [{ message: 'private-upstream-sentinel: Cannot query field "titel"' }, { message: 'second' }, { nope: true }];
  for (const [status, body] of [[200, { data: null, errors }], [200, { errors }], [400, { errors }]] as const) {
    const error = await new LinearClient(answer(status, body)).graphql('token', '{ x }', {}, z.unknown()).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof LinearApiError);
    assert.deepEqual(error.graphqlErrors, ['private-upstream-sentinel: Cannot query field "titel"', 'second']);
    assertNoPrivate(error.message);
    assertNoPrivate(JSON.stringify(error));
    assert.equal(error.failure, status === 200 ? 'response' : 'http');
  }
  // A failure without GraphQL errors carries none.
  const plainFailure = await new LinearClient(answer(500, { errors })).graphql('token', '{ x }', {}, z.unknown()).then(() => undefined, (caught: unknown) => caught);
  assert.ok(plainFailure instanceof LinearApiError);
  assert.equal(plainFailure.graphqlErrors, undefined);
});
