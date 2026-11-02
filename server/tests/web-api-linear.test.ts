import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LinearIdentityService } from '../linear/identity.service.js';
import { buildWebApp } from '../web/app.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { withTempAnimaHome, writeAgentConfigs, defaultAgentConfig } from './helpers/harness.js';
import { FakeLinear, install, seedLinear } from './helpers/linear.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { LinearStore } from '../storage/schema/linear.store.js';

type Injected = { statusCode: number; headers: Record<string, unknown>; body: string };

// The completion page returns to a server-chosen same-origin profile with a
// script the CSP allows by hash and nothing else.
function assertReturnPage(response: Injected, agentId: string, outcome: string) {
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^text\/html/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  const csp = String(response.headers['content-security-policy']);
  assert.match(csp, /default-src 'none'/); assert.match(csp, /frame-ancestors 'none'/); assert.doesNotMatch(csp, /unsafe-inline/);
  const scripts = [...response.body.matchAll(/<script>([^<]*)<\/script>/g)].map((m) => m[1]!);
  assert.equal(scripts.length, 1);
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(scripts[0]!).digest('base64')}'`), 'CSP allows exactly the inline script');
  assert.equal(/id="next" href="([^"]+)"/.exec(response.body)?.[1], `/agents/${agentId}/profile?linear=${outcome}`);
}

// Not tied to an attempt in this session: no agent named, nothing navigates.
function assertRetryPage(response: Injected, link: boolean) {
  assert.equal(response.statusCode, 400);
  assert.match(String(response.headers['content-type']), /^text\/html/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(response.body, /<script|\/agents\/|\bscout\b|\bother\b/);
  assert.equal(response.body.includes('href="/"'), link);
}

test('real dashboard guard protects Linear credentials, install/remove and bound callback', async (t) => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
  const fake = new FakeLinear(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const app = buildWebApp();
  try {
    for (const [method, url] of [['GET', '/api/linear/setup'], ['PUT', '/api/linear/setup'], ['GET', '/api/agents/scout/linear'], ['POST', '/api/agents/scout/linear/install'], ['DELETE', '/api/agents/scout/linear'], ['GET', '/api/linear/oauth/complete?state=synthetic&code=secret'], ['GET', '/api/settings/public-url'], ['PUT', '/api/settings/public-url']] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
    }
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'synthetic-dashboard-password' } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
    const prepared = await app.inject({ method: 'POST', url: '/api/agents/scout/linear/install', headers: { cookie }, payload: {
      clientId: install.clientId, signingSecret: install.signingSecret, callbackUrl: 'https://agents.example.com/api/linear/oauth/callback', listener: { host: '127.0.0.1', port: 14375 },
    } });
    assert.equal(prepared.statusCode, 200);
    assert.equal(prepared.headers['cache-control'], 'no-store');
    const state = new URL(prepared.json().authorizationUrl).searchParams.get('state')!;
    const relay = await app.inject({ url: `/api/linear/oauth/callback?state=${state}&code=synthetic-code&returnUrl=https://evil.example.com`, headers: { host: 'agents.example.com' } });
    assert.equal(relay.statusCode, 303);
    assert.equal(relay.headers['referrer-policy'], 'no-referrer');
    assert.equal(relay.headers['cache-control'], 'no-store');
    const redirect = new URL(String(relay.headers.location));
    assert.equal(redirect.origin, 'http://localhost');
    assert.equal(redirect.pathname, '/api/linear/oauth/complete');
    assert.equal(fake.tokenCalls, 0, 'The public relay cannot exchange or install');
    assert.equal((await app.inject({ url: redirect.pathname + redirect.search })).statusCode, 401);
    const secondLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'synthetic-dashboard-password' } });
    // An authenticated but different dashboard session cannot consume this state.
    const otherCookie = String(secondLogin.headers['set-cookie']).split(';')[0]!;
    const wrong = await app.inject({ method: 'GET', url: `/api/linear/oauth/complete?state=${state}&code=synthetic-code`, headers: { cookie: otherCookie } });
    assertRetryPage(wrong, true); assert.equal(fake.tokenCalls, 0);
    assert.equal((await new LinearStore('scout').read()).pending?.id, state, 'A wrong session leaves the attempt in place');
    const completed = await app.inject({ method: 'GET', url: `/api/linear/oauth/complete?state=${state}&code=synthetic-code`, headers: { cookie } });
    assertReturnPage(completed, 'scout', 'connected'); assert.equal(fake.tokenCalls, 1);
    // Replays find no attempt: generic pages, no second exchange.
    assertRetryPage(await app.inject({ url: `/api/linear/oauth/complete?state=${state}&code=synthetic-code`, headers: { cookie } }), true);
    assertRetryPage(await app.inject({ url: `/api/linear/oauth/callback?state=${state}&code=synthetic-code`, headers: { host: 'agents.example.com' } }), false);
    assert.equal(fake.tokenCalls, 1);
    const status = await app.inject({ url: '/api/agents/scout/linear', headers: { cookie } });
    assert.equal(status.statusCode, 200); assert.equal(status.json().state, 'connected');
    assert.equal(status.json().workspaceName, 'Synthetic workspace');
    for (const secret of [install.signingSecret, 'new-access-sentinel', 'new-refresh-sentinel', 'synthetic-code']) assert.ok(!status.body.includes(secret));
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/agents/scout/linear', headers: { cookie } })).statusCode, 200);
    assert.equal((await new LinearStore('scout').read()).installation, undefined);
  } finally { await app.close(); }
}));


