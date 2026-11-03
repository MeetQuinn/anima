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
import { isClaimableQueuedInboxItem, isHeldInboxItem, LinearNotificationInboxItem } from '../../shared/inbox.js';
import { listRestartBlockers } from '../services/restart-gate.js';
import { isStopped } from '../linear/receipt-state.js';

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
  // The thread root's author and whether this app has replied in that thread.
  // null: a top-level comment with no thread above it.
  let thread: { rootAuthor: string | null; replied: boolean } | null = { rootAuthor: humanId, replied: false };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    assert.deepEqual(linearQueryErrors(query), []);
    calls.push(query);
    if (query.includes('comment(id:')) {
      if (fail) throw new Error('Synthetic unavailable');
      assert.equal(variables.app, install.appUserId);
      const parent = thread || app ? { agentSession: app ? { appUser: { id: app } } : null,
        user: thread?.rootAuthor ? { id: thread.rootAuthor } : null, children: { nodes: thread?.replied ? [{ id: randomUUID() }] : [] } } : null;
      return Response.json({ data: { comment: { id: variables.id, issueId, agentSession: null, parent } } });
    }
    return seeded.fake.fetch(url, init);
  };
  const identity = new LinearIdentityService('scout', new LinearClient(fetcher), seeded.store);
  return { ...seeded, identity, notifications: new LinearNotificationService(identity), calls, fetcher,
    setSession: (id: string | null) => { app = id; }, setFailure: (value: boolean) => { fail = value; },
    setThread: (value: typeof thread) => { thread = value; } };
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
  const item = (await queue.list())[0]!; assert.match(buildCodeAgentDeliveryPrompt(item), /\n\[time=[^\]]+\] Linear team access changed\. All public teams: no\.\n[^]*wake=permissions /);
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
    // A reply in a thread this agent started wakes it.
    f.setThread({ rootAuthor: install.appUserId, replied: false });
    const event = notification(); await f.notifications.receive(verified(event), install);
    await waitFor(() => calls.length === 2); await waitFor(async () => (await queue.list()).length === 0);
    assert.equal(calls[1]!.providerSession?.id, 'same-primary-session');
    assert.match(calls[1]!.prompt, /Linear conversation update/);
    assert.match(calls[1]!.prompt, new RegExp(`\\[issue=SYN-1 comment_id=${event.notification.commentId} time=`));
    assert.match(calls[1]!.prompt, /issue=SYN-1 wake=comment /);
    assert.doesNotMatch(calls[1]!.prompt, /session_id=|issue_id=|Synthetic discussion/);
    await f.service.tick();
    assert.equal(f.fake.posts.length, 0); assert.deepEqual((await f.store.read()).receipts, {});
    // A work session the agent leaves unanswered gets only its receipt from the runtime.
    await f.service.receive(created(), install);
    await waitFor(async () => Object.values((await f.store.read()).receipts).some((r) => r.state === 'awaiting'));
    await f.service.tick();
    assert.deepEqual(f.fake.posts.map((p) => p.content.body), ['Received by Anima.']);
  } finally { await runner.stop(); }
}));

function permissionChange(): Extract<LinearWebhook, { type: 'PermissionChange' }> {
  return { type: 'PermissionChange', action: 'teamAccessChanged', organizationId: install.organizationId, oauthClientId: install.clientId,
    appUserId: install.appUserId, webhookTimestamp: Date.now(), createdAt: new Date().toISOString(), canAccessAllPublicTeams: false,
    addedTeamIds: [randomUUID()], removedTeamIds: [] };
}

