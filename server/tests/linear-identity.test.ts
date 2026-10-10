import test from 'node:test';
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

const request = { clientId: install.clientId, signingSecret: install.signingSecret, callbackUrl: 'http://localhost:14174/api/linear/oauth/callback', listener: { host: '127.0.0.1', port: 14175 } };

test('Linear dashboard OAuth uses app actor, single-use PKCE state and private atomic credentials', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [{ id: 'scout' } as any]);
  const fake = new FakeLinear();
  const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
  const before = await identity.status(); assert.equal(before.state, 'not_configured');
  const auth = new URL((await identity.begin(request, 'session-binding')).authorizationUrl);
  assert.equal(auth.searchParams.get('actor'), 'app'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.match(auth.searchParams.get('scope')!, /app:assignable/);
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

test('callback state expiry and dashboard/webhook port validation reject before token exchange', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [{ id: 'scout' }] as any);
  const fake = new FakeLinear(); const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
  await assert.rejects(identity.begin({ ...request, listener: { host: '127.0.0.1', port: 4174 } }, 'binding'));
  await assert.rejects(identity.begin({ ...request, callbackUrl: 'http://example.com/api/linear/oauth/callback' }, 'binding'));
  const pending = new URL((await identity.begin(request, 'binding')).authorizationUrl).searchParams.get('state')!;
  await new LinearStore('scout').update((f) => ({ ...f, pending: { ...f.pending!, expiresAt: 0 } }));
  await assert.rejects(identity.finish(pending, 'code', 'binding')); assert.equal(fake.tokenCalls, 0);
}));
