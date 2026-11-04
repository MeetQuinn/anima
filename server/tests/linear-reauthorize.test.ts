import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LINEAR_OAUTH_SCOPES } from '../../shared/linear.js';
import { LinearClient } from '../linear/client.js';
import { buildWebApp } from '../web/app.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { FakeLinear, created, install, seedLinear, sessionId } from './helpers/linear.js';

const callback = 'https://agents.example.com/api/linear/oauth/callback';
const plain = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function fakeGrant(scope: string | string[] | undefined = LINEAR_OAUTH_SCOPES.join(' '), mismatch?: 'app' | 'user' | 'org') {
  const fake = new FakeLinear();
  const fetch = fake.fetch;
  fake.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!response.ok) return response;
    const body = await response.json();
    if (String(url).endsWith('/oauth/token')) body.scope = scope;
    else if (body.data?.viewer) {
      if (mismatch === 'app') body.data.applicationInfo.clientId = 'another-app';
      if (mismatch === 'user') body.data.viewer.id = randomUUID();
      if (mismatch === 'org') body.data.organization.id = randomUUID();
    }
    return Response.json(body);
  };
  return fake;
}
async function seedWork(home: string, fake = fakeGrant()) {
  const seeded = await seedLinear(home, fake);
  await seeded.service.receive(created(), install);
  const queue = new WakeQueueService('scout');
  const item = (await queue.list())[0]!;
  await seeded.service.markStarted(item, item.id); await queue.complete(item.id); await seeded.service.markSettled(item);
  await seeded.store.update((file) => ({ ...file,
    installation: { ...file.installation!, uploadedFiles: { hash: 'https://uploads.linear.app/synthetic-file' } },
    operations: { prior: { id: 'prior', sessionId: randomUUID(), kind: 'activity', state: 'accepted', itemIds: [], contentHash: 'prior-hash' } },
    sessionStarts: { prior: { target: 'issue', targetId: randomUUID(), rootId: randomUUID(), createdAt: new Date().toISOString(), sessionId: randomUUID() } },
    lastSignedWebhookAt: new Date().toISOString(),
  }));
  return { ...seeded, item };
}
async function start(identity: Awaited<ReturnType<typeof seedLinear>>['identity']) {
  return new URL((await identity.reauthorize({ installationId: install.id }, callback, 'binding')).authorizationUrl).searchParams.get('state')!;
}

test('reauthorization preserves installation identity and work, and an existing receipt can still be answered exactly once', async () => withTempAnimaHome(async (home) => {
  const { identity, store, agentStore, service, fake, item } = await seedWork(home);
  const before = await store.read(); const config = await agentStore.read();
  assert.equal((await identity.status()).needsReauthorization, true);
  const url = new URL((await identity.reauthorize({ installationId: install.id }, callback, 'binding')).authorizationUrl);
  assert.equal(url.searchParams.get('client_id'), install.clientId);
  assert.equal(url.searchParams.get('actor'), 'app'); assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('scope'), LINEAR_OAUTH_SCOPES.join(','));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await identity.status()).state, 'connected'); assert.equal((await identity.status()).reauthorizing, true);
  assert.deepEqual((await store.read()).installation, before.installation);
  assert.equal(await identity.accessToken(install.id), install.accessToken);
  await identity.finish(url.searchParams.get('state')!, 'synthetic-code', 'binding');
  const after = await store.read();
  assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.operations, before.operations);
  assert.deepEqual(after.sessionStarts, before.sessionStarts); assert.equal(after.lastSignedWebhookAt, before.lastSignedWebhookAt);
  assert.deepEqual(plain(after.installation), plain({ ...before.installation,
    accessToken: 'new-access-sentinel', refreshToken: 'new-refresh-sentinel', expiresAt: after.installation!.expiresAt,
    grantedScopes: [...LINEAR_OAUTH_SCOPES],
  }));
  assert.deepEqual(await agentStore.read(), config);
  assert.equal((await identity.status()).needsReauthorization, false); assert.equal((await identity.status()).reauthorizing, false);
  assert.equal(await identity.accessToken(install.id), 'new-access-sentinel');
  const sent = () => fake.posts.filter((post) => !post.ephemeral).length;
  const count = sent();
  await service.respond(sessionId, 'response', 'Synthetic complete', item.id);
  await service.respond(sessionId, 'response', 'Synthetic complete', item.id);
  assert.equal(sent(), count + 1);
  const publicData = JSON.stringify(await identity.status()) + await readFile(join(home, 'agents/scout/config.json'), 'utf8');
  for (const secret of [install.clientSecret!, install.signingSecret, 'new-access-sentinel', 'new-refresh-sentinel', 'synthetic-code']) assert.ok(!publicData.includes(secret));
}));

