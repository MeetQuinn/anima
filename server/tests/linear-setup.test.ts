import test from 'node:test';
import assert from 'node:assert/strict';
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
import { install } from './helpers/linear.js';
import { DEFAULT_LINEAR_LISTENER } from '../../shared/linear.js';

const listener = { host: '127.0.0.1', port: 14185 };
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

test('Linear setup only derives URLs from the public address; installs carry no listener and write none', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout'), defaultAgentConfig('milo')]);
  const service = new LinearSetupService();
  const before = await readFile(join(home, 'config.json'));
  assert.deepEqual(await service.read(), { publicUrl: undefined, webhookUrl: undefined, callbackUrl: undefined });
  assert.deepEqual(await readFile(join(home, 'config.json')), before);
  for (const agentId of ['scout', 'milo']) {
    const auth = await new LinearIdentityService(agentId).begin({ clientId: `${agentId}-client`, clientSecret: install.clientSecret!, signingSecret: install.signingSecret, callbackUrl }, 'binding');
    assert.equal(new URL(auth.authorizationUrl).searchParams.get('redirect_uri'), callbackUrl);
    assert.deepEqual((await new LinearIdentityService(agentId).status()).listener, DEFAULT_LINEAR_LISTENER);
  }
  assert.equal((await serverConfigStore.read()).linearWebhook, undefined);
  // An address saved by an earlier version is still the receiver's address.
  await serverConfigStore.update((c) => ({ ...c, linearWebhook: { host: '::1', port: 15123 } }));
  assert.deepEqual((await new LinearIdentityService('scout').status()).listener, { host: '::1', port: 15123 });
}));

test('setup API is read-only and exposes no credential fields', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
  const app = buildWebApp();
  try {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/linear/setup', payload: { listener: { host: '127.0.0.1', port: 15123 } } })).statusCode, 404);
    assert.equal((await serverConfigStore.read()).linearWebhook, undefined);
    const read = await app.inject({ url: '/api/linear/setup' });
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.deepEqual(read.json(), { publicUrl: 'https://agents.example.com', webhookUrl: 'https://agents.example.com/webhooks/linear', callbackUrl: 'https://agents.example.com/api/linear/oauth/callback' });
    assert.doesNotMatch(read.body, /secret|token|verifier/);
  } finally { await app.close(); }
}));

test('global public URL derives both Linear URLs, persists no credentials and requires explicit migration from a webhook-only address', async () => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await writeFile(join(home, 'config.json'), JSON.stringify({ dashboardPort: 14174, linearWebhookUrl: 'https://old.example.com/custom/webhook', linearWebhook: listener }));
  const before = await readFile(join(home, 'config.json'));
  assert.equal((await new LinearSetupService().read()).publicUrl, undefined);
  assert.deepEqual(await readFile(join(home, 'config.json')), before);
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com/' });
  const current = await new LinearSetupService().read();
  assert.equal(current.publicUrl, 'https://agents.example.com');
  assert.equal(current.webhookUrl, 'https://agents.example.com/webhooks/linear');
  assert.equal(current.callbackUrl, 'https://agents.example.com/api/linear/oauth/callback');
  const disk = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.equal(disk.dashboardPort, 14174); assert.deepEqual(disk.linearWebhook, listener);
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
