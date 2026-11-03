import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { buildWebApp } from '../web/app.js';
import { checkPublicUrl } from '../settings/public-url-check.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { LinearMessageTransport } from '../transports/linear-message-transport.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { ServerConfigStore, serverConfigStore } from '../storage/schema/server.store.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { created, install, seedLinear } from './helpers/linear.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
async function unusedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('the dashboard forwards Linear events byte for byte to the receiver, on the new and the legacy path', async () => withTempAnimaHome(async () => {
  const seen: Array<{ path?: string; body: string; headers: IncomingHttpHeaders }> = [];
  let answer = { status: 200, body: '{"received":true}' };
  const receiver = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ path: request.url, body, headers: request.headers });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  const port = await listen(receiver);
  // A wildcard bind is reached on loopback.
  await serverConfigStore.update((c) => ({ ...c, linearWebhook: { host: '0.0.0.0', port } }));
  const app = buildWebApp();
  try {
    const raw = '{ "type":"AgentSessionEvent",  "note": "spacing and 中文 are signed as sent" }';
    for (const url of ['/webhooks/linear', '/webhook']) {
      const response = await app.inject({ method: 'POST', url, payload: raw, headers: { 'content-type': 'application/json', 'linear-signature': 'synthetic-signature' } });
      assert.equal(response.statusCode, 200, url);
      assert.deepEqual(response.json(), { received: true });
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.deepEqual(seen.map((entry) => [entry.path, entry.body, entry.headers['linear-signature'], entry.headers['content-type']]),
      Array(2).fill(['/webhook', raw, 'synthetic-signature', 'application/json']));
    assert.equal(seen[0]!.headers.cookie, undefined);

    answer = { status: 403, body: '{"error":"Invalid Linear signature"}' };
    const refused = await app.inject({ method: 'POST', url: '/webhooks/linear', payload: raw, headers: { 'content-type': 'application/json' } });
    assert.equal(refused.statusCode, 403);
    assert.deepEqual(refused.json(), { error: 'Invalid Linear signature' });
    assert.equal(seen.at(-1)!.headers['linear-signature'], undefined);

    assert.equal((await app.inject({ method: 'POST', url: '/webhooks/linear', payload: 'x'.repeat(270_000), headers: { 'content-type': 'application/json' } })).statusCode, 413);
    assert.equal(seen.length, 3, 'An oversized body is refused before forwarding');

    await close(receiver);
    const down = await app.inject({ method: 'POST', url: '/webhooks/linear', payload: raw, headers: { 'content-type': 'application/json' } });
    assert.equal(down.statusCode, 503, 'Linear retries delivery while the runtime is down');
  } finally {
    await app.close();
    if (receiver.listening) await close(receiver);
  }
}));

test('a signed event through the dashboard reaches the runtime receiver and wakes the agent once', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, fake } = await seedLinear(home);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const port = await unusedPort();
  await new ServerConfigStore().update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  const transport = new LinearMessageTransport(home, { error() {} });
  const app = buildWebApp();
  try {
    await transport.reconcile([await agentStore.read()]);
    const raw = JSON.stringify(created());
    const signature = createHmac('sha256', install.signingSecret).update(raw).digest('hex');
    const response = await app.inject({ method: 'POST', url: '/webhooks/linear', payload: raw, headers: { 'content-type': 'application/json', 'linear-signature': signature, host: 'agents.example.com' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { received: true });
    assert.equal((await new WakeQueueService('scout').list()).length, 1);
    const forged = await app.inject({ method: 'POST', url: '/webhooks/linear', payload: raw, headers: { 'content-type': 'application/json', 'linear-signature': 'f'.repeat(64) } });
    assert.equal(forged.statusCode, 403);
  } finally {
    await app.close();
    await transport.stop();
  }
}));

test('the reachability check proves the public address reaches this Anima and names what is in the way', async () => withTempAnimaHome(async () => {
  const app = buildWebApp();
  try {
    assert.deepEqual(await checkPublicUrl(async () => { throw new Error('unused'); }).then(({ reachable, failure }) => ({ reachable, failure })), { reachable: false, failure: 'not_configured' });
    await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
    let requested = '';
    const throughTunnel: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requested = url.href;
      assert.equal(init?.redirect, 'manual');
      const response = await app.inject({ url: url.pathname, headers: { host: url.host } });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] ?? '') } });
    };
    const reached = await checkPublicUrl(throughTunnel);
    assert.match(requested, /^https:\/\/agents\.example\.com\/webhooks\/probe\/[A-Za-z0-9_-]+$/);
    assert.equal(reached.reachable, true);
    assert.equal(reached.hostRecognized, true);
    assert.equal(reached.passwordSet, false);
    // A proxy that rewrites Host hides the public address from the password guard.
    const rewriting: typeof fetch = async (input) => {
      const response = await app.inject({ url: new URL(String(input)).pathname, headers: { host: '127.0.0.1:4174' } });
      return new Response(response.body, { status: response.statusCode });
    };
    assert.deepEqual(await checkPublicUrl(rewriting).then(({ reachable, hostRecognized }) => ({ reachable, hostRecognized })), { reachable: true, hostRecognized: false });
    // A probe answers once, and only while its check runs.
    assert.equal((await app.inject({ url: new URL(requested).pathname })).statusCode, 404);
    assert.equal((await app.inject({ url: '/webhooks/probe/guessed' })).statusCode, 404);

    const answering = (status: number, body = '') => async () => new Response(body, { status, headers: status >= 300 && status < 400 ? { location: 'https://team.cloudflareaccess.com/' } : {} });
    for (const [fetcher, failure, status] of [
      [answering(302), 'gateway', 302],
      [answering(403, 'Forbidden'), 'gateway', 403],
      [answering(200, '<html>another site</html>'), 'elsewhere', 200],
      [answering(200, '{"probe":"someone-elses"}'), 'elsewhere', 200],
      [answering(404, '{"error":"unknown_probe"}'), 'elsewhere', 404],
      [answering(530), 'unreachable', 530],
    ] as const) {
      const result = await checkPublicUrl(fetcher);
      assert.deepEqual([result.reachable, result.failure, result.status], [false, failure, status]);
    }
    const network = await checkPublicUrl(async () => { throw new TypeError('fetch failed'); });
    assert.deepEqual([network.reachable, network.failure, network.status], [false, 'unreachable', undefined]);
    const slow = await checkPublicUrl(async () => { throw new DOMException('timed out', 'TimeoutError'); });
    assert.equal(slow.failure, 'timeout');

    await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
    assert.equal((await checkPublicUrl(throughTunnel)).passwordSet, true);
  } finally { await app.close(); }
}));

