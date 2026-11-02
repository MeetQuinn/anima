import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LinearSetupRequest, linearAppCreationUrl, defaultLinearAppName } from '../../shared/linear-setup.js';
import { LinearSetupService } from '../linear/setup.service.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { buildWebApp } from '../web/app.js';
import { withTempAnimaHome, writeAgentConfigs, defaultAgentConfig } from './helpers/harness.js';
import { FakeLinear, install } from './helpers/linear.js';
import { LinearClient } from '../linear/client.js';

const setup = { webhookUrl: 'https://agents.example.com/webhook', listener: { host: '127.0.0.1', port: 14185 } };
const callbackUrl = 'http://localhost:14174/api/linear/oauth/callback';

test('manifest prefills a private agent app, callback and all three wake event subscriptions without secrets', () => {
  const url = new URL(linearAppCreationUrl({ name: 'Milo 中文 & "Review"', callbackUrl, webhookUrl: setup.webhookUrl }));
  assert.equal(url.origin + url.pathname, 'https://linear.app/settings/api/applications/new');
  const manifest = JSON.parse(url.searchParams.get('manifest')!);
  assert.equal(manifest.oauth.client_name, 'Milo 中文 & "Review"');
  assert.deepEqual(manifest.oauth.redirect_uris, [callbackUrl]);
  assert.deepEqual(manifest.webhook, { enabled: true, url: setup.webhookUrl, resourceTypes: ['AgentSessionEvent', 'AppUserNotification', 'PermissionChange'] });
  assert.equal(manifest.distribution, 'private');
  assert.deepEqual(manifest.oauth.grant_types, ['authorization_code']);
  assert.equal(manifest.developer.name, 'Anima');
  assert.doesNotMatch(url.toString(), /secret|client_id|token/);
  assert.equal(defaultLinearAppName('Milo'), 'Milo');
  for (const name of ['X', 'Linear', 'https://Linear', 'a'.repeat(100)]) {
    assert.doesNotThrow(() => linearAppCreationUrl({ name: defaultLinearAppName(name), callbackUrl, webhookUrl: setup.webhookUrl }));
  }
});

test('setup rejects private and unsafe URLs and invalid callbacks before producing a creation link', () => {
  for (const webhookUrl of ['', 'not a URL', 'https://', 'http://agents.example.com/webhook', 'https://user:secret@agents.example.com/webhook', 'https://localhost/webhook', 'https://127.1/webhook', 'https://10.0.0.1/webhook', 'https://[::1]/webhook', 'https://192.168.1.2/webhook', 'https://172.16.0.1/webhook', 'https://linear.app/webhook', 'https://agents.example.com/webhook?token=secret', 'https://agents.example.com/webhook#secret']) {
    assert.equal(LinearSetupRequest.safeParse({ ...setup, webhookUrl }).success, false, webhookUrl);
  }
  for (const bad of ['', 'not a URL', 'http://remote.example.com/api/linear/oauth/callback', 'https://example.com/wrong', `${callbackUrl}?secret=yes`]) {
    assert.throws(() => linearAppCreationUrl({ name: 'Milo', callbackUrl: bad, webhookUrl: setup.webhookUrl }));
  }
});

test('machine setup reads without writes, persists once and is reused across agents and restarts', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout'), defaultAgentConfig('milo')]);
  const service = new LinearSetupService();
  const before = await readFile(join(home, 'config.json'));
  assert.deepEqual(await service.read(), { webhookUrl: undefined, listener: setup.listener, listenerLocked: false });
  assert.deepEqual(await readFile(join(home, 'config.json')), before);
  await serverConfigStore.update((c) => ({ ...c, dashboardPort: 14174, linearWebhook: { host: '::1', port: 15123 } }));
  const custom = { ...setup, listener: (await service.read()).listener };
  assert.equal(custom.listener.port, 15123);
  await service.save(custom);
  assert.deepEqual(await new LinearSetupService().read(), { ...custom, listenerLocked: false });
  assert.equal((await serverConfigStore.read()).dashboardPort, 14174);
  for (const agentId of ['scout', 'milo']) {
    const auth = await new LinearIdentityService(agentId).begin({ clientId: `${agentId}-client`, signingSecret: install.signingSecret, callbackUrl, listener: custom.listener }, 'binding');
    assert.equal(new URL(auth.authorizationUrl).searchParams.get('redirect_uri'), callbackUrl);
    assert.deepEqual((await new LinearIdentityService(agentId).status()).listener, custom.listener);
  }
  assert.equal((await new LinearSetupService().read()).webhookUrl, custom.webhookUrl);
}));