test('only requests addressed to the agent wake it; other Linear events wait for its next run', async (t) => withTempAnimaHome(async (home) => {
  const f = await fixture(home); t.mock.method(globalThis, 'fetch', f.fetcher);
  const prompts: string[] = [];
  const runtime = { kind: 'synthetic', async run(input: AgentRuntimeInput) { prompts.push(input.prompt); return { text: 'Noted' }; },
    async appendToActiveRun() { return { accepted: false }; }, async close() {} };
  const queue = new WakeQueueService('scout');
  const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home,
    homePath: (await f.agentStore.read()).homePath!, runtimeEnv: {}, runLimiter: new TeamRunLimiter(1) });
  try {
    f.setThread(null); const topLevel = notification();
    await f.notifications.receive(verified(topLevel), install);
    f.setThread({ rootAuthor: humanId, replied: false }); const otherThread = notification();
    await f.notifications.receive(verified(otherThread), install);
    for (const type of ['issueStatusChanged', 'issueUnassignedFromYou']) await f.notifications.receive(verified(notification(type)), install);
    await f.notifications.receive(verified(permissionChange()), install);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(prompts.length, 0, 'Events not addressed to the agent must not wake it');
    const held = await queue.list();
    assert.equal(held.length, 5); assert.ok(held.every(isHeldInboxItem));
    assert.equal(await runner.hasPendingItems(), false, 'Held context is not pending work');
    assert.deepEqual(await listRestartBlockers(), [], 'Held context must not block a restart');

    // A reply in a thread the agent joined wakes it, and the held context follows in that work.
    f.setThread({ rootAuthor: humanId, replied: true }); const joined = notification();
    await f.notifications.receive(verified(joined), install);
    await waitFor(async () => (await queue.list()).length === 0);
    assert.equal(prompts.length, 6);
    assert.match(prompts[0]!, new RegExp(`comment_id=${joined.notification.commentId}`));
    for (const event of [topLevel, otherThread]) assert.ok(prompts.some((p) => p.includes(`comment_id=${event.notification.commentId}`)));
    for (const wake of ['status', 'unassigned', 'permissions']) assert.ok(prompts.some((p) => p.includes(`wake=${wake} `)));
  } finally { await runner.stop(); }
}));

test('context arriving during a run joins it instead of waiting, and a claim releases held context', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  await f.notifications.receive(verified(notification('issueStatusChanged')), install);
  const [early] = await queue.list(); assert.ok(early && isHeldInboxItem(early));
  assert.equal(await queue.takeNextRunnable({ workerId: 'w1', isWorkerAlive: () => true }), undefined, 'Held context never starts a run');
  // A scheduled memory pass is not the agent waking for work.
  const at = new Date().toISOString();
  await queue.enqueue({ id: 'memory-coherence:scout:synthetic', kind: 'memory_coherence', receivedAt: at, scheduledSlotAt: at,
    scheduledSlotLabel: '05:02 agent-local', handling: { createdAt: at, queuedAt: at, status: 'queued', updatedAt: at } });
  const pass = await queue.takeNextRunnable({ workerId: 'w0', isWorkerAlive: () => true });
  assert.equal(pass?.kind, 'memory_coherence'); assert.ok(isHeldInboxItem((await queue.find(early!.id))!));
  await f.notifications.receive(verified(notification('issueStatusChanged')), install);
  assert.equal((await queue.list()).filter(isHeldInboxItem).length, 2, 'Context during a memory pass still waits');
  await queue.complete(pass!.id);
  await queue.enqueue(makeSlackEvent({ eventId: 'slack-wake', channelId: 'D-synthetic', userId: 'U-synthetic', ts: '1770000030.000001', text: 'Hi', teamId: 'T-synthetic' }));
  const claimed = await queue.takeNextRunnable({ workerId: 'w1', isWorkerAlive: () => true });
  assert.equal(claimed?.kind, 'slack');
  const released = await queue.find(early!.id);
  assert.equal(isHeldInboxItem(released!), false); assert.equal(isClaimableQueuedInboxItem(released!), true);
  await f.notifications.receive(verified(notification('issueUnassignedFromYou')), install);
  const during = (await queue.list()).find((item) => item.kind === 'linear_notification' && (item as { notificationType?: string }).notificationType === 'issueUnassignedFromYou');
  assert.ok(during); assert.equal(isHeldInboxItem(during!), false, 'A running agent takes new context as a follow-up');
  const followups = await queue.takeFollowupBatch({ activeItemId: claimed!.id, limit: 16, workerId: 'w1' });
  assert.equal(followups.length, 3, 'Both held items and the new context join the run');
  assert.ok(followups.some((item) => item.id === early!.id) && followups.some((item) => item.id === during!.id));
}));