test('without a dashboard password the public address serves only what Linear calls', async () => withTempAnimaHome(async () => {
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
  const app = buildWebApp();
  const port = await unusedPort();
  await serverConfigStore.update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  const viaPublic = { host: 'agents.example.com' };
  try {
    for (const headers of [viaPublic, { host: 'AGENTS.example.com:443' }, { host: 'agents.example.com.' }, { host: 'AGENTS.EXAMPLE.COM.:443' }, { host: 'agents.example.com..' },
      { host: '127.0.0.1:4174', 'x-forwarded-host': 'agents.example.com' }, { host: '127.0.0.1:4174', 'x-forwarded-host': 'Agents.Example.Com.' }]) {
      const api = await app.inject({ url: '/api/agents', headers });
      assert.equal(api.statusCode, 403, JSON.stringify(headers));
      assert.deepEqual(api.json(), { error: 'public_address_requires_password' });
    }
    const page = await app.inject({ url: '/', headers: viaPublic });
    assert.equal(page.statusCode, 403);
    assert.match(page.body, /dashboard-auth set --password-stdin/);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/public-url', headers: viaPublic, payload: { publicUrl: 'https://evil.example.com' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/settings/public-url', headers: viaPublic })).statusCode, 403);
    // Encoded or dotted variants of an allowed path are refused, not routed.
    for (const url of ['/%77ebhooks/linear', '/webhooks/linear/../../api/agents', '/webhooks/probe/x/../../../api/agents']) {
      assert.equal((await app.inject({ method: 'POST', url, headers: viaPublic, payload: '{}' })).statusCode, 403, url);
    }

    // Linear's paths stay open: the receiver is down here, so they answer 503 rather than 403.
    for (const url of ['/webhooks/linear', '/webhook']) {
      assert.equal((await app.inject({ method: 'POST', url, headers: { ...viaPublic, 'content-type': 'application/json' }, payload: '{}' })).statusCode, 503, url);
    }
    assert.equal((await app.inject({ url: '/webhooks/probe/unknown', headers: viaPublic })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/linear/oauth/callback?state=unknown&code=synthetic', headers: viaPublic })).statusCode, 400, 'The OAuth relay answers on the public address');

    // On this machine the dashboard stays open as before.
    assert.equal((await app.inject({ url: '/api/settings/public-url', headers: { host: '127.0.0.1:4174' } })).statusCode, 200);
    // A saved address with a trailing dot names the same host.
    await serverConfigStore.update((c) => ({ ...c, publicUrl: 'https://agents.example.com.' }));
    assert.equal((await app.inject({ url: '/api/agents', headers: viaPublic })).statusCode, 403);
    await serverConfigStore.update((c) => ({ ...c, publicUrl: 'https://agents.example.com' }));

    // With a password the public address is the full dashboard, behind its login.
    await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
    assert.equal((await app.inject({ url: '/api/agents', headers: viaPublic })).statusCode, 401);
    assert.equal((await app.inject({ url: '/', headers: viaPublic })).statusCode, 302);
  } finally { await app.close(); }
}));

test('a receiver address on the dashboard\'s own port is refused instead of forwarded again', async () => withTempAnimaHome(async () => {
  const app = buildWebApp();
  let ingress = 0;
  app.addHook('onRequest', async (request) => { if (request.url.startsWith('/webhook')) ingress += 1; });
  const payload = { method: 'POST' as const, url: '/webhooks/linear', payload: '{}', headers: { 'content-type': 'application/json' } };
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    await serverConfigStore.update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
    const looped = await fetch(`http://127.0.0.1:${port}/webhooks/linear`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(looped.status, 503);
    assert.match(await looped.text(), /linearWebhook/);
    assert.equal(ingress, 1, 'Refused before connecting to itself');

    // The configured dashboard port is refused too, even when this request came in elsewhere.
    await serverConfigStore.update((c) => ({ ...c, dashboardPort: 15124, linearWebhook: { host: '127.0.0.1', port: 15124 } }));
    assert.equal((await app.inject(payload)).statusCode, 503);

    // Any other loop stops at the second hop: a forwarded event is never forwarded again.
    ingress = 0;
    const marked = await app.inject({ ...payload, headers: { ...payload.headers, 'x-anima-linear-forwarded': '1' } });
    assert.equal(marked.statusCode, 503);
    assert.match(marked.body, /linearWebhook/);
    assert.equal(ingress, 1);
  } finally { await app.close(); }
}));
