import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { LinearNotificationService } from '../inbox/linear-notification.service.js';
import { LinearClient } from '../linear/client.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { verifyLinearWebhook, type LinearWebhook } from '../linear/webhook.js';
import { LinearMessageTransport } from '../transports/linear-message-transport.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { startRunningAgent } from '../runtime/agent-runner.js';
import { runtimeContextForItemId } from '../runtime/context.js';
import { TeamRunLimiter } from '../runtime/team-run-limiter.js';
import type { AgentRuntimeInput } from '../providers/contract.js';
import { withTempAnimaHome, waitFor } from './helpers/harness.js';
import { created, install, seedLinear } from './helpers/linear.js';
import { linearQueryErrors } from './helpers/linear-schema.js';
import { makeSlackEvent } from './helpers/slack.js';

const issueId = randomUUID(), humanId = randomUUID();
function notification(type = 'issueNewComment'): Extract<LinearWebhook, { type: 'AppUserNotification' }> {
  const commentId = randomUUID();
  return { type: 'AppUserNotification', action: type, appUserId: install.appUserId,
    organizationId: install.organizationId, oauthClientId: install.clientId, webhookTimestamp: Date.now(),
    notification: { id: randomUUID(), type, userId: install.appUserId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      actorId: humanId, actor: { id: humanId, name: 'Synthetic teammate' }, issueId,
      issue: { id: issueId, identifier: 'SYN-1', title: 'Synthetic discussion', url: 'https://linear.app/synthetic/issue/SYN-1' },
      commentId, comment: { id: commentId, issueId, userId: humanId, body: 'Synthetic follow-up to the proactive comment' },
    },
  };
}
function verified<T extends LinearWebhook>(event: T): T {
  const raw = Buffer.from(JSON.stringify(event));
  return verifyLinearWebhook(raw, createHmac('sha256', install.signingSecret).update(raw).digest('hex'), install) as T;
}
async function fixture(home: string) {
  const seeded = await seedLinear(home);
  let app: string | null = null, fail = false;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    assert.deepEqual(linearQueryErrors(query), []);
    calls.push(query);
    if (query.includes('comment(id:')) {
      if (fail) throw new Error('Synthetic unavailable');
      return Response.json({ data: { comment: { id: variables.id, issueId, agentSession: null,
        parent: { agentSession: app ? { appUser: { id: app } } : null } } } });
    }
    return seeded.fake.fetch(url, init);
  };
  const identity = new LinearIdentityService('scout', new LinearClient(fetcher), seeded.store);
  return { ...seeded, identity, notifications: new LinearNotificationService(identity), calls, fetcher,
    setSession: (id: string | null) => { app = id; }, setFailure: (value: boolean) => { fail = value; } };
}

test('app notifications authenticate resources and enqueue once across retries, settlement and service recreation', async (t) => withTempAnimaHome(async (home) => {
  const f = await fixture(home); t.mock.method(globalThis, 'fetch', f.fetcher);
  const socket = createServer(); await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port; await new Promise<void>((resolve) => socket.close(() => resolve()));
  await new ServerConfigStore().update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  const transport = new LinearMessageTransport(home, { error() {} });
  const app = transport.buildApp();
  const event = notification();
  event.notification.parentCommentId = randomUUID();
  const send = (value: unknown, signed = true) => {
    const payload = JSON.stringify(value);
    return app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json',
      'linear-signature': signed ? createHmac('sha256', install.signingSecret).update(payload).digest('hex') : '0'.repeat(64) } });
  };
  try {
    await transport.reconcile([await f.agentStore.read()]);
    assert.equal((await send(event, false)).statusCode, 403);
    for (const bad of [ { ...event, appUserId: randomUUID() }, { ...event, organizationId: randomUUID() },
      { ...event, webhookTimestamp: Date.now() - 120_000 },
      { ...event, notification: { ...event.notification, userId: randomUUID() } },
      { ...event, notification: { ...event.notification, issueId: randomUUID() } },
      { ...event, notification: { ...event.notification, commentId: randomUUID() } },
      { ...event, notification: { ...event.notification, type: 'issueCommentReaction' } },
    ]) assert.equal((await send(bad)).statusCode, 403);
    assert.equal(f.calls.length, 0);
    const enqueue = t.mock.method(WakeQueueService.prototype, 'enqueue', async () => { throw new Error('Synthetic disk unavailable'); });
    assert.equal((await send(event)).statusCode, 503);
    enqueue.mock.restore();
    assert.equal((await send(event)).statusCode, 200);
    assert.equal((await send(event)).statusCode, 200);
    const queue = new WakeQueueService('scout');
    const [item] = await queue.list(); assert.equal(item?.kind, 'linear_notification');
    assert.equal((await queue.list()).length, 1);
    await queue.complete(item!.id);
    await new LinearNotificationService(f.identity).receive(verified(event), install);
    assert.equal((await queue.list()).length, 0);
    assert.deepEqual((await f.store.read()).receipts, {}); assert.equal(f.fake.posts.length, 0);
    const ledger = await messageServiceForAgent('scout').list();
    assert.equal(ledger.entries.length, 1); assert.equal(ledger.entries[0]?.channelId, issueId);
    assert.equal(ledger.entries[0]?.threadTs, event.notification.parentCommentId);
    assert.equal(ledger.entries[0]?.platform, 'linear');
  } finally { await app.close(); await transport.stop(); await (transport as unknown as { observationWrite?: Promise<void> }).observationWrite; }
}));