test('a late mention of a held comment delivers the request as it now reads', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const ordinary = notification(); ordinary.notification.comment!.body = 'OLD_FYI_NO_REQUEST';
  await f.notifications.receive(verified(ordinary), install);
  const [held] = await queue.list(); assert.ok(held && isHeldInboxItem(held));
  const later = new Date(Date.now() + 60_000).toISOString();
  const mention = notification('issueCommentMention');
  mention.notification = { ...mention.notification, commentId: ordinary.notification.commentId, updatedAt: later,
    comment: { ...ordinary.notification.comment!, body: '@scout NEW_REQUEST_FIX_THIS' } };
  await f.notifications.receive(verified(mention), install);
  const [item] = await queue.list();
  assert.equal((await queue.list()).length, 1); assert.equal(item!.id, held!.id);
  assert.equal(isClaimableQueuedInboxItem(item!), true);
  assert.equal(item!.handling.queuedAt, held!.handling.queuedAt, 'The request keeps its queue position');
  assert.ok(item!.kind === 'linear_notification');
  assert.equal(item!.notificationType, 'issueCommentMention'); assert.equal(item!.sourceTime, later);
  const prompt = buildCodeAgentDeliveryPrompt(item!);
  assert.match(prompt, /NEW_REQUEST_FIX_THIS/); assert.doesNotMatch(prompt, /OLD_FYI_NO_REQUEST/);
  assert.match(prompt, /wake=mention /);
  // Once delivered, the comment stays deduplicated.
  await queue.complete(item!.id);
  await f.notifications.receive(verified({ ...mention, notification: { ...mention.notification, id: randomUUID() } }), install);
  assert.equal((await queue.list()).length, 0);
}));

for (const failFirst of [false, true]) test(`a session on a held comment delivers its own request, failFirst=${failFirst}`, async (t) => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const ordinary = notification();
  await f.notifications.receive(verified(ordinary), install);
  const [held] = await queue.list(); assert.ok(held && isHeldInboxItem(held));
  const session = verified(sessionFor(ordinary));
  if (failFirst) {
    const enqueue = t.mock.method(WakeQueueService.prototype, 'enqueue', async () => { throw new Error('Synthetic disk unavailable'); });
    await assert.rejects(f.service.receive(session, install));
    enqueue.mock.restore();
    assert.ok(isHeldInboxItem((await queue.find(held!.id))!), 'The comment is kept until the session request is durable');
  }
  await f.service.receive(session, install);
  const items = await queue.list();
  assert.deepEqual(items.map((item) => item.kind), ['linear'], 'The session request replaces the undelivered comment');
  const receipt = Object.values((await f.store.read()).receipts)[0]!;
  assert.equal(receipt.itemId, items[0]!.id); assert.equal(receipt.commentItemId, undefined);
  await f.notifications.receive(verified({ ...ordinary, notification: { ...ordinary.notification, id: randomUUID() } }), install);
  assert.equal((await queue.list()).length, 1, 'Retries of the comment do not deliver it again');
}));

