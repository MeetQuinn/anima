import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LinearMessageTransport } from '../transports/linear-message-transport.js';
import { LinearListenerStore } from '../storage/schema/linear-listener.store.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { buildWebApp } from '../web/app.js';
import { withTempAnimaHome, waitFor, withTimeout } from './helpers/harness.js';
import { created, install, seedLinear } from './helpers/linear.js';

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = { host: '127.0.0.1', port: (server.address() as { port: number }).port };
  return { server, address, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
function post(port: number, payload: unknown = {}, signature?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature) headers['linear-signature'] = signature;
    const req = request({ host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers }, (res) => {
      res.resume(); res.once('end', () => resolve(res.statusCode!));
    });
    req.once('error', reject); req.end(JSON.stringify(payload));
  });
}
const unsignedPost = (port: number) => post(port);
function acceptedPost(port: number): Promise<number> {
  const event = created();
  return post(port, event, createHmac('sha256', install.signingSecret).update(JSON.stringify(event)).digest('hex'));
}

test('real API separates an installed identity from bind failure, recovery, refreshed observation and stopped listener', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, fake } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  const reserved = await reservePort();
  await new ServerConfigStore(home).update((c) => ({ ...c, linearWebhook: reserved.address }));
  const transport = new LinearMessageTransport(home, { error() {} });
  const web = buildWebApp();
  const status = async () => {
    const response = await web.inject({ url: '/api/agents/scout/linear' });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /sentinel|processId|EADDRINUSE|stack/);
    return response.json();
  };
  try {
    assert.deepEqual((await status()).listenerStatus, { state: 'unknown' });
    await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await status()).listenerStatus?.state === 'failed');
    const failed = await status();
    assert.equal(failed.state, 'connected'); assert.deepEqual(failed.listener, reserved.address);
    assert.equal(failed.listenerStatus.reason, 'address_in_use');
    assert.ok(failed.listenerStatus.observedAt);
    await reserved.close(); await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await status()).listenerStatus?.state === 'listening');
    const first = (await status()).listenerStatus.observedAt;
    assert.equal(await unsignedPost(reserved.address.port), 403);
    const app = (transport as unknown as { app: unknown }).app;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await status()).listenerStatus?.observedAt !== first);
    assert.equal((transport as unknown as { app: unknown }).app, app, 'refresh does not rebind');
    const path = join(home, 'run/linear-listener.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok((await stat(path)).size < 400); assert.doesNotMatch(await readFile(path, 'utf8'), /sentinel|accessToken|refreshToken|signingSecret/);
    await transport.stop(); assert.equal((await status()).listenerStatus.state, 'stopped');
    await assert.rejects(unsignedPost(reserved.address.port));
    const replacement = new LinearMessageTransport(home, { error() {} });
    try {
      await replacement.reconcile([await agentStore.read()]);
      await waitFor(async () => (await status()).listenerStatus?.state === 'listening');
      assert.equal(await unsignedPost(reserved.address.port), 403);
    } finally { await replacement.stop(); }
    assert.equal((await new WakeQueueService('scout').list()).length, 0); assert.equal(fake.calls.length, 0);
  } finally { await transport.stop(); await web.close(); if (reserved.server.listening) await reserved.close(); }
}));

test('incomplete identity never binds and revocation closes a previously observed listener', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, store, identity, fake } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  const reserved = await reservePort(); await reserved.close();
  await new ServerConfigStore(home).update((c) => ({ ...c, linearWebhook: reserved.address }));
  const transport = new LinearMessageTransport(home, { error() {} });
  try {
    await store.update((f) => ({ ...f, installation: { ...install, signingSecret: '' } }));
    await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await identity.status()).listenerStatus?.state === 'stopped');
    await assert.rejects(unsignedPost(reserved.address.port));
    await store.update((f) => ({ ...f, installation: { ...install } }));
    await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await identity.status()).listenerStatus?.state === 'listening');
    await identity.revoke(install.id); await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await identity.status()).listenerStatus?.state === 'stopped');
    assert.equal((await identity.status()).state, 'revoked'); await assert.rejects(unsignedPost(reserved.address.port));
  } finally { await transport.stop(); }
}));

test('refresh observes the actual closed socket rather than a retained app handle', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, identity, fake } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  const reserved = await reservePort(); await reserved.close();
  await new ServerConfigStore(home).update((c) => ({ ...c, linearWebhook: reserved.address }));
  const transport = new LinearMessageTransport(home, { error() {} });
  try {
    await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await identity.status()).listenerStatus?.state === 'listening');
    const app = (transport as unknown as { app: { close(): Promise<void> } }).app;
    await app.close(); await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await identity.status()).listenerStatus?.state === 'stopped');
    await assert.rejects(unsignedPost(reserved.address.port));
  } finally { await transport.stop(); }
}));

