import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWebApp } from '../web/app.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { withTempAnimaHome, writeAgentConfigs, defaultAgentConfig } from './helpers/harness.js';
import { FakeLinear, install } from './helpers/linear.js';
import { LinearStore } from '../storage/schema/linear.store.js';

test('real dashboard guard protects Linear credentials, install/remove and bound callback', async (t) => withTempAnimaHome(async (home) => {
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
  const fake = new FakeLinear(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const app = buildWebApp();
  try {
    for (const [method, url] of [['GET', '/api/agents/scout/linear'], ['POST', '/api/agents/scout/linear/install'], ['DELETE', '/api/agents/scout/linear'], ['GET', '/api/linear/oauth/callback?state=synthetic&code=secret']] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
    }
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'synthetic-dashboard-password' } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const prepared = await app.inject({ method: 'POST', url: '/api/agents/scout/linear/install', headers: { cookie }, payload: {
      clientId: install.clientId, signingSecret: install.signingSecret, callbackUrl: 'http://localhost:14374/api/linear/oauth/callback', listener: { host: '127.0.0.1', port: 14375 },
    } });
    assert.equal(prepared.statusCode, 200);
    assert.equal(prepared.headers['cache-control'], 'no-store');
    const state = new URL(prepared.json().authorizationUrl).searchParams.get('state')!;
    const secondLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'synthetic-dashboard-password' } });
    // An authenticated but different dashboard session cannot consume this state.
    const otherCookie = String(secondLogin.headers['set-cookie']).split(';')[0]!;
    const wrong = await app.inject({ method: 'GET', url: `/api/linear/oauth/callback?state=${state}&code=synthetic-code`, headers: { cookie: otherCookie } });
    assert.notEqual(wrong.statusCode, 200); assert.equal(fake.tokenCalls, 0);
    const completed = await app.inject({ method: 'GET', url: `/api/linear/oauth/callback?state=${state}&code=synthetic-code`, headers: { cookie } });
    assert.equal(completed.statusCode, 200); assert.equal(fake.tokenCalls, 1);
    const status = await app.inject({ url: '/api/agents/scout/linear', headers: { cookie } });
    assert.equal(status.statusCode, 200); assert.equal(status.json().state, 'connected');
    for (const secret of [install.signingSecret, 'new-access-sentinel', 'new-refresh-sentinel', 'synthetic-code']) assert.ok(!status.body.includes(secret));
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/agents/scout/linear', headers: { cookie } })).statusCode, 200);
    assert.equal((await new LinearStore('scout').read()).installation, undefined);
  } finally { await app.close(); }
}));