for (const stopCarriesComment of [false, true]) test(`a Stop before the session settles its held comment for good, stopCarriesComment=${stopCarriesComment}`, async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const ordinary = notification();
  await f.notifications.receive(verified(ordinary), install);
  const commentItemId = linearCommentItemId(install.id, ordinary.notification.commentId!);
  const session = sessionFor(ordinary), stop = prompted(session.agentSession.id, true);
  if (stopCarriesComment) stop.agentSession = { ...stop.agentSession, commentId: ordinary.notification.commentId, issueId };
  await f.service.receive(verified(stop), install);
  await f.service.receive(verified(session), install);
  assert.equal((await queue.list()).length, 0, 'The stopped request is not delivered');
  assert.equal(await queue.has(commentItemId), true);
  const receipts = Object.values((await f.store.read()).receipts);
  assert.ok(receipts.every((r) => isStopped(r) && !r.itemId));
  assert.deepEqual(receipts.map((r) => r.kind).sort(), ['comment', 'stop']);
  assert.ok(receipts.some((r) => r.commentItemId === commentItemId));
  const mention = notification('issueCommentMention');
  mention.notification = { ...mention.notification, commentId: ordinary.notification.commentId, comment: ordinary.notification.comment! };
  await f.notifications.receive(verified(mention), install);
  assert.equal((await queue.list()).length, 0, 'A late mention cannot wake a stopped request');
}));

for (const failAt of ['enqueue', 'withdrawHeld'] as const) for (const stopCarriesComment of [false, true]) test(`a Stop after a takeover fails midway still settles the held comment, failAt=${failAt}, stopCarriesComment=${stopCarriesComment}`, async (t) => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const ordinary = notification();
  await f.notifications.receive(verified(ordinary), install);
  const commentItemId = linearCommentItemId(install.id, ordinary.notification.commentId!);
  const session = sessionFor(ordinary);
  const fault = t.mock.method(WakeQueueService.prototype, failAt, async () => { throw new Error('Synthetic persistence fault'); });
  await assert.rejects(f.service.receive(verified(session), install), /Synthetic persistence fault/);
  fault.mock.restore();
  const replaced = (await queue.find(commentItemId))!;
  assert.ok(isHeldInboxItem(replaced));
  const stop = prompted(session.agentSession.id, true);
  if (stopCarriesComment) stop.agentSession = { ...stop.agentSession, commentId: ordinary.notification.commentId, issueId };
  await f.service.receive(verified(stop), install);
  await f.service.receive(verified(session), install);
  assert.equal((await queue.list()).length, 0, 'Neither the session request nor the replaced comment survives the Stop');
  assert.equal(await queue.has(commentItemId), true);
  assert.ok(replaced.kind === 'linear_notification');
  await assert.rejects(f.notifications.assertRunnable(replaced), /stopped/, 'A copy already in a run cannot start either');
  const mention = notification('issueCommentMention');
  mention.notification = { ...mention.notification, commentId: ordinary.notification.commentId, comment: ordinary.notification.comment! };
  await f.notifications.receive(verified(mention), install);
  assert.equal(await queue.takeNextRunnable({ workerId: 'w0', isWorkerAlive: () => true }), undefined, 'A late mention cannot wake a stopped request');
}));

test('a Stop after a session took over a held comment stops the session request', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const ordinary = notification();
  await f.notifications.receive(verified(ordinary), install);
  const session = sessionFor(ordinary);
  await f.service.receive(verified(session), install);
  assert.deepEqual((await queue.list()).map((item) => item.kind), ['linear']);
  const stop = prompted(session.agentSession.id, true);
  stop.agentSession = { ...stop.agentSession, commentId: ordinary.notification.commentId, issueId };
  await f.service.receive(verified(stop), install);
  assert.equal((await queue.list()).length, 0);
  const receipts = Object.values((await f.store.read()).receipts);
  assert.ok(receipts.every((r) => isStopped(r) && !r.commentItemId));
  // The notice covers both the stopped request and the Stop itself.
  assert.deepEqual(receipts.map((r) => `${r.kind}:${r.state}`).sort(), ['request:stopped', 'stop:confirmed']);
  assert.deepEqual(f.fake.posts.filter((p) => p.content.type === 'error').map((p) => p.content.body), ['Stopped the pending request. Check any earlier actions before continuing.']);
}));