for (const readOnly of [false, true]) {
  for (const expired of [false, true]) {
    test(`Linear status GET never requests metadata or changes credentials (readOnly=${readOnly}, expired=${expired})`, async (t) => withTempAnimaHome(async (home) => {
      const { store } = await seedLinear(home);
      await store.update((file) => ({ ...file, installation: { ...file.installation!, workspaceName: undefined, expiresAt: expired ? 0 : Date.now() + 3_600_000 } }));
      const paths = ['linear.json', 'config.json'].map((name) => join(home, 'agents/scout', name));
      const before = await Promise.all(paths.map((path) => readFile(path)));
      const lookup = t.mock.method(LinearIdentityService.prototype, 'graphql', async () => { throw new Error('Status must not request remote metadata'); });
      const token = t.mock.method(LinearIdentityService.prototype, 'accessToken', async () => { throw new Error('Status must not inspect or refresh tokens'); });
      const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Status must not make network requests'); });
      const writes = t.mock.method(LinearStore.prototype, 'update');
      const previous = process.env.ANIMA_READ_ONLY;
      if (readOnly) process.env.ANIMA_READ_ONLY = '1'; else delete process.env.ANIMA_READ_ONLY;
      const app = buildWebApp();
      try {
        for (let i = 0; i < 3; i++) {
          const response = await app.inject({ url: '/api/agents/scout/linear' });
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().state, 'connected');
          assert.equal(response.json().workspaceName, undefined);
          assert.equal(response.body.includes('sentinel'), false);
        }
        assert.equal(lookup.mock.callCount(), 0);
        assert.equal(token.mock.callCount(), 0);
        assert.equal(network.mock.callCount(), 0);
        assert.equal(writes.mock.callCount(), 0);
        assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
      } finally {
        await app.close();
        if (previous === undefined) delete process.env.ANIMA_READ_ONLY; else process.env.ANIMA_READ_ONLY = previous;
      }
    }));
  }
}

