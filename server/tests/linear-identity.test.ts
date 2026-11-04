import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearClient } from '../linear/client.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { isAgentRunnable, redactAgentConfig } from '../agents/agent-config-ops.js';
import { LinearStore } from '../storage/schema/linear.store.js';
import { withTempAnimaHome, writeAgentConfigs } from './helpers/harness.js';
import { FakeLinear, install, seedLinear } from './helpers/linear.js';

const request = { clientId: install.clientId, clientSecret: install.clientSecret!, signingSecret: install.signingSecret, callbackUrl: 'http://localhost:14174/api/linear/oauth/callback' };

test('Linear dashboard OAuth uses app actor, single-use PKCE state and private atomic credentials', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [{ id: 'scout' } as any]);
  const fake = new FakeLinear();
  const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
  const before = await identity.status(); assert.equal(before.state, 'not_configured');
  const auth = new URL((await identity.begin(request, 'session-binding')).authorizationUrl);
  assert.equal(auth.searchParams.get('actor'), 'app'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(new Set(auth.searchParams.get('scope')!.split(',')),
    new Set(['read', 'write', 'app:assignable', 'app:mentionable', 'customer:write', 'initiative:write', 'timeSchedule:write']));
  const state = auth.searchParams.get('state')!;
  await assert.rejects(identity.finish(state, 'synthetic-code', 'wrong-session')); assert.equal(fake.tokenCalls, 0);
  let release!: () => void; fake.tokenGate = new Promise<void>((r) => { release = r; });
  const finish = identity.finish(state, 'synthetic-code', 'session-binding');
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(identity.finish(state, 'synthetic-code', 'session-binding'));
  release(); await finish;
  assert.equal(fake.tokenCalls, 1); assert.equal((await identity.status()).state, 'connected');
  const config = await new AgentStore('scout').read(); assert.equal(isAgentRunnable(config), true);
  const publicData = JSON.stringify([await identity.status(), redactAgentConfig(config), config.provider.env]);
  for (const secret of [install.signingSecret, 'new-access-sentinel', 'new-refresh-sentinel', 'synthetic-code']) assert.equal(publicData.includes(secret), false);
  assert.equal((await stat(join(home, 'agents/scout/linear.json'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(home, 'agents/scout/config.json'), 'utf8')).includes(install.signingSecret), false);
  assert.equal((await identity.status()).workspaceName, 'Synthetic workspace');
  await identity.remove(); await assert.rejects(identity.accessToken((await identity.store.read()).installation?.id ?? install.id));
  assert.equal((await identity.status()).state, 'not_configured');
}));

test('parallel agents cannot reserve the same app, removal defeats a late OAuth completion', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [{ id: 'scout' }, { id: 'other' }] as any);
  const fake = new FakeLinear(); const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
  const attempts = await Promise.allSettled([identity.begin(request, 'binding'), new LinearIdentityService('other').begin(request, 'other')]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  const pending = (await identity.store.read()).pending;
  assert.ok(pending);
  let release!: () => void; fake.tokenGate = new Promise<void>((r) => { release = r; });
  const finish = identity.finish(pending.id, 'synthetic-code', 'binding');
  await new Promise((r) => setTimeout(r, 30)); await identity.remove(); release();
  await assert.rejects(finish); assert.equal((await identity.store.read()).installation, undefined);
  assert.equal((await new AgentStore('scout').read()).linear, undefined);
}));

test('Linear refresh is serialized and revocation blocks stale credentials without leaking errors', async () => withTempAnimaHome(async (home) => {
  const { identity, fake, store } = await seedLinear(home);
  await store.update((file) => ({ ...file, installation: { ...file.installation!, expiresAt: 0 } }));
  assert.deepEqual(await Promise.all([identity.accessToken(install.id), identity.accessToken(install.id)]), ['new-access-sentinel', 'new-access-sentinel']);
  assert.equal(fake.tokenCalls, 1); assert.equal((await store.read()).installation?.refreshToken, 'new-refresh-sentinel');
  fake.quotaUnauthorized = true;
  await assert.rejects(identity.graphql(install.id, 'query { viewer { id } }', {}, { parse: (v: unknown) => v } as any));
  assert.equal((await identity.status()).state, 'revoked');
  assert.equal((await new AgentStore('scout').read()).linear?.connected, false);
  assert.equal((await store.read()).installation?.accessToken, '');
  await assert.rejects(identity.accessToken(install.id));
  assert.equal(JSON.stringify(await identity.status()).includes('sentinel'), false);
}));

