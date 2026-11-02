import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicUrl } from '../../shared/public-url.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { linearAppCreationUrl, defaultLinearAppName } from '../../shared/linear-setup.js';
import { LinearSetupService } from '../linear/setup.service.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { buildWebApp } from '../web/app.js';
import { withTempAnimaHome, writeAgentConfigs, defaultAgentConfig } from './helpers/harness.js';
import { FakeLinear, install } from './helpers/linear.js';
import { LinearClient } from '../linear/client.js';

const setup = { listener: { host: '127.0.0.1', port: 14185 } };
const callbackUrl = 'http://localhost:14174/api/linear/oauth/callback';

test('manifest prefills a private agent app, callback and all three wake event subscriptions without secrets', () => {
  const url = new URL(linearAppCreationUrl({ name: 'Milo 中文 & "Review"', callbackUrl, webhookUrl: 'https://agents.example.com/webhook' }));
  assert.equal(url.origin + url.pathname, 'https://linear.app/settings/api/applications/new');
  const manifest = JSON.parse(url.searchParams.get('manifest')!);
  assert.equal(manifest.oauth.client_name, 'Milo 中文 & "Review"');
  assert.deepEqual(manifest.oauth.redirect_uris, [callbackUrl]);
  assert.deepEqual(manifest.webhook, { enabled: true, url: 'https://agents.example.com/webhook', resourceTypes: ['AgentSessionEvent', 'AppUserNotification', 'PermissionChange'] });
  assert.equal(manifest.distribution, 'private');
  assert.deepEqual(manifest.oauth.grant_types, ['authorization_code']);
  assert.equal(manifest.developer.name, 'Anima');
  assert.doesNotMatch(url.toString(), /secret|client_id|token/);
  assert.equal(defaultLinearAppName('Milo'), 'Milo');
  for (const name of ['X', 'Linear', 'https://Linear', 'a'.repeat(100)]) {
    assert.doesNotThrow(() => linearAppCreationUrl({ name: defaultLinearAppName(name), callbackUrl, webhookUrl: 'https://agents.example.com/webhook' }));
  }
});

test('manifest prefills a public avatar as the app icon and omits anything Linear could not or should not fetch', () => {
  const manifest = (iconUrl?: string) => JSON.parse(new URL(linearAppCreationUrl({ name: 'Milo', callbackUrl, webhookUrl: 'https://agents.example.com/webhook', iconUrl })).searchParams.get('manifest')!);
  const avatar = 'https://avatars.slack-edge.com/2026-01-01/123_abc_72.png';
  assert.deepEqual(manifest(avatar).display, { iconUrl: avatar });
  for (const iconUrl of [undefined, '', '/api/agents/milo/avatar', 'http://avatars.example.com/a.png', 'https://localhost/a.png', 'https://10.0.0.1/a.png', 'https://user:pw@cdn.example.com/a.png', 'https://cdn.example.com/a.png?token=signed', 'not a url']) {
    assert.equal(manifest(iconUrl).display, undefined, String(iconUrl));
  }
});

test('setup rejects private and unsafe URLs and invalid callbacks before producing a creation link', () => {
  for (const webhookUrl of ['', 'not a URL', 'https://', 'http://agents.example.com/webhook', 'https://user:secret@agents.example.com/webhook', 'https://localhost/webhook', 'https://127.1/webhook', 'https://10.0.0.1/webhook', 'https://[::1]/webhook', 'https://192.168.1.2/webhook', 'https://172.16.0.1/webhook', 'https://linear.app/webhook', 'https://agents.example.com/webhook?token=secret', 'https://agents.example.com/webhook#secret']) {
    assert.equal(PublicUrl.safeParse(webhookUrl).success, false, webhookUrl);
  }
  for (const bad of ['', 'not a URL', 'http://remote.example.com/api/linear/oauth/callback', 'https://example.com/wrong', `${callbackUrl}?secret=yes`]) {
    assert.throws(() => linearAppCreationUrl({ name: 'Milo', callbackUrl: bad, webhookUrl: 'https://agents.example.com/webhook' }));
  }
});