test('private LAN OAuth completion permits only navigation from an allowed peer and host with the original session', async (t) => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await defaultDashboardAuthService.setPassword('synthetic-password');
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
  const fake = new FakeLinear(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const local = buildWebApp();
  const lan = buildWebApp({ allowedPeers: ['100.100.100.10'], allowedHosts: ['anima-lan'], port: 4174 });
  const remoteAddress = '100.100.100.10', host = 'anima-lan:4174';
  try {
    const login = await lan.inject({ remoteAddress, method: 'POST', url: '/api/auth/login', headers: { host }, payload: { password: 'synthetic-password' } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const prepared = await lan.inject({ remoteAddress, method: 'POST', url: '/api/agents/scout/linear/install', headers: { host, cookie, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, payload: {
      clientId: install.clientId, signingSecret: install.signingSecret, callbackUrl: 'https://agents.example.com/api/linear/oauth/callback', listener: { host: '127.0.0.1', port: 14375 },
    } });
    assert.equal(prepared.statusCode, 200);
    const state = new URL(prepared.json().authorizationUrl).searchParams.get('state')!;
    const relay = await local.inject({ url: `/api/linear/oauth/callback?state=${state}&code=synthetic-code`, headers: { host: 'agents.example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
    assert.equal(relay.statusCode, 303);
    const target = new URL(String(relay.headers.location));
    assert.equal(target.origin, `http://${host}`);
    const url = target.pathname + target.search;
    const headers = { host, cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (const denied of [
      { remoteAddress: '100.100.100.11', headers },
      { remoteAddress, headers: { ...headers, host: 'evil.example:4174' } },
      { remoteAddress, headers: { ...headers, 'sec-fetch-mode': 'cors' } },
      { remoteAddress, headers: { ...headers, 'sec-fetch-dest': 'iframe' } },
      { remoteAddress, method: 'POST' as const, headers },
      { remoteAddress, url: '/api/health', headers },
      { remoteAddress, url: `/api/linear/oauth/callback?state=${state}&code=synthetic-code`, headers },
    ]) {
      const response = await lan.inject({ url, ...denied });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'network_access_denied');
    }
    assert.equal((await lan.inject({ remoteAddress, url, headers: { ...headers, cookie: '' } })).statusCode, 401);
    const secondLogin = await lan.inject({ remoteAddress, method: 'POST', url: '/api/auth/login', headers: { host }, payload: { password: 'synthetic-password' } });
    const other = String(secondLogin.headers['set-cookie']).split(';')[0]!;
    assert.notEqual((await lan.inject({ remoteAddress, url, headers: { ...headers, cookie: other } })).statusCode, 200);
    assert.equal(fake.tokenCalls, 0);
    const completed = await lan.inject({ remoteAddress, url, headers });
    assertReturnPage(completed, 'scout', 'connected');
    assert.equal(fake.tokenCalls, 1);
    assert.equal((await new LinearIdentityService('scout').status()).state, 'connected');
    // The page navigates itself, so the profile request is same-origin. The
    // profile keeps no cross-site exemption, which is why /complete cannot 303.
    const profile = '/agents/scout/profile?linear=connected';
    const navigate = { host, cookie, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    assert.notEqual((await lan.inject({ remoteAddress, url: profile, headers: { ...navigate, 'sec-fetch-site': 'same-origin' } })).statusCode, 403);
    assert.equal((await lan.inject({ remoteAddress, url: profile, headers: { ...navigate, 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
  } finally { await local.close(); await lan.close(); }
}));

test('failed OAuth completion gives a readable return path and retains only safe diagnostics', async (t) => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
  t.mock.method(globalThis, 'fetch', async () => new Response('private-response-sentinel', { status: 503 }));
  const app = buildWebApp();
  try {
    const prepared = await app.inject({ method: 'POST', url: '/api/agents/scout/linear/install', payload: {
      clientId: install.clientId, signingSecret: install.signingSecret, callbackUrl: 'https://agents.example.com/api/linear/oauth/callback', listener: { host: '127.0.0.1', port: 14375 },
    } });
    const state = new URL(prepared.json().authorizationUrl).searchParams.get('state')!;
    const response = await app.inject({ url: `/api/linear/oauth/complete?state=${state}&code=private-code-sentinel` });
    assertReturnPage(response, 'scout', 'failed'); assert.doesNotMatch(response.body, /sentinel/);
    const status = (await app.inject({ url: '/api/agents/scout/linear' })).json();
    assert.equal(status.state, 'not_configured'); assert.match(status.lastError, /HTTP 503/); assert.doesNotMatch(JSON.stringify(status), /sentinel/);
  } finally { await app.close(); }
}));

test('declined and expired OAuth returns stay with their own attempt and never touch another agent', async (t) => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout'), defaultAgentConfig('other')]);
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
  const fake = new FakeLinear(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const app = buildWebApp();
  const prepare = async (agentId: string, clientId: string) => new URL((await app.inject({ method: 'POST', url: `/api/agents/${agentId}/linear/install`, payload: {
    clientId, signingSecret: install.signingSecret, callbackUrl: 'https://agents.example.com/api/linear/oauth/callback', listener: { host: '127.0.0.1', port: 14375 },
  } })).json().authorizationUrl).searchParams.get('state')!;
  try {
    const scout = await prepare('scout', install.clientId);
    const other = await prepare('other', 'other-client-id-0000000000000000');
    assertReturnPage(await app.inject({ url: `/api/linear/oauth/complete?state=${scout}&error=access_denied` }), 'scout', 'declined');
    assert.match((await new LinearIdentityService('scout').status()).lastError!, /declined/);
    assert.equal((await new LinearStore('other').read()).pending?.id, other, 'Another agent keeps its attempt');
    // Expired: generic page, nothing exchanged, the expired attempt is not cleared by the callback.
    await new LinearStore('other').update((file) => ({ ...file, pending: { ...file.pending!, expiresAt: Date.now() - 1 } }));
    assertRetryPage(await app.inject({ url: `/api/linear/oauth/complete?state=${other}&code=synthetic-code` }), true);
    assertRetryPage(await app.inject({ url: `/api/linear/oauth/callback?state=${other}&code=synthetic-code`, headers: { host: 'agents.example.com' } }), false);
    assert.equal((await new LinearStore('other').read()).pending?.id, other);
    // Unknown and malformed states name nobody.
    assertRetryPage(await app.inject({ url: '/api/linear/oauth/complete?state=unknown-state&code=synthetic-code' }), true);
    assertRetryPage(await app.inject({ url: '/api/linear/oauth/complete?state=unknown-state' }), true);
    assertRetryPage(await app.inject({ url: '/api/linear/oauth/callback?state=unknown-state&code=synthetic-code', headers: { host: 'agents.example.com' } }), false);
    assert.equal(fake.tokenCalls, 0);
  } finally { await app.close(); }
}));