test('callback state expiry and request validation reject before token exchange', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [{ id: 'scout' }] as any);
  const fake = new FakeLinear(); const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
  // The receiver address is not part of an install; the dashboard forwards to it.
  await assert.rejects(identity.begin({ ...request, listener: { host: '127.0.0.1', port: 14175 } } as never, 'binding'));
  await assert.rejects(identity.begin({ ...request, callbackUrl: 'http://example.com/api/linear/oauth/callback' }, 'binding'));
  const pending = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
  await new LinearStore('scout').update((f) => ({ ...f, pending: { ...f.pending!, expiresAt: 0 } }));
  await assert.rejects(identity.finish(pending, 'code', 'binding')); assert.equal(fake.tokenCalls, 0);
}));


for (const operation of ['query', 'mutation'] as const) for (const change of ['refresh', 'reinstall', 'none'] as const) {
  test(`a delayed Linear 401 is scoped to its credential: ${operation}, ${change}`, async () => withTempAnimaHome(async (home) => {
    const fake = new FakeLinear(), fetch = fake.fetch;
    let release!: () => void, entered!: () => void;
    const responseGate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let requests = 0;
    fake.fetch = async (url, init) => {
      if (String(url).endsWith('/graphql')) {
        requests++;
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${install.accessToken}`);
        entered(); await responseGate;
        return new Response('{}', { status: 401 });
      }
      return fetch(url, init);
    };
    const { identity, store, agentStore } = await seedLinear(home, fake);
    const pending = identity.request(`${operation}{synthetic}`, {}, z.unknown());
    const rejected = assert.rejects(pending, /Linear request was unauthorized/);
    try {
      await started;
      if (change === 'refresh') {
        await store.update((file) => ({ ...file, installation: { ...file.installation!, expiresAt: 0 } }));
        // Separate service/store instance models another process sharing this home.
        const fresh = new LinearIdentityService('scout', new LinearClient(fake.fetch));
        const credentials = await fresh.credentials();
        assert.equal(credentials.accessToken, 'new-access-sentinel');
      } else if (change === 'reinstall') {
        await identity.remove();
        await store.update((file) => ({ ...file, installation: { ...install, id: randomUUID() } }));
        await agentStore.update((agent) => ({ ...agent, linear: { connected: true, clientId: install.clientId,
          organizationId: install.organizationId, appUserId: install.appUserId } }));
      }
      const before = (await store.read()).installation!;
      release(); await rejected;
      const after = (await store.read()).installation!;
      assert.equal(requests, 1, 'A rejected request, including a mutation, must not be automatically replayed');
      if (change === 'none') {
        assert.equal(after.revoked, true); assert.equal(after.accessToken, '');
        assert.equal(after.refreshToken, ''); assert.equal(after.signingSecret, '');
        assert.equal((await agentStore.read()).linear!.connected, false);
      } else {
        assert.deepEqual(after, before);
        assert.equal((await agentStore.read()).linear!.connected, true);
        assert.equal((await identity.status()).state, 'connected');
        // A real revocation notification still closes the current installation.
        await identity.revoke(after.id);
        assert.equal((await store.read()).installation!.revoked, true);
        assert.equal((await agentStore.read()).linear!.connected, false);
      }
    } finally { release(); await rejected; }
  }));
}


test('a refresh that wins the revocation lock keeps the Linear connection', async (t) => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(), fetch = fake.fetch;
  let block = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  fake.fetch = async (url, init) => {
    if (String(url).endsWith('/graphql')) { block = true; return new Response('{}', { status: 401 }); }
    return fetch(url, init);
  };
  const { identity, store, agentStore } = await seedLinear(home, fake);
  const update = store.update.bind(store);
  t.mock.method(store, 'update', async (change: Parameters<typeof update>[0]) => {
    if (block) { entered(); await gate; }
    return update(change);
  });
  const rejected = assert.rejects(identity.request('query{synthetic}', {}, z.unknown()), /Linear request was unauthorized/);
  try {
    await started;
    const independent = new LinearIdentityService('scout', new LinearClient(fake.fetch));
    await independent.store.update((file) => ({ ...file, installation: { ...file.installation!, expiresAt: 0 } }));
    await independent.credentials();
    release(); await rejected;
    assert.equal((await store.read()).installation!.accessToken, 'new-access-sentinel');
    assert.equal((await store.read()).installation!.revoked, false);
    assert.equal((await agentStore.read()).linear!.connected, true);
  } finally { release(); await rejected; }
}));

for (const stage of ['token', 'identity'] as const) {
  test(`failed OAuth ${stage} clears only its own consumed attempt and retains a safe retry explanation`, async () => withTempAnimaHome(async (home) => {
    await writeAgentConfigs(home, [{ id: 'scout' }] as any);
    let fail = true;
    const fake = new FakeLinear();
    const client = new LinearClient(async (url, init) => {
      if (fail && String(url).endsWith(stage === 'token' ? '/token' : '/graphql')) throw new Error('secret-error-sentinel');
      return fake.fetch(url, init);
    });
    const identity = new LinearIdentityService('scout', client);
    const state = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
    await assert.rejects(identity.finish(state, 'code', 'binding'), /prepare authorization again/i);
    const status = await identity.status();
    assert.equal(status.state, 'not_configured'); assert.ok(status.lastError);
    assert.doesNotMatch(JSON.stringify(status), /sentinel/);
    assert.equal((await identity.store.read()).pending, undefined);
    fail = false;
    const retry = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
    assert.notEqual(retry, state);
    await identity.finish(retry, 'new-code', 'binding');
    assert.equal((await identity.status()).state, 'connected');
  }));
}

test('late failed exchange cannot clear a newer authorization and denial does not call Linear', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [{ id: 'scout' }] as any);
  let reject!: (reason: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const identity = new LinearIdentityService('scout', new LinearClient(async () => {
    entered(); return new Promise<Response>((_resolve, rejecter) => { reject = rejecter; });
  }));
  const first = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
  const failed = assert.rejects(identity.finish(first, 'code', 'binding'));
  await started;
  const second = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
  reject(new Error('secret')); await failed;
  assert.equal((await identity.store.read()).pending!.id, second);
  await assert.rejects(identity.finish(second, undefined, 'wrong-binding'));
  assert.equal((await identity.store.read()).pending!.id, second);
  await identity.finish(second, undefined, 'binding');
  assert.equal((await identity.store.read()).pending, undefined);
  assert.match((await identity.status()).lastError!, /declined/);
}));

for (const endpoint of ['token', 'identity'] as const) for (const failure of ['network', '400', '503', 'response'] as const) {
  test(`OAuth diagnostic keeps only safe failure category: ${endpoint}/${failure}`, async () => withTempAnimaHome(async (home) => {
    await writeAgentConfigs(home, [{ id: 'scout' }] as any);
    const fake = new FakeLinear();
    let calls = 0;
    const identity = new LinearIdentityService('scout', new LinearClient(async (url, init) => {
      const targeted = endpoint === 'token' ? String(url).endsWith('/token') : String(url).endsWith('/graphql');
      if (!targeted) return fake.fetch(url, init);
      calls++;
      if (failure === 'network') throw new Error('synthetic-private-error-sentinel');
      return new Response('synthetic-private-response-sentinel', { status: failure === 'response' ? 200 : Number(failure) });
    }));
    const state = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
    const expected = failure === 'network' ? 'connection failed' : failure === 'response' ? 'invalid or rejected response' : `HTTP ${failure}`;
    await assert.rejects(identity.finish(state, 'secret-code', 'binding'), (error: Error) => {
      assert.ok(error.message.includes(expected)); assert.ok(!error.message.includes('sentinel')); return true;
    });
    const file = await identity.store.read();
    assert.equal(file.pending, undefined); assert.equal(file.installation, undefined);
    assert.ok(file.lastError!.includes(expected)); assert.ok(!JSON.stringify(file).includes('sentinel'));
    assert.equal(calls, 1, 'No automatic exchange replay');
  }));
}

for (const [reported, stored] of [['  Scout\n  app ', 'Scout app'], [undefined, undefined], ['x'.repeat(300), undefined]] as const) {
  test(`installation records the app user's Linear name when usable: ${JSON.stringify(reported?.slice(0, 12))}`, async () => withTempAnimaHome(async (home) => {
    await writeAgentConfigs(home, [{ id: 'scout' } as any]);
    const fake = new FakeLinear(); fake.appName = reported;
    const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
    const state = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
    await identity.finish(state, 'synthetic-code', 'binding');
    assert.equal((await identity.status()).state, 'connected', 'A missing or unusable name never blocks the installation');
    assert.match(fake.calls[0]!.query, /viewer \{ id app name \}/);
    assert.equal((await identity.store.read()).installation!.appName, stored);
  }));
}