test('machine setup reads without writes, persists once and is reused across agents and restarts', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout'), defaultAgentConfig('milo')]);
  const service = new LinearSetupService();
  const before = await readFile(join(home, 'config.json'));
  assert.deepEqual(await service.read(), { publicUrl: undefined, webhookUrl: undefined, callbackUrl: undefined, listener: setup.listener, listenerLocked: false });
  assert.deepEqual(await readFile(join(home, 'config.json')), before);
  await serverConfigStore.update((c) => ({ ...c, dashboardPort: 14174, linearWebhook: { host: '::1', port: 15123 } }));
  const custom = { ...setup, listener: (await service.read()).listener };
  assert.equal(custom.listener.port, 15123);
  await service.save(custom);
  assert.deepEqual(await new LinearSetupService().read(), { ...custom, publicUrl: undefined, webhookUrl: undefined, callbackUrl: undefined, listenerLocked: false });
  assert.equal((await serverConfigStore.read()).dashboardPort, 14174);
  for (const agentId of ['scout', 'milo']) {
    const auth = await new LinearIdentityService(agentId).begin({ clientId: `${agentId}-client`, signingSecret: install.signingSecret, callbackUrl, listener: custom.listener }, 'binding');
    assert.equal(new URL(auth.authorizationUrl).searchParams.get('redirect_uri'), callbackUrl);
    assert.deepEqual((await new LinearIdentityService(agentId).status()).listener, custom.listener);
  }
  assert.equal((await new LinearSetupService().read()).webhookUrl, undefined);
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
    await assert.rejects(service.save(changed), /An installed app or an authorization in progress uses this listener/);
    await assert.rejects(new LinearIdentityService('milo').begin({ clientId: 'milo-client', signingSecret: install.signingSecret, callbackUrl, listener: changed.listener }, 'binding'), /An installed app or an authorization in progress/);
    assert.deepEqual((await serverConfigStore.read()).linearWebhook, setup.listener);
    if (phase === 'pending') await identity.finish(auth.searchParams.get('state')!, 'synthetic-code', 'binding');
  }
  // Public address changes do not rewrite existing credentials or the bind.
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://new.example.com' });
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
    await assert.rejects(setupService.save({ ...setup, listener: { ...setup.listener, port: 15123 } }), /An installed app or an authorization in progress uses this listener/);
    await assert.rejects(new LinearIdentityService('milo').begin({ clientId: 'milo-client', signingSecret: install.signingSecret, callbackUrl, listener: { ...setup.listener, port: 15123 } }, 'binding'), /An installed app or an authorization in progress/);
  } finally { release(); await finishing; }
  assert.equal((await identity.status()).state, 'connected');
  assert.deepEqual((await setupService.read()).listener, setup.listener);
}));

test('global public URL derives both Linear URLs, persists no credentials and requires explicit migration from a webhook-only address', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await writeFile(join(home, 'config.json'), JSON.stringify({ dashboardPort: 14174, linearWebhookUrl: 'https://old.example.com/custom/webhook', linearWebhook: setup.listener }));
  const before = await readFile(join(home, 'config.json'));
  assert.equal((await new LinearSetupService().read()).publicUrl, undefined);
  assert.deepEqual(await readFile(join(home, 'config.json')), before);
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com/' });
  const current = await new LinearSetupService().read();
  assert.equal(current.publicUrl, 'https://agents.example.com');
  assert.equal(current.webhookUrl, 'https://agents.example.com/webhook');
  assert.equal(current.callbackUrl, 'https://agents.example.com/api/linear/oauth/callback');
  const disk = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.equal(disk.dashboardPort, 14174); assert.deepEqual(disk.linearWebhook, setup.listener);
  assert.equal(disk.linearWebhookUrl, undefined);
  for (const value of ['https://agents.example.com/path', 'https://agents.example.com?x=1', 'http://agents.example.com', 'https://127.0.0.1', 'https://user:secret@agents.example.com']) assert.equal(PublicUrl.safeParse(value).success, false, value);
  const app = buildWebApp();
  try {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/public-url', headers: { origin: 'https://evil.example.com', host: 'localhost' }, payload: { publicUrl: 'https://evil.example.com' } })).statusCode, 403);
    const read = await app.inject({ url: '/api/settings/public-url' });
    assert.deepEqual(read.json(), { publicUrl: current.publicUrl });
    assert.equal(read.headers['cache-control'], 'no-store');
  } finally { await app.close(); }
}));
