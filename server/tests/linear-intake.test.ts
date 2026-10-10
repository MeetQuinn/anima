import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonFile } from '../storage/json-file.js';
import { LinearSessionService } from '../linear/session.service.js';
import { LinearDiagnosticsStore } from '../storage/schema/linear-diagnostics.store.js';
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
    await waitFor(async () => (await identity.status()).signatureFailures === 2, { timeoutMs: 3000 });
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

for (const matching of [false, true]) test(`unsigned claims use a bounded small journal, matching=${matching}`, async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, agentStore, store, identity } = await seedLinear(home);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const event = created(); event.promptContext = 'Synthetic large context. '.repeat(3000);
  await service.receive(event, install); await service.tick();
  const realNow = Date.now.bind(Date); let offset = 0; t.mock.method(Date, 'now', () => realNow() + offset);
  const port = await unusedPort(); await new ServerConfigStore().update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  let ticks = 0;
  const tick = LinearSessionService.prototype.tick;
  t.mock.method(LinearSessionService.prototype, 'tick', async function (this: LinearSessionService) {
    await tick.call(this); ticks++;
  });
  const transport = new LinearMessageTransport(home, { error() {} });
  const app = transport.buildApp();
  try {
    await transport.reconcile([await agentStore.read()]); await waitFor(() => ticks === 1);
    const journalPath = join(home, 'agents/scout/linear.json');
    const journal = await readFile(journalPath);
    assert.ok(journal.byteLength > 50_000);
    let credentialWrites = 0, diagnosticWrites = 0;
    const update = JsonFile.prototype.update;
    t.mock.method(JsonFile.prototype, 'update', function (this: JsonFile<unknown>, op: Parameters<JsonFile<unknown>['update']>[0]) {
      return update.call(this, async (file) => {
        const next = await op(file);
        if (next !== file && this.path.endsWith('/linear.json')) credentialWrites++;
        if (next !== file && this.path.endsWith('/linear-diagnostics.json')) diagnosticWrites++;
        return next;
      });
    });
    const rejectBurst = async (count: number) => {
      for (let n = 0; n < count; n++) {
        const result = await app.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ oauthClientId: matching ? install.clientId : 'unknown-client' }) });
        assert.equal(result.statusCode, 403);
      }
    };
    await rejectBurst(100);
    const before = ticks; await waitFor(() => ticks > before, { timeoutMs: 3000 });
    if (matching) await waitFor(async () => (await identity.status()).signatureFailures === 100);
    assert.equal(diagnosticWrites, matching ? 1 : 0);
    await rejectBurst(80);
    const second = ticks; await waitFor(() => ticks > second, { timeoutMs: 3000 });
    assert.equal(diagnosticWrites, matching ? 1 : 0, 'A burst must not trigger another write inside the one-minute window');
    assert.equal((await identity.status()).signatureFailures, matching ? 100 : 0);
    offset += 60_001;
    const third = ticks; await waitFor(() => ticks > third, { timeoutMs: 3000 });
    if (matching) await waitFor(async () => (await identity.status()).signatureFailures === 180);
    assert.equal(diagnosticWrites, matching ? 2 : 0);
    assert.equal(credentialWrites, 0); assert.deepEqual(await readFile(journalPath), journal);
    assert.equal((await new WakeQueueService('scout').list()).length, 1);
    if (matching) {
      const path = join(home, 'agents/scout/linear-diagnostics.json');
      const diagnostic = await readFile(path, 'utf8');
      assert.ok(Buffer.byteLength(diagnostic) < 150); assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.doesNotMatch(diagnostic, /access|refresh|secret|Synthetic large context/);
    }
    await rejectBurst(7);
    await identity.remove(); await transport.reconcile([await agentStore.read()]);
    const countAfterRemoval = diagnosticWrites;
    await app.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ oauthClientId: install.clientId }) });
    await transport.stop();
    assert.equal(diagnosticWrites, countAfterRemoval); assert.equal((await identity.status()).signatureFailures, 0);
    assert.equal((await new LinearDiagnosticsStore('scout').read()).signatureFailures, matching ? 180 : 0);
    await store.update((file) => ({ ...file, installation: { ...install, id: 'replacement-installation' } }));
    assert.equal((await identity.status()).signatureFailures, 0, 'New installation must not inherit old diagnostic counts');
  } finally { await app.close(); await transport.stop(); }
}));