for (const [code, reason] of [['EACCES', 'permission_denied'], ['EPERM', 'permission_denied'], ['EADDRNOTAVAIL', 'address_unavailable'], ['ENOTFOUND', 'address_unavailable'], ['EAI_AGAIN', 'address_unavailable'], ['EOTHER', 'other']] as const) {
  test(`bind ${code} exposes only coarse reason ${reason}`, async (t) => withTempAnimaHome(async (home) => {
    const { agentStore, identity } = await seedLinear(home);
    const address = { host: '127.0.0.1', port: 14175 };
    await new ServerConfigStore(home).update((c) => ({ ...c, linearWebhook: address }));
    const logs: string[] = []; const transport = new LinearMessageTransport(home, { error: (message: string) => logs.push(message) });
    const app = transport.buildApp(); t.mock.method(transport, 'buildApp', () => app);
    t.mock.method(app, 'listen', async () => { throw Object.assign(new Error('synthetic-private-bind-error-sentinel'), { code }); });
    try {
      await transport.reconcile([await agentStore.read()]);
      await waitFor(async () => (await identity.status()).listenerStatus?.state === 'failed');
      const status = await identity.status(); assert.equal(status.listenerStatus?.reason, reason);
      assert.doesNotMatch(JSON.stringify([status, logs, await new LinearListenerStore(home).read()]), /sentinel|Error:|stack/);
      assert.equal(status.state, 'connected');
    } finally { await transport.stop(); }
  }));
}

test('missing, unreadable, expired, future, exited-process and changed-address observations are unknown', async () => withTempAnimaHome(async (home) => {
  const { identity } = await seedLinear(home);
  const address = { host: '127.0.0.1', port: 14175 };
  await new ServerConfigStore(home).update((c) => ({ ...c, linearWebhook: address }));
  const store = new LinearListenerStore(home);
  const unknown = async () => { const status = await identity.status(); assert.equal(status.state, 'connected'); assert.deepEqual(status.listenerStatus, { state: 'unknown' }); };
  await unknown();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']); const exitedPid = child.pid!; await once(child, 'exit');
  for (const patch of [
    { observedAt: new Date(Date.now() - 90_000).toISOString() },
    { observedAt: new Date(Date.now() + 30_000).toISOString() },
    { processId: exitedPid },
    { address: { ...address, port: address.port + 1 } },
    { address: { ...address, host: 'localhost' } },
  ]) {
    await store.write({ state: 'listening', address, observedAt: new Date().toISOString(), processId: process.pid, ...patch });
    await unknown();
  }
  await store.write({ state: 'listening', address, observedAt: new Date().toISOString(), processId: process.pid });
  assert.equal((await identity.status()).listenerStatus?.state, 'listening');
  await new ServerConfigStore(home).update((c) => ({ ...c, linearWebhook: { ...address, port: address.port + 2 } })); await unknown();
  await mkdir(join(home, 'run'), { recursive: true }); await writeFile(join(home, 'run/linear-listener.json'), '{synthetic-private-sentinel'); await unknown();
}));

test('a slow observation write never blocks bind or intake and coalesces the latest pending fact', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, identity, fake } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  const reserved = await reservePort(); await reserved.close();
  await new ServerConfigStore(home).update((c) => ({ ...c, linearWebhook: reserved.address }));
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const write = LinearListenerStore.prototype.write; let writes = 0;
  t.mock.method(LinearListenerStore.prototype, 'write', async function (this: LinearListenerStore, observation: Parameters<typeof write>[0]) {
    writes++; if (writes === 1) await gate; return write.call(this, observation);
  });
  const transport = new LinearMessageTransport(home, { error() {} });
  let reconciliation: Promise<void> | undefined;
  try {
    reconciliation = transport.reconcile([await agentStore.read()]);
    await withTimeout(reconciliation, 500);
    assert.equal(await unsignedPost(reserved.address.port), 403);
    assert.equal(await withTimeout(acceptedPost(reserved.address.port), 500), 200);
    assert.equal((await new WakeQueueService('scout').list()).length, 1);
    for (let n = 0; n < 4; n++) await transport.reconcile([await agentStore.read()]);
    assert.equal(writes, 1); release();
    await waitFor(async () => (await identity.status()).listenerStatus?.state === 'listening');
    assert.equal(writes, 2, 'slow write retains one latest pending observation');
    await waitFor(() => fake.posts.length === 1);
  } finally { release(); await reconciliation; await transport.stop(); }
}));

test('observation write failure leaves unknown without failing binding, intake or later recovery', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, identity, fake } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  const reserved = await reservePort(); await reserved.close();
  await new ServerConfigStore(home).update((c) => ({ ...c, linearWebhook: reserved.address }));
  const failure = t.mock.method(LinearListenerStore.prototype, 'write', async () => { throw new Error('synthetic-private-write-sentinel'); });
  const logs: string[] = []; const transport = new LinearMessageTransport(home, { error: (message: string) => logs.push(message) });
  try {
    await transport.reconcile([await agentStore.read()]); assert.equal(await unsignedPost(reserved.address.port), 403);
    assert.equal(await acceptedPost(reserved.address.port), 200);
    assert.equal((await new WakeQueueService('scout').list()).length, 1);
    assert.deepEqual((await identity.status()).listenerStatus, { state: 'unknown' });
    assert.doesNotMatch(JSON.stringify(logs), /sentinel/);
    failure.mock.restore(); await transport.reconcile([await agentStore.read()]);
    await waitFor(async () => (await identity.status()).listenerStatus?.state === 'listening');
    await waitFor(() => fake.posts.length === 1);
  } finally { await transport.stop(); }
}));