test('machine setup and direct OAuth preparation cannot move a listener reserved by another pending or installed app', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout'), defaultAgentConfig('milo')]);
  const service = new LinearSetupService();
  await service.save(setup);
  const fake = new FakeLinear();
  const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
  const auth = new URL((await identity.begin({ clientId: install.clientId, signingSecret: install.signingSecret, callbackUrl, listener: setup.listener }, 'binding')).authorizationUrl);
  const changed = { ...setup, listener: { ...setup.listener, port: 15123 } };
  for (const phase of ['pending', 'installed']) {
    assert.equal((await service.read()).listenerLocked, true, phase);
    await assert.rejects(service.save(changed), /share this listener/);
    await assert.rejects(new LinearIdentityService('milo').begin({ clientId: 'milo-client', signingSecret: install.signingSecret, callbackUrl, listener: changed.listener }, 'binding'), /share one webhook listener/);
    assert.deepEqual((await serverConfigStore.read()).linearWebhook, setup.listener);
    if (phase === 'pending') await identity.finish(auth.searchParams.get('state')!, 'synthetic-code', 'binding');
  }
  // Public address changes do not rewrite existing credentials or the bind.
  await service.save({ ...setup, webhookUrl: 'https://new.example.com/webhook' });
  assert.equal((await identity.status()).state, 'connected');
  await identity.remove();
  await service.save(changed);
  assert.equal((await service.read()).listener.port, 15123);
}));

test('setup API validates before saving, preserves custom settings, and exposes no credential fields', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  const app = buildWebApp();
  try {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/linear/setup', payload: { ...setup, webhookUrl: 'http://localhost' } })).statusCode, 400);
    assert.notEqual((await app.inject({ method: 'PUT', url: '/api/linear/setup', payload: { ...setup, listener: { ...setup.listener, port: 4174 } } })).statusCode, 200);
    const result = await app.inject({ method: 'PUT', url: '/api/linear/setup', payload: setup });
    assert.equal(result.statusCode, 200); assert.equal(result.headers['cache-control'], 'no-store');
    const read = await app.inject({ url: '/api/linear/setup' });
    assert.deepEqual(read.json(), { ...setup, listenerLocked: false });
    assert.doesNotMatch(read.body, /secret|token|verifier/);
  } finally { await app.close(); }
}));


test('the shared listener stays reserved while an OAuth code exchange is in flight', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout'), defaultAgentConfig('milo')]);
  const setupService = new LinearSetupService();
  await setupService.save(setup);
  const fake = new FakeLinear();
  let release!: () => void;
  fake.tokenGate = new Promise<void>((resolve) => { release = resolve; });
  const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch));
  const auth = new URL((await identity.begin({ clientId: install.clientId, signingSecret: install.signingSecret, callbackUrl, listener: setup.listener }, 'binding')).authorizationUrl);
  const finishing = identity.finish(auth.searchParams.get('state')!, 'synthetic-code', 'binding');
  try {
    for (let tries = 0; !fake.tokenCalls && tries < 100; tries++) await delay(10);
    assert.equal(fake.tokenCalls, 1);
    assert.equal((await setupService.read()).listenerLocked, true);
    await assert.rejects(setupService.save({ ...setup, listener: { ...setup.listener, port: 15123 } }), /share this listener/);
    await assert.rejects(new LinearIdentityService('milo').begin({ clientId: 'milo-client', signingSecret: install.signingSecret, callbackUrl, listener: { ...setup.listener, port: 15123 } }, 'binding'), /share one webhook listener/);
  } finally { release(); await finishing; }
  assert.equal((await identity.status()).state, 'connected');
  assert.deepEqual((await setupService.read()).listener, setup.listener);
}));
