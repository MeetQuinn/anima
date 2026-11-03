import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { LinearNotificationService } from '../inbox/linear-notification.service.js';
import { linearCommentItemId } from '../inbox/linear-comment-delivery.js';
import { LinearSessionService } from '../linear/session.service.js';
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
import { created, prompted, install, seedLinear } from './helpers/linear.js';
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
  for (const type of ['issueMention', 'issueAssignedToYou', 'issueEmojiReaction', 'issueCommentReaction', 'futureUnknownType']) await f.notifications.receive(verified(notification(type)), install);
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

function sessionFor(event: ReturnType<typeof notification>) {
  const session = created(randomUUID());
  session.agentSession.commentId = event.notification.commentId;
  session.agentSession.issueId = issueId;
  session.agentSession.creatorId = null; // Other apps can create sessions too.
  session.agentSession.creator = null;
  return session;
}

for (const mentionFirst of [false, true]) test(`comment mentions share one durable delivery with ordinary notifications, mentionFirst=${mentionFirst}`, async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention');
  const ordinary = { ...mention, action: 'issueNewComment', notification: { ...mention.notification, id: randomUUID(), type: 'issueNewComment' } };
  const first = mentionFirst ? mention : ordinary, second = mentionFirst ? ordinary : mention;
  await f.notifications.receive(verified(first), install);
  await new LinearNotificationService(f.identity).receive(verified(second), install);
  const [item] = await queue.list();
  assert.equal((await queue.list()).length, 1);
  assert.equal(item!.id, linearCommentItemId(install.id, mention.notification.commentId!));
  assert.equal(item!.kind, 'linear_notification');
  const prompt = buildCodeAgentDeliveryPrompt(item!);
  assert.match(prompt, /requests directed to you/);
  assert.match(prompt, new RegExp(`--reply-to ${mention.notification.commentId}`));
  assert.match(prompt, /Acknowledgements and completion notices do not require another reply/);
  assert.match(prompt, /Existing Stop instructions still apply/);
  assert.doesNotMatch(prompt, /linear respond --session/);
  if (mentionFirst) assert.match(prompt, /Linear mention:/);
  await queue.complete(item!.id);
  await f.notifications.receive(verified(second), install);
  assert.equal((await queue.list()).length, 0);
  assert.deepEqual((await f.store.read()).receipts, {});
  assert.equal(f.fake.posts.length, 0);
}));

test('mentions filter self authors, archived notices and existing own sessions; lookup failures remain retryable', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const self = notification('issueCommentMention'); self.notification.comment!.userId = install.appUserId;
  await f.notifications.receive(verified(self), install);
  const archived = notification('issueCommentMention'); archived.notification.archivedAt = new Date().toISOString();
  await f.notifications.receive(verified(archived), install);
  assert.equal((await queue.list()).length, 0); assert.equal(f.calls.length, 0);
  const event = notification('issueCommentMention');
  f.setFailure(true); await assert.rejects(f.notifications.receive(verified(event), install));
  assert.equal((await queue.list()).length, 0);
  f.setFailure(false); f.setSession(install.appUserId); await f.notifications.receive(verified(event), install);
  assert.equal((await queue.list()).length, 0);
  f.setSession(randomUUID()); await f.notifications.receive(verified(event), install);
  assert.equal((await queue.list()).length, 1, 'Another app owning the thread must not swallow our mention');
}));

for (const order of ['session-first', 'notification-first', 'concurrent'] as const) test(`comment and session intake deduplicate with stale remote context: ${order}`, async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention'), session = sessionFor(mention);
  if (order === 'session-first') {
    await f.service.receive(verified(session), install);
    await f.notifications.receive(verified(mention), install);
  } else if (order === 'notification-first') {
    await f.notifications.receive(verified(mention), install);
    await f.service.receive(verified(session), install);
  } else {
    await Promise.all([f.notifications.receive(verified(mention), install), f.service.receive(verified(session), install)]);
  }
  const [item] = await queue.list(); assert.equal((await queue.list()).length, 1);
  const receipt = Object.values((await f.store.read()).receipts)[0]!;
  if (item!.kind === 'linear_notification') {
    assert.equal(receipt.commentItemId, item!.id); assert.equal(receipt.itemId, undefined);
    await f.service.tick(); await f.service.completeIdleRuns(async () => true);
    assert.equal(f.fake.posts.length, 0, 'A late session must not create a second reply obligation');
  } else { assert.equal(item!.kind, 'linear'); assert.equal(receipt.itemId, item!.id); }
  await queue.complete(item!.id);
  await new LinearSessionService(f.identity).receive(verified(session), install);
  await new LinearNotificationService(f.identity).receive(verified(mention), install);
  assert.equal((await queue.list()).length, 0);
  // An actual later follow-up is separate input, not a duplicate of the root comment.
  await f.service.receive(verified(prompted(session.agentSession.id)), install);
  assert.equal((await queue.list()).length, 1);
}));

