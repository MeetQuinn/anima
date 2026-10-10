import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { LinearMessageTransport } from '../transports/linear-message-transport.js';
import { verifyLinearWebhook } from '../linear/webhook.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { withTempAnimaHome, waitFor } from './helpers/harness.js';
import { created, install, seedLinear, prompted } from './helpers/linear.js';

async function unusedPort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
async function post(port: number, payload: unknown, signature?: string, path = '/webhook'): Promise<{ status: number; body: string }> {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }; if (signature) headers['linear-signature'] = signature;
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (response) => {
      let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body }));
    }); req.on('error', reject); req.end(raw);
  });
}
const sign = (event: unknown, secret = install.signingSecret) => createHmac('sha256', secret).update(JSON.stringify(event)).digest('hex');

test('dedicated port rejects unsigned, stale, cross-app and dashboard routes; accepted duplicate wakes once', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, fake, store, identity } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  const port = await unusedPort(); await new ServerConfigStore().update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  const transport = new LinearMessageTransport(home, { error() {} });
  try {
    await transport.reconcile([await agentStore.read()]);
    const event = created();
    assert.equal((await post(port, event)).status, 403);
    assert.equal((await post(port, event, sign(event, 'wrong-signing-secret'))).status, 403);
    for (const bad of [ { ...event, webhookTimestamp: Date.now() - 120_000 }, { ...event, appUserId: install.organizationId }, { ...event, organizationId: install.appUserId }, { ...event, oauthClientId: 'another-app-client' } ]) {
      assert.equal((await post(port, bad, sign(bad))).status, 403);
    }
    assert.equal((await post(port, event, sign(event), '/api/agents')).status, 404);
    assert.equal((await post(port, JSON.stringify({ padding: 'x'.repeat(270_000) }))).status, 413);
    assert.equal((await new WakeQueueService('scout').list()).length, 0);
    assert.equal((await post(port, event, sign(event))).status, 200);
    const formatted = JSON.stringify(event, null, 2);
    assert.equal((await post(port, formatted, createHmac('sha256', install.signingSecret).update(formatted).digest('hex'))).status, 200);
    assert.equal((await post(port, event, sign(event))).status, 200);
    await waitFor(() => fake.posts.length === 1);
    assert.equal(fake.posts[0]!.content.body, 'Received by Anima.');
    assert.equal(fake.posts[0]!.ephemeral, true);
    assert.equal((await new WakeQueueService('scout').list()).length, 1);
    assert.equal(Object.keys((await store.read()).receipts).length, 1);
    assert.ok((await identity.status()).lastSignedWebhookAt);
    assert.equal((await identity.status()).signatureFailures, 2);
    await agentStore.update((agent) => ({ ...agent, enabled: false }));
    const disabled = created(install.id);
    assert.equal((await post(port, disabled, sign(disabled))).status, 503);
    assert.equal(Object.keys((await store.read()).receipts).length, 1);
    await agentStore.update((agent) => ({ ...agent, enabled: true }));
    await identity.remove();
    assert.equal((await post(port, event, sign(event))).status, 403);
    await transport.reconcile([await agentStore.read()]);
    await assert.rejects(post(port, event, sign(event)));
    await transport.reconcile([await agentStore.read()]);
    await assert.rejects(post(port, event, sign(event)));
  } finally { await transport.stop(); }
}));

test('incomplete credentials never bind; durable receipt recovers a queue write failure once', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, fake, store, service } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  const port = await unusedPort(); await new ServerConfigStore().update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  await store.update((f) => ({ ...f, installation: undefined }));
  const transport = new LinearMessageTransport(home, { error() {} });
  try {
    await transport.reconcile([await agentStore.read()]); await assert.rejects(post(port, created()));
    await store.update((f) => ({ ...f, installation: install }));
    await transport.reconcile([await agentStore.read()]);
    const enqueue = t.mock.method(WakeQueueService.prototype, 'enqueue', async () => { throw new Error('synthetic-disk-write-failure'); });
    const event = created(); assert.equal((await post(port, event, sign(event))).status, 503);
    const receipt = Object.values((await store.read()).receipts)[0]!; assert.ok(receipt.item);
    assert.equal((await new WakeQueueService('scout').list()).length, 0);
    enqueue.mock.restore(); await service.tick(); await service.receive(event, install); await service.tick();
    assert.equal((await new WakeQueueService('scout').list()).length, 1); assert.equal(fake.posts.length, 1);
  } finally { await transport.stop(); }
}));

test('revocation and session/type consistency are enforced using signed identity, not routing hints', async (t) => withTempAnimaHome(async (home) => {
  const { agentStore, fake, identity } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  const port = await unusedPort(); await new ServerConfigStore().update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  const transport = new LinearMessageTransport(home, { error() {} });
  try {
    await transport.reconcile([await agentStore.read()]);
    const wrong = prompted(); if (wrong.type === 'AgentSessionEvent') wrong.agentActivity!.agentSessionId = install.id;
    assert.throws(() => verifyLinearWebhook(Buffer.from(JSON.stringify(wrong)), sign(wrong), install));
    assert.equal((await post(port, wrong, sign(wrong))).status, 403);
    const revoked = { type: 'OAuthApp', action: 'revoked', organizationId: install.organizationId, oauthClientId: install.clientId, webhookTimestamp: Date.now() };
    assert.equal((await post(port, revoked, sign(revoked))).status, 200);
    assert.equal((await identity.status()).state, 'revoked');
    assert.equal((await new WakeQueueService('scout').list()).length, 0);
    await transport.reconcile([await agentStore.read()]); await assert.rejects(post(port, created()));
  } finally { await transport.stop(); }
}));
