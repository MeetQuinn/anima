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

const PUBLIC = 'https://agents.example.com';
const isWebhooksProbe = (input: Parameters<typeof fetch>[0]) => new URL(String(input)).pathname.startsWith('/webhooks/');

/** A tunnel that forwards every request through the public address to this dashboard. */
function tunnelTo(app: ReturnType<typeof buildWebApp>, requested: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    requested.push(url.href);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    const response = await app.inject({ url: url.pathname, headers: { host: url.host } });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] ?? '') } });
  };
}

test('the reachability check proves the public address reaches this Anima and names what is in the way', async () => withTempAnimaHome(async () => {
  const app = buildWebApp();
  try {
    assert.deepEqual(await checkPublicUrl(async () => { throw new Error('unused'); }).then(({ reachable, failure, dashboard }) => ({ reachable, failure, dashboard })), { reachable: false, failure: 'not_configured', dashboard: undefined });
    await defaultServerSettingsService.setPublicUrl({ publicUrl: PUBLIC });
    const requested: string[] = [];
    const reached = await checkPublicUrl(tunnelTo(app, requested));
    assert.equal(requested.length, 2);
    const webhooksProbe = requested.find((url) => /^https:\/\/agents\.example\.com\/webhooks\/probe\/[A-Za-z0-9_-]+$/.test(url));
    const dashboardProbe = requested.find((url) => /^https:\/\/agents\.example\.com\/api\/settings\/public-url\/probe\/[A-Za-z0-9_-]+$/.test(url));
    assert.ok(webhooksProbe && dashboardProbe, requested.join(' '));
    assert.equal(reached.reachable, true);
    assert.equal(reached.passwordSet, false);
    // A probe answers once, and only while its check runs.
    for (const url of [webhooksProbe, dashboardProbe, '/webhooks/probe/guessed', '/api/settings/public-url/probe/guessed']) {
      assert.equal((await app.inject({ url: new URL(url, PUBLIC).pathname })).statusCode, 404, url);
    }

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
      assert.deepEqual([result.reachable, result.failure, result.status, result.dashboard], [false, failure, status, { open: false, status }]);
    }
    const network = await checkPublicUrl(async () => { throw new TypeError('fetch failed'); });
    assert.deepEqual([network.reachable, network.failure, network.status, network.dashboard], [false, 'unreachable', undefined, undefined]);
    const slow = await checkPublicUrl(async () => { throw new DOMException('timed out', 'TimeoutError'); });
    assert.equal(slow.failure, 'timeout');

    await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
    assert.equal((await checkPublicUrl(tunnelTo(app))).passwordSet, true);
  } finally { await app.close(); }
}));