for (const running of [false, true]) for (const stopFirst of [false, true]) test(`late session Stop reaches the comment delivery, running=${running}, stopFirst=${stopFirst}`, async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention'), session = sessionFor(mention);
  await f.notifications.receive(verified(mention), install);
  const [item] = await queue.list();
  if (running) await queue.takeNextRunnable({ workerId: 'synthetic', isWorkerAlive: () => true });
  const stop = prompted(session.agentSession.id, true); stop.agentSession.commentId = mention.notification.commentId;
  if (!stopFirst) await f.service.receive(verified(session), install);
  await f.service.receive(verified(stop), install);
  if (stopFirst) await f.service.receive(verified(session), install);
  if (running) assert.ok((await queue.find(item!.id))!.handling.stopRequestedAt);
  else assert.equal((await queue.list()).length, 0);
  await assert.rejects(f.notifications.assertRunnable(item as Parameters<typeof f.notifications.assertRunnable>[0]), /stopped/);
  await f.notifications.receive(verified(mention), install); await f.service.receive(verified(session), install);
  assert.equal((await queue.list()).length, running ? 1 : 0);
  await f.service.tick(); assert.equal(f.fake.posts.length, 0);
}));

test('a failed notification enqueue leaves session intake able to deliver once', async (t) => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention'), session = sessionFor(mention);
  const enqueue = t.mock.method(WakeQueueService.prototype, 'enqueue', async () => { throw new Error('Synthetic disk failure'); });
  await assert.rejects(f.notifications.receive(verified(mention), install));
  enqueue.mock.restore();
  await f.service.receive(verified(session), install);
  await f.notifications.receive(verified(mention), install);
  assert.equal((await queue.list()).length, 1);
  assert.equal((await queue.list())[0]!.kind, 'linear');
}));

test('Stop without a comment hint still stops a notification when its creation arrives later', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention'), session = sessionFor(mention);
  await f.notifications.receive(verified(mention), install);
  await f.service.receive(verified(prompted(session.agentSession.id, true)), install);
  assert.equal((await queue.list()).length, 1, 'The Stop cannot guess an unseen association');
  await f.service.receive(verified(session), install);
  assert.equal((await queue.list()).length, 0);
  await f.notifications.receive(verified(mention), install);
  assert.equal((await queue.list()).length, 0);
}));

test('legacy notification IDs still suppress a redelivery after upgrade', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const event = notification('issueNewComment');
  const now = new Date().toISOString();
  const key = `linear:${install.id}:notification:${event.notification.id}:${event.notification.commentId}`;
  await queue.enqueue({ id: key, kind: 'linear_notification', installationId: install.id, organizationId: install.organizationId,
    notificationType: event.action, receivedAt: now, text: 'Previously delivered comment',
    handling: { status: 'queued', createdAt: now, updatedAt: now, queuedAt: now } });
  await queue.complete(key);
  await f.notifications.receive(verified(event), install);
  assert.equal((await queue.list()).length, 0);
}));

test('a session racing a slow comment lookup cannot publish a second request', async (t) => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention'), session = sessionFor(mention);
  let entered!: () => void, release!: () => void;
  const lookupEntered = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const graphql = f.identity.graphql.bind(f.identity);
  t.mock.method(f.identity, 'graphql', async (...args: Parameters<typeof graphql>) => {
    entered(); await gate; return graphql(...args);
  });
  const incoming = f.notifications.receive(verified(mention), install);
  await lookupEntered;
  let sessionFinished = false;
  const other = f.service.receive(verified(session), install).then(() => { sessionFinished = true; });
  try {
    // With no comment lock the session can complete during this blocked lookup.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sessionFinished, false);
  } finally { release(); await Promise.all([incoming, other]); }
  assert.equal((await queue.list()).length, 1);
}));