test('self, duplicate session and unsupported notifications do not wake; ordinary other-app threads remain visible', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  for (const type of ['issueMention', 'issueCommentMention', 'issueAssignedToYou', 'issueEmojiReaction', 'issueCommentReaction', 'futureUnknownType']) await f.notifications.receive(verified(notification(type)), install);
  const self = notification(); self.notification.actorId = install.appUserId; self.notification.actor = { id: install.appUserId, name: 'Me' };
  await f.notifications.receive(verified(self), install);
  const archived = notification(); archived.notification.archivedAt = new Date().toISOString(); await f.notifications.receive(verified(archived), install);
  assert.equal((await queue.list()).length, 0); assert.equal(f.calls.length, 0);
  f.setSession(install.appUserId); await f.notifications.receive(verified(notification()), install);
  assert.equal((await queue.list()).length, 0);
  const root = notification();
  f.setSession(randomUUID()); await f.notifications.receive(verified(root), install);
  assert.equal((await queue.list()).length, 1);
  assert.equal((await messageServiceForAgent('scout').list()).entries[0]?.threadTs, root.notification.commentId);
  for (const type of ['issueUnassignedFromYou', 'issueStatusChanged']) {
    const event = notification(type);
    event.notification.comment!.userId = install.appUserId;
    await f.notifications.receive(verified(event), install);
  }
  assert.equal((await queue.list()).length, 3);
  const retry = notification(); f.setFailure(true);
  await assert.rejects(f.notifications.receive(verified(retry), install)); assert.equal((await queue.list()).length, 3);
  f.setFailure(false); f.setSession(null); await f.notifications.receive(verified(retry), install);
  assert.equal((await queue.list()).length, 4);
  await f.agentStore.update((a) => ({ ...a, enabled: false }));
  await assert.rejects(f.notifications.receive(verified(notification()), install)); assert.equal((await queue.list()).length, 4);
}));

test('permission changes deliver bounded context without session obligations and ignore retry timestamps', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const event: Extract<LinearWebhook, { type: 'PermissionChange' }> = { type: 'PermissionChange', action: 'teamAccessChanged',
    organizationId: install.organizationId, oauthClientId: install.clientId, appUserId: install.appUserId, webhookTimestamp: Date.now(),
    createdAt: new Date().toISOString(), canAccessAllPublicTeams: false, addedTeamIds: [randomUUID(), randomUUID()], removedTeamIds: [randomUUID()] };
  await f.notifications.receive(verified(event), install);
  await f.notifications.receive(verified({ ...event, webhookTimestamp: Date.now() + 1000, addedTeamIds: [...event.addedTeamIds].reverse() }), install);
  assert.equal((await queue.list()).length, 1); assert.equal(f.calls.length, 0);
  const item = (await queue.list())[0]!; assert.match(buildCodeAgentDeliveryPrompt(item), /anima linear teams/);
  assert.doesNotMatch(buildCodeAgentDeliveryPrompt(item), /linear respond/);
  const config = { agentId: 'scout', stateDir: home };
  assert.equal((await runtimeContextForItemId(item.id, config)).item.id, item.id);
  assert.throws(() => verified({ ...event, removedTeamIds: ['not-an-id'] }));
  await f.store.update((s) => ({ ...s, installation: { ...s.installation!, revoked: true } }));
  await assert.rejects(f.notifications.receive(event, install));
  await assert.rejects(runtimeContextForItemId(item.id, config), /not authorized/);
  await f.store.update((s) => ({ ...s, installation: { ...s.installation!, revoked: false, id: randomUUID() } }));
  await assert.rejects(runtimeContextForItemId(item.id, config), /not authorized/);
}));

test('ordinary notifications share the Slack primary session and may finish silently without a Linear fallback', async (t) => withTempAnimaHome(async (home) => {
  const f = await fixture(home); t.mock.method(globalThis, 'fetch', f.fetcher);
  const calls: AgentRuntimeInput[] = [];
  const runtime = { kind: 'synthetic', async run(input: AgentRuntimeInput) {
    calls.push(input); await input.effects.persistProviderSession({ id: 'same-primary-session', updatedAt: new Date().toISOString() });
    return { text: 'No response needed' };
  }, async appendToActiveRun() { return { accepted: false }; }, async close() {} };
  const queue = new WakeQueueService('scout');
  await queue.enqueue(makeSlackEvent({ eventId: 'slack-control', channelId: 'D-synthetic', userId: 'U-synthetic', ts: '1770000020.000001', text: 'Discuss an issue', teamId: 'T-synthetic' }));
  const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home,
    homePath: (await f.agentStore.read()).homePath!, runtimeEnv: {}, runLimiter: new TeamRunLimiter(1) });
  try {
    await waitFor(async () => (await queue.list()).length === 0);
    const event = notification(); await f.notifications.receive(verified(event), install);
    await waitFor(() => calls.length === 2); await waitFor(async () => (await queue.list()).length === 0);
    assert.equal(calls[1]!.providerSession?.id, 'same-primary-session');
    assert.match(calls[1]!.prompt, /Linear notification/); assert.match(calls[1]!.prompt, /linear comment --issue/);
    assert.match(calls[1]!.prompt, /no automatic response is required/);
    await f.service.completeIdleRuns(async () => true); await f.service.tick();
    assert.equal(f.fake.posts.length, 0); assert.deepEqual((await f.store.read()).receipts, {});
    // An actual work request retains the existing missing-response fallback.
    await f.service.receive(created(), install); await waitFor(() => f.fake.posts.some((p) => p.content.type === 'error'));
    assert.equal(f.fake.posts.filter((p) => p.content.type === 'error').length, 1);
  } finally { await runner.stop(); }
}));