for (const mismatch of ['app', 'org', 'user'] as const) test(`reauthorization rejects a different ${mismatch} and leaves the current installation and work untouched`, async () => withTempAnimaHome(async (home) => {
  const { identity, store, agentStore } = await seedWork(home, fakeGrant(undefined, mismatch));
  const before = await store.read(); const config = await agentStore.read();
  await assert.rejects(identity.finish(await start(identity), 'code', 'binding'), /identity could not be verified/);
  const after = await store.read();
  assert.deepEqual(plain(after.installation), plain(before.installation));
  assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.operations, before.operations); assert.deepEqual(after.sessionStarts, before.sessionStarts);
  assert.deepEqual(await agentStore.read(), config);
  assert.equal(await identity.accessToken(install.id), install.accessToken); assert.equal((await identity.status()).state, 'connected');
  assert.equal(after.pending, undefined);
}));

for (const outcome of ['expired', 'abandoned', 'declined', 'wrong-binding', 'exchange-failed'] as const) test(`reauthorization ${outcome} keeps the old connection usable`, async () => withTempAnimaHome(async (home) => {
  const { identity, store, fake, agentStore } = await seedWork(home);
  const before = await store.read(); const config = await agentStore.read();
  const state = await start(identity);
  if (outcome === 'expired') {
    await store.update((f) => ({ ...f, pending: { ...f.pending!, expiresAt: 1 } }));
    await assert.rejects(identity.finish(state, 'code', 'binding'));
    assert.doesNotMatch((await identity.status()).lastError!, /remove/i);
  } else if (outcome === 'declined') assert.equal(await identity.finish(state, undefined, 'binding'), 'declined');
  else if (outcome === 'wrong-binding') await assert.rejects(identity.finish(state, 'code', 'other-binding'));
  else if (outcome === 'exchange-failed') {
    fake.clientSecret = 'different-secret';
    await assert.rejects(identity.finish(state, 'code', 'binding'));
  }
  const after = await store.read();
  assert.deepEqual(plain(after.installation), plain(before.installation)); assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual(after.operations, before.operations); assert.deepEqual(after.sessionStarts, before.sessionStarts);
  assert.deepEqual(await agentStore.read(), config);
  assert.equal(await identity.accessToken(install.id), install.accessToken);
  assert.equal((await identity.status()).state, 'connected');
  assert.equal(fake.tokenCalls, outcome === 'exchange-failed' ? 1 : 0);
}));

test('only a legacy connection asks for a secret; candidates are saved only after successful authorization', async () => withTempAnimaHome(async (home) => {
  const { identity, store } = await seedLinear(home, fakeGrant());
  await store.update((f) => ({ ...f, installation: { ...f.installation!, clientSecret: undefined } }));
  await assert.rejects(start(identity), /Client secret/);
  assert.equal((await store.read()).pending, undefined);
  const begin = () => identity.reauthorize({ installationId: install.id, clientSecret: install.clientSecret! }, callback, 'binding');
  let state = new URL((await begin()).authorizationUrl).searchParams.get('state')!;
  assert.equal((await store.read()).installation!.clientSecret, undefined);
  await identity.finish(state, undefined, 'binding');
  assert.equal((await store.read()).installation!.clientSecret, undefined);
  state = new URL((await begin()).authorizationUrl).searchParams.get('state')!;
  await identity.finish(state, 'code', 'binding');
  assert.equal((await store.read()).installation!.clientSecret, install.clientSecret);
  // A caller cannot overwrite a saved secret through this operation.
  await identity.reauthorize({ installationId: install.id, clientSecret: 'untrusted-other-secret' }, callback, 'binding');
  assert.equal((await store.read()).pending!.clientSecret, install.clientSecret);
}));

for (const change of ['remove', 'revoke', 'replace', 'new-attempt', 'concurrent-work'] as const) test(`a delayed reauthorization respects ${change}`, async () => withTempAnimaHome(async (home) => {
  const { identity, store, fake } = await seedWork(home);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const fetch = fake.fetch;
  identity.client.token = async (form) => { entered(); await gate; return new LinearClient(fetch).token(form); };
  const state = await start(identity);
  const finishing = identity.finish(state, 'code', 'binding');
  const result = change === 'concurrent-work' ? finishing : assert.rejects(finishing);
  await started;
  if (change === 'remove') await identity.remove();
  if (change === 'revoke') await identity.revoke(install.id);
  if (change === 'replace') await store.update((f) => ({ ...f, installation: { ...f.installation!, id: randomUUID() } }));
  if (change === 'new-attempt') await start(identity);
  if (change === 'concurrent-work') await store.update((f) => ({ ...f, installation: { ...f.installation!, uploadedFiles: { later: 'https://uploads.linear.app/later' } },
    operations: { ...f.operations, later: { ...f.operations.prior!, id: 'later' } } }));
  const before = await store.read(); release(); await result;
  const after = await store.read();
  if (change === 'concurrent-work') {
    assert.deepEqual(after.installation!.uploadedFiles, before.installation!.uploadedFiles);
    assert.deepEqual(after.operations, before.operations);
  } else {
    assert.deepEqual(plain(after.installation), plain(before.installation));
    if (change === 'new-attempt') assert.equal(after.pending!.id, before.pending!.id);
  }
}));