test('the dashboard counts as open at the public address only when this dashboard answers a request without sign-in', async () => withTempAnimaHome(async () => {
  await defaultServerSettingsService.setPublicUrl({ publicUrl: PUBLIC });
  const app = buildWebApp();
  const tunnel = tunnelTo(app);
  try {
    const open = await checkPublicUrl(tunnel);
    assert.deepEqual([open.reachable, open.dashboard], [true, { open: true, status: 200 }]);

    // Something in front of the dashboard answers its path and lets /webhooks/ through.
    const inFront = (status: number, body = '', headers: Record<string, string> = {}): typeof fetch => async (input, init) =>
      isWebhooksProbe(input) ? tunnel(input, init) : new Response(body, { status, headers });
    for (const [label, fetcher, status] of [
      ['a gateway redirects to its sign-in', inFront(302, '', { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' }), 302],
      ['a gateway asks for credentials', inFront(401), 401],
      ['an access rule refuses', inFront(403, 'Forbidden'), 403],
      ['a gateway serves its sign-in page as 200', inFront(200, '<!doctype html><form>Sign in</form>'), 200],
      ['another site, even another Anima\'s dashboard page', inFront(200, '<!doctype html><title>Anima</title>'), 200],
      ['another Anima echoes only probes it issued', inFront(200, '{"probe":"someone-elses"}'), 200],
      ['the proxy forwards only /webhooks/', inFront(404, 'Not Found'), 404],
      ['the gateway fails', inFront(502), 502],
    ] as const) {
      const result = await checkPublicUrl(fetcher);
      assert.deepEqual([result.reachable, result.dashboard], [true, { open: false, status }], label);
    }

    // No HTTP answer says nothing either way.
    for (const error of [new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')]) {
      const result = await checkPublicUrl(async (input, init) => isWebhooksProbe(input) ? tunnel(input, init) : Promise.reject(error));
      assert.deepEqual([result.reachable, result.dashboard], [true, undefined], error.name);
    }

    // Open does not depend on Linear's path getting through.
    const webhooksBlocked = await checkPublicUrl(async (input, init) => isWebhooksProbe(input) ? new Response('', { status: 403 }) : tunnel(input, init));
    assert.deepEqual([webhooksBlocked.reachable, webhooksBlocked.failure, webhooksBlocked.dashboard], [false, 'gateway', { open: true, status: 200 }]);

    // Each path answers only its own probe, so neither can stand in for the other.
    const crossed: number[] = [];
    await checkPublicUrl(async (input, init) => {
      const url = new URL(String(input));
      const nonce = url.pathname.split('/').at(-1);
      const other = isWebhooksProbe(input) ? `/api/settings/public-url/probe/${nonce}` : `/webhooks/probe/${nonce}`;
      crossed.push((await app.inject({ url: other })).statusCode);
      return tunnel(input, init);
    });
    assert.deepEqual(crossed, [404, 404]);

    // With a dashboard password the same request gets the dashboard's 401: not open.
    await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
    const guarded = await checkPublicUrl(tunnel);
    assert.deepEqual([guarded.reachable, guarded.passwordSet, guarded.dashboard], [true, true, { open: false, status: 401 }]);
    assert.equal((await app.inject({ url: '/api/settings/public-url/probe/guessed', headers: { host: 'agents.example.com' } })).statusCode, 401);
  } finally { await app.close(); }
}));

test('the public address is the whole dashboard: open without a password, behind its login with one', async () => withTempAnimaHome(async () => {
  await defaultServerSettingsService.setPublicUrl({ publicUrl: 'https://agents.example.com' });
  const app = buildWebApp();
  const port = await unusedPort();
  await serverConfigStore.update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  const viaPublic = { host: 'agents.example.com' };
  const linearPathsAnswer = async () => {
    // The receiver is down here, so events answer 503 rather than reaching it.
    for (const url of ['/webhooks/linear', '/webhook']) {
      assert.equal((await app.inject({ method: 'POST', url, headers: { ...viaPublic, 'content-type': 'application/json' }, payload: '{}' })).statusCode, 503, url);
    }
    assert.equal((await app.inject({ url: '/webhooks/probe/unknown', headers: viaPublic })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/linear/oauth/callback?state=unknown&code=synthetic', headers: viaPublic })).statusCode, 400, 'The OAuth relay answers on the public address');
  };
  try {
    // Whatever forwards the address decides who reaches it; Anima treats its requests
    // like any other.
    for (const headers of [viaPublic, { host: '127.0.0.1:4174', 'x-forwarded-host': 'agents.example.com' }, { host: '127.0.0.1:4174' }]) {
      assert.equal((await app.inject({ url: '/api/settings/public-url', headers })).statusCode, 200, JSON.stringify(headers));
    }
    assert.equal((await app.inject({ url: '/', headers: viaPublic })).statusCode, 200);
    await linearPathsAnswer();

    await defaultDashboardAuthService.setPassword('synthetic-dashboard-password');
    assert.equal((await app.inject({ url: '/api/agents', headers: viaPublic })).statusCode, 401);
    assert.equal((await app.inject({ url: '/', headers: viaPublic })).statusCode, 302);
    await linearPathsAnswer();
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