test('real work joining a memory pass releases held context and takes new context', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  await f.notifications.receive(verified(notification('issueStatusChanged')), install);
  const [early] = await queue.list(); assert.ok(early && isHeldInboxItem(early));
  const at = new Date().toISOString();
  await queue.enqueue({ id: 'memory-coherence:scout:synthetic', kind: 'memory_coherence', receivedAt: at, scheduledSlotAt: at,
    scheduledSlotLabel: '05:02 agent-local', handling: { createdAt: at, queuedAt: at, status: 'queued', updatedAt: at } });
  const pass = await queue.takeNextRunnable({ workerId: 'w0', isWorkerAlive: () => true });
  assert.equal(pass?.kind, 'memory_coherence');
  await queue.enqueue(makeSlackEvent({ eventId: 'slack-real', channelId: 'D-synthetic', userId: 'U-synthetic', ts: '1770000040.000001', text: 'Real request', teamId: 'T-synthetic' }));
  const real = await queue.takeFollowupBatch({ activeItemId: pass!.id, limit: 16, workerId: 'w0' });
  assert.deepEqual(real.map((item) => item.kind), ['slack']);
  assert.equal(isClaimableQueuedInboxItem((await queue.find(early!.id))!), true, 'Real work releases held context');
  await queue.markAppended({ itemId: real[0]!.id, parentItemId: pass!.id, workerId: 'w0' });
  await f.notifications.receive(verified(notification('issueUnassignedFromYou')), install);
  assert.equal((await queue.list()).filter(isHeldInboxItem).length, 0, 'Context during real work is not held');
  const context = await queue.takeFollowupBatch({ activeItemId: pass!.id, limit: 16, workerId: 'w0' });
  assert.deepEqual(context.map((item) => item.kind), ['linear_notification', 'linear_notification']);
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
  assert.match(prompt, /Synthetic follow-up to the proactive comment/);
  assert.match(prompt, new RegExp(`comment_id=${mention.notification.commentId}`));
  assert.match(prompt, /\] Synthetic teammate: Synthetic follow-up to the proactive comment\n/);
  assert.doesNotMatch(prompt, /session_id=|user_id=/);
  assert.match(prompt, /wake=mention /, 'A mention of a held comment delivers it as a mention');
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
    await f.service.tick();
    assert.equal(f.fake.posts.length, 1, 'A late session gets a receipt, not a second reply obligation');
    assert.equal(f.fake.posts[0]!.content.type, 'thought');
    assert.match(f.fake.posts[0]!.content.body, /Received by Anima\. .*original comment thread/);
    await f.service.tick(); assert.equal(f.fake.posts.length, 1);
  } else { assert.equal(item!.kind, 'linear'); assert.equal(receipt.itemId, item!.id); }
  await queue.complete(item!.id);
  await new LinearSessionService(f.identity).receive(verified(session), install);
  await new LinearNotificationService(f.identity).receive(verified(mention), install);
  assert.equal((await queue.list()).length, 0);
  // An actual later follow-up is separate input, not a duplicate of the root comment.
  await f.service.receive(verified(prompted(session.agentSession.id)), install);
  assert.equal((await queue.list()).length, 1);
}));