for (const scope of [undefined, 'read write', [...LINEAR_OAUTH_SCOPES], LINEAR_OAUTH_SCOPES.join(' ')]) test(`records actual scope response: ${JSON.stringify(scope)}`, async () => withTempAnimaHome(async (home) => {
  const fake = fakeGrant(scope);
  // Explicitly omit the response field for old/unknown grants.
  if (scope === undefined) {
    const fetch = fake.fetch;
    fake.fetch = async (url, init) => { const res = await fetch(url, init); const body = await res.json(); delete body.scope; return Response.json(body); };
  }
  const { identity, store } = await seedLinear(home, fake);
  await identity.finish(await start(identity), 'code', 'binding');
  const expected = typeof scope === 'string' ? scope.split(' ') : scope;
  assert.deepEqual((await store.read()).installation!.grantedScopes, expected);
  assert.equal((await identity.status()).needsReauthorization, scope === undefined || scope === 'read write');
  await store.update((f) => ({ ...f, installation: { ...f.installation!, expiresAt: 0 } }));
  await identity.accessToken(install.id);
  assert.deepEqual((await store.read()).installation!.grantedScopes, expected);
}));

test('reauthorize route is authenticated, same-origin, installation-bound and derives URLs server-side', async (t) => withTempAnimaHome(async (home) => {
  const fake = fakeGrant(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { store } = await seedLinear(home, fake);
  await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
  const app = buildWebApp(); const url = '/api/agents/scout/linear/reauthorize'; const payload = { installationId: install.id };
  try {
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'synthetic-dashboard-password' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    for (const headers of [{ cookie, 'sec-fetch-site': 'cross-site' }, { cookie, host: 'localhost', origin: 'https://evil.example' }])
      assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 403);
    for (const extra of [{ clientId: 'other' }, { callbackUrl: callback }, { returnUrl: 'https://evil.example' }, { signingSecret: 'other' }])
      assert.equal((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { ...payload, ...extra } })).statusCode, 400);
    const stale = await app.inject({ method: 'POST', url, headers: { cookie }, payload: { installationId: randomUUID() } });
    assert.equal(stale.statusCode, 500); assert.equal((await store.read()).pending, undefined);
    const before = (await store.read()).installation;
    const prepared = await app.inject({ method: 'POST', url, headers: { cookie }, payload });
    assert.equal(prepared.statusCode, 200); assert.equal(prepared.headers['cache-control'], 'no-store');
    const auth = new URL(prepared.json().authorizationUrl);
    assert.equal(auth.searchParams.get('redirect_uri'), callback);
    assert.equal((await store.read()).pending!.returnUrl, 'http://localhost/api/linear/oauth/complete');
    assert.deepEqual((await store.read()).installation, before);
    const complete = await app.inject({ url: `/api/linear/oauth/complete?state=${auth.searchParams.get('state')}&code=synthetic-code`, headers: { cookie } });
    assert.equal(complete.statusCode, 200); assert.match(complete.body, /linear=connected/);
    assert.equal((await store.read()).installation!.id, install.id);
    const status = await app.inject({ url: '/api/agents/scout/linear', headers: { cookie } });
    for (const value of [install.clientSecret!, install.signingSecret, 'new-access-sentinel', 'new-refresh-sentinel']) assert.ok(!(prepared.body + status.body + complete.body).includes(value));
  } finally { await app.close(); }
}));


test('a token refresh retains recorded scopes when omitted and updates them when Linear returns a narrower grant', async () => withTempAnimaHome(async (home) => {
  const { identity, store } = await seedLinear(home, fakeGrant());
  await identity.finish(await start(identity), 'code', 'binding');
  const original = identity.client.token.bind(identity.client);
  identity.client.token = async (form) => { const tokens = await original(form); delete tokens.scope; return tokens; };
  await store.update((f) => ({ ...f, installation: { ...f.installation!, expiresAt: 0 } }));
  await identity.accessToken(install.id);
  assert.equal((await identity.status()).needsReauthorization, false);
  identity.client.token = async (form) => ({ ...await original(form), scope: ['read'] });
  await store.update((f) => ({ ...f, installation: { ...f.installation!, expiresAt: 0 } }));
  await identity.accessToken(install.id);
  assert.deepEqual((await store.read()).installation!.grantedScopes, ['read']);
  assert.equal((await identity.status()).needsReauthorization, true);
}));

test('a storage failure after verification leaves the original installation and work intact', async (t) => withTempAnimaHome(async (home) => {
  const { identity, store } = await seedWork(home);
  const before = await store.read(); const state = await start(identity);
  const update = store.update.bind(store);
  t.mock.method(store, 'update', (operation: Parameters<typeof store.update>[0]) => update(async (file) => {
    const next = await operation(file);
    if (next.installation?.accessToken === 'new-access-sentinel') throw new Error('private-storage-failure');
    return next;
  }));
  await assert.rejects(identity.finish(state, 'code', 'binding'), /verification or storage failed/);
  const after = await store.read();
  assert.deepEqual(after.installation, before.installation); assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual(after.operations, before.operations); assert.deepEqual(after.sessionStarts, before.sessionStarts);
  assert.equal(await identity.accessToken(install.id), install.accessToken);
  assert.ok(!JSON.stringify(await identity.status()).includes('private-storage-failure'));
}));