for (const running of [false, true]) for (const stopFirst of [false, true]) for (const acknowledged of [false, true]) test(`late session Stop reaches the comment delivery, running=${running}, stopFirst=${stopFirst}, acknowledged=${acknowledged}`, async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention'), session = sessionFor(mention);
  await f.notifications.receive(verified(mention), install);
  const [item] = await queue.list();
  if (running) await queue.takeNextRunnable({ workerId: 'synthetic', isWorkerAlive: () => true });
  const stop = prompted(session.agentSession.id, true); stop.agentSession.commentId = mention.notification.commentId;
  if (!stopFirst) await f.service.receive(verified(session), install);
  if (acknowledged && !stopFirst) await f.service.tick();
  await f.service.receive(verified(stop), install);
  if (stopFirst) await f.service.receive(verified(session), install);
  if (running) assert.ok((await queue.find(item!.id))!.handling.stopRequestedAt);
  else assert.equal((await queue.list()).length, 0);
  await assert.rejects(f.notifications.assertRunnable(item as Parameters<typeof f.notifications.assertRunnable>[0]), /stopped/);
  await f.notifications.receive(verified(mention), install); await f.service.receive(verified(session), install);
  assert.equal((await queue.list()).length, running ? 1 : 0);
  await f.service.tick();
  const ends = f.fake.posts.filter((p) => p.content.type === 'error');
  assert.equal(ends.length, 1);
  assert.match(ends[0]!.content.body, /Stop requested.*background work may still exist/);
  assert.equal(f.fake.posts.length, acknowledged && !stopFirst ? 2 : 1);
  await f.service.finishRun(item!.id, 'Interrupted');
  assert.equal(f.fake.posts.filter((p) => p.content.type === 'error').length, 1);
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
  assert.equal(f.fake.posts.length, 1); assert.equal(f.fake.posts[0]!.content.type, 'error');
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

test('late-session receipt is attempted once even if its response is lost', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention'), session = sessionFor(mention);
  await f.notifications.receive(verified(mention), install);
  await queue.complete((await queue.list())[0]!.id);
  await f.service.receive(verified(session), install);
  f.fake.loseResponse = true;
  await f.service.tick(); await f.service.tick();
  assert.equal(f.fake.posts.length, 1);
  assert.equal(f.fake.posts[0]!.content.type, 'thought');
  assert.equal(Object.values((await f.store.read()).receipts)[0]!.acknowledgement, 'unknown');
  assert.equal((await queue.list()).length, 0);
  await f.service.tick();
  assert.equal(f.fake.posts.length, 1);
}));

test('late-session Stop with a lost response reconciles its one write instead of repeating it', async () => withTempAnimaHome(async (home) => {
  const f = await fixture(home), queue = new WakeQueueService('scout');
  const mention = notification('issueCommentMention'), session = sessionFor(mention);
  await f.notifications.receive(verified(mention), install);
  await f.service.receive(verified(session), install);
  const stop = prompted(session.agentSession.id, true);
  f.fake.loseResponse = true;
  await assert.rejects(f.service.receive(verified(stop), install));
  assert.equal(f.fake.posts.length, 1); assert.equal(f.fake.posts[0]!.content.type, 'error');
  assert.equal(Object.values((await f.store.read()).operations)[0]!.state, 'unknown');
  f.fake.loseResponse = false;
  await f.service.tick(); await f.service.receive(verified(stop), install); await f.service.tick();
  assert.equal(f.fake.posts.length, 1); assert.equal((await queue.list()).length, 0);
  assert.equal(Object.values((await f.store.read()).operations)[0]!.state, 'accepted');
}));

// Each line is what happened, by whom; the issue key names the issue in both envelopes.
for (const [type, wake, line] of [
  ['issueCommentMention', 'mention', 'Synthetic teammate: Synthetic follow-up to the proactive comment'],
  ['issueNewComment', 'comment', 'Synthetic teammate: Synthetic follow-up to the proactive comment'],
  ['issueStatusChanged', 'status', 'Synthetic teammate changed the status of SYN-1'],
  ['issueUnassignedFromYou', 'unassigned', 'Synthetic teammate unassigned you from SYN-1'],
] as const) test(`a ${type} notification renders as wake=${wake}`, async (t) => withTempAnimaHome(async (home) => {
  const f = await fixture(home); t.mock.method(globalThis, 'fetch', f.fetcher);
  const event = notification(type);
  event.notification.updatedAt = '2026-11-03T18:00:00.123Z';
  if (wake === 'status' || wake === 'unassigned') { delete event.notification.commentId; delete event.notification.comment; }
  await f.notifications.receive(verified(event), install);
  const [item] = await new WakeQueueService('scout').list();
  assert.ok(item?.kind === 'linear_notification');
  assert.equal(item.issueKey, 'SYN-1');
  assert.equal(item.text, wake === 'mention' || wake === 'comment' ? 'Synthetic follow-up to the proactive comment' : line.replace('Synthetic teammate ', ''));
  item.handling.queuedAt = '2026-11-03T18:00:01.000Z'; item.handling.startedAt = '2026-11-03T18:00:02.000Z';
  const commentId = event.notification.commentId;
  assert.equal(buildCodeAgentDeliveryPrompt(item), [
    'Linear conversation update:',
    `[issue=SYN-1${commentId ? ` comment_id=${commentId}` : ''} time=2026-11-03T18:00:00Z] ${line}`,
    `Wake trigger:\n[platform=linear reply_to=${commentId ? `comment:${commentId}` : `issue:${issueId}`} issue=SYN-1 wake=${wake} queued_at=2026-11-03T18:00:01Z claimed_at=2026-11-03T18:00:02Z]`,
  ].join('\n\n'));
}));

test('notifications queued before the issue key was stored still render, with the key taken from the issue URL', () => {
  const at = '2026-10-03T01:02:03Z', root = randomUUID();
  const render = (notificationType: string, text: string, extra: Record<string, unknown> = {}) => buildCodeAgentDeliveryPrompt(LinearNotificationInboxItem.parse({
    id: `linear:${install.id}:notification:${randomUUID()}:${at}`, kind: 'linear_notification', installationId: install.id, organizationId: install.organizationId,
    notificationType, text, receivedAt: at, sourceTime: at, actorName: 'Synthetic teammate', issueId, issueUrl: 'https://linear.app/synthetic/issue/SYN-1/synthetic-discussion',
    handling: { status: 'queued', createdAt: at, updatedAt: at }, ...extra }));
  // Older items stored the issue title as their text; a status line is composed from the type instead.
  assert.equal(render('issueStatusChanged', 'SYN-1: Synthetic discussion'), `Linear conversation update:\n\n[issue=SYN-1 time=${at}] Synthetic teammate changed the status of SYN-1\n\n`
    + `Wake trigger:\n[platform=linear reply_to=issue:${issueId} issue=SYN-1 wake=status queued_at=${at}]`);
  assert.match(render('issueUnassignedFromYou', 'SYN-1: Synthetic discussion', { actorName: undefined }), /\] Someone unassigned you from SYN-1\n[^]* wake=unassigned /);
  // A stored comment keeps its old text, title included, and is answered at its thread root.
  const commentId = randomUUID();
  assert.equal(render('issueNewComment', 'SYN-1: Synthetic discussion\n\nOld body', { commentId, parentCommentId: root }),
    `Linear conversation update:\n\n[issue=SYN-1 comment_id=${commentId} time=${at}] Synthetic teammate: SYN-1: Synthetic discussion\n\nOld body\n\n`
    + `Wake trigger:\n[platform=linear reply_to=comment:${root} issue=SYN-1 wake=comment queued_at=${at}]`);
  // Without a key, the trigger still names the issue by id and the line names no key.
  assert.match(render('issueStatusChanged', '', { issueUrl: 'https://linear.app/synthetic/project/SYN-1' }),
    new RegExp(`\\[time=${at}\\] Synthetic teammate changed the status of the issue\\n[^]* issue=${issueId} wake=status `));
  assert.equal(render('teamAccessChanged', 'Linear team access changed.', { actorName: undefined, issueId: undefined, issueUrl: undefined }),
    `Linear conversation update:\n\n[time=${at}] Linear team access changed.\n\nWake trigger:\n[platform=linear wake=permissions queued_at=${at}]`);
});
