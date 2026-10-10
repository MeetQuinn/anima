import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTempAnimaHome } from './helpers/harness.js';
import { created, install, seedLinear, sessionId, prompted } from './helpers/linear.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { runtimeContextForItemId } from '../runtime/context.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { LinearSessionService } from '../linear/session.service.js';
import type { LinearStore } from '../storage/schema/linear.store.js';
import type { LinearInboxItem } from '../../shared/inbox.js';
import { linearQueryErrors } from './helpers/linear-schema.js';

async function firstItem() { return (await new WakeQueueService('scout').list())[0]! as LinearInboxItem; }

test('history reads select typed activity content; the API double rejects invalid GraphQL', async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  await service.receive(created(), install);
  await service.tick();
  const history = await service.read(sessionId);
  assert.deepEqual(history.activities.nodes[0]?.content, { type: 'thought', body: 'Received by Anima.' });
  assert.ok(linearQueryErrors('query { agentSession(id:"synthetic") { activities { nodes { content } } } }').length);
  assert.ok(linearQueryErrors('query { issue(id:"synthetic") { id }').length);
}));

test('created and consecutive prompts share the primary session, carry only new text and do not expose credentials', async () => withTempAnimaHome(async (home) => {
  const { service, fake, store } = await seedLinear(home);
  await service.receive(created(), install); await service.tick();
  const first = await firstItem(); await service.markStarted(first, first.id);
  const a = await runtimeContextForItemId(first.id, { agentId: 'scout', stateDir: home });
  const followup = prompted(); await service.receive(followup, install);
  const items = await new WakeQueueService('scout').list(); const second = items[1]! as LinearInboxItem;
  await service.markStarted(second, first.id);
  const b = await runtimeContextForItemId(second.id, { agentId: 'scout', stateDir: home });
  assert.equal(a.session.createdAt, b.session.createdAt);
  const prompt = buildCodeAgentDeliveryPrompt(second); assert.match(prompt, /Only this new prompt/); assert.doesNotMatch(prompt, /Synthetic request body/);
  assert.doesNotMatch(JSON.stringify([a.session, prompt]), /access-sentinel|refresh-sentinel|signing-secret/);
  const result = await service.respond(sessionId, 'elicitation', 'Which version?', first.id);
  const repeat = await service.respond(sessionId, 'elicitation', 'Which version?', first.id); assert.equal(repeat.activityId, result.activityId);
  assert.equal(fake.posts.filter((p) => p.content.type === 'elicitation').length, 1);
  assert.ok(Object.values((await store.read()).receipts).filter((r) => r.itemId).every((r) => r.answered));
  await assert.rejects(service.respond(randomUUID(), 'response', 'Wrong session', first.id));
}));

test('unknown accepted activity is reconciled before a newer prompt; an absent receipt never authorizes resend', async () => withTempAnimaHome(async (home) => {
  const { service, fake, identity } = await seedLinear(home);
  await service.receive(created(), install); const first = await firstItem(); await service.markStarted(first, first.id);
  fake.loseResponse = true; await assert.rejects(service.respond(sessionId, 'response', 'Done', first.id));
  assert.equal(fake.posts.length, 1);
  fake.loseResponse = false;
  const recovered = new LinearSessionService(identity);
  assert.equal((await recovered.respond(sessionId, 'response', 'Done', first.id)).activityId, fake.posts[0]!.id);
  assert.equal(fake.posts.length, 1);
  await recovered.receive(prompted(), install); const next = (await new WakeQueueService('scout').list())[1]!;
  await recovered.markStarted(next, 'new-run');
  fake.failMutation = true; await assert.rejects(recovered.respond(sessionId, 'response', 'Next', 'new-run'));
  fake.failMutation = false;
  await recovered.receive(prompted(), install);
  const before = fake.calls.length;
  await assert.rejects(recovered.respond(sessionId, 'response', 'Changed content', 'new-run'), /unknown/);
  assert.equal(fake.posts.length, 1);
  assert.ok(fake.calls.slice(before).every((c) => !c.query.startsWith('mutation')));
}));

test('accepted activity survives local bookkeeping failure without a second send', async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, store } = await seedLinear(home); await service.receive(created(), install);
  const first = await firstItem(); await service.markStarted(first, first.id);
  const update = store.update.bind(store);
  const mock = t.mock.method(store, 'update', async (op: Parameters<LinearStore['update']>[0]) => {
    if (fake.posts.length) throw new Error('synthetic-bookkeeping-secret');
    return update(op);
  });
  const result = await service.respond(sessionId, 'response', 'Accepted', first.id);
  assert.equal(result.bookkeeping, 'degraded'); assert.equal(fake.posts.length, 1);
  mock.mock.restore();
  const next = await service.respond(sessionId, 'response', 'Accepted', first.id);
  assert.equal(next.activityId, result.activityId); assert.equal(fake.posts.length, 1);
}));

test('heartbeat is truthful and stops on reply; a deferred wake stays active', async () => withTempAnimaHome(async (home) => {
  const { service, store, fake } = await seedLinear(home); await service.receive(created(), install); await service.tick();
  const first = await firstItem();
  const stale = async () => store.update((f) => ({ ...f, receipts: Object.fromEntries(Object.entries(f.receipts).map(([id, r]) => [id, { ...r, lastActivityAt: new Date(Date.now() - 11 * 60_000).toISOString(), lastStatusAttemptAt: undefined }])) }));
  await stale(); await service.tick(); assert.equal(fake.posts.at(-1)!.content.body, 'This request is queued.');
  const queue = new WakeQueueService('scout'); await queue.takeNextRunnable({ workerId: 'worker', isWorkerAlive: () => true }); await service.markStarted(first, first.id);
  await stale(); await service.tick(); assert.equal(fake.posts.at(-1)!.content.body, 'Executing this request.');
  await queue.requeue(first.id); await service.markSettled(first); assert.equal((await store.read()).receipts[first.id]!.settled, undefined);
  await service.respond(sessionId, 'response', 'Done', first.id); const count = fake.posts.length;
  await stale(); await service.tick(); assert.equal(fake.posts.length, count);
}));

test('stop settles only its queued session and blocks a stopped input before execution', async () => withTempAnimaHome(async (home) => {
  const { service, fake, store } = await seedLinear(home); await service.receive(created(), install); const first = await firstItem();
  const otherSession = randomUUID(); await service.receive(created(otherSession), install);
  const stop = prompted(sessionId, true);
  if (stop.type === 'AgentSessionEvent') stop.agentActivity!.content = undefined;
  await service.receive(stop, install);
  const queue = new WakeQueueService('scout'); assert.equal(await queue.find(first.id), undefined);
  assert.equal((await queue.list()).length, 1); assert.equal((await queue.list())[0]!.kind, 'linear');
  assert.equal(fake.posts.filter((p) => p.content.type === 'error').length, 1);
  assert.equal(fake.posts[0]!.agentSessionId, sessionId);
  await assert.rejects(service.assertRunnable(first));
  assert.ok(Object.values((await store.read()).receipts).filter((r) => r.sessionId === otherSession).every((r) => !r.stopped));
  await service.receive(prompted(), install); assert.equal((await queue.list()).length, 2);
}));

test('shared run stop targets the root and reports interruption after actual abort; unrelated queued work remains', async () => withTempAnimaHome(async (home) => {
  const { service, fake } = await seedLinear(home); await service.receive(created(), install); const root = await firstItem();
  const queue = new WakeQueueService('scout'); await queue.takeNextRunnable({ workerId: 'worker', isWorkerAlive: () => true }); await service.markStarted(root, root.id);
  const other = randomUUID(); await service.receive(created(other), install); const second = (await queue.list())[1]!;
  await service.markStarted(second, root.id);
  await service.receive(prompted(other, true), install);
  assert.ok((await queue.find(root.id))!.handling.stopRequestedAt); assert.equal(fake.posts.length, 0);
  await service.finishRun(root.id, 'This shared run was interrupted.');
  assert.equal(fake.posts.filter((p) => p.content.type === 'error').length, 2);
  assert.ok(fake.posts.every((p) => p.content.body === 'This shared run was interrupted.'));
}));

for (const state of ['unstarted', 'started', 'completed', 'canceled']) test(`issue state ${state} respects delegated ownership and human initiation`, async () => withTempAnimaHome(async (home) => {
  const { service, fake } = await seedLinear(home); const event = created();
  if (event.type === 'AgentSessionEvent') event.agentSession.issueId = randomUUID();
  fake.issueState = state; await service.receive(event, install); const item = await firstItem(); await service.markStarted(item, item.id);
  assert.equal(fake.calls.filter((c) => c.query.includes('issueUpdate')).length, state === 'unstarted' ? 1 : 0);
  assert.deepEqual(fake.calls.find((c) => c.query.includes('issueUpdate'))?.variables.input, state === 'unstarted' ? { stateId: 'started-state' } : undefined);
  fake.issueState = 'unstarted'; fake.issueDelegate = null; await service.markStarted(item, item.id);
  assert.equal(fake.calls.filter((c) => c.query.includes('issueUpdate')).length, state === 'unstarted' ? 1 : 0);
  await service.markStarted({ ...item, humanRequested: false }, item.id);
  assert.equal(fake.calls.filter((c) => c.query.includes('issueUpdate')).length, state === 'unstarted' ? 1 : 0);
}));

test('PR attachment is idempotent; stopped and revoked sessions cannot make authorized writes', async () => withTempAnimaHome(async (home) => {
  const { service, fake, identity } = await seedLinear(home); await service.receive(created(), install);
  await service.attach(sessionId, 'https://github.com/example/repo/pull/1'); await service.attach(sessionId, 'https://github.com/example/repo/pull/1');
  assert.equal(fake.links.length, 1);
  await identity.revoke(install.id);
  await assert.rejects(service.attach(sessionId, 'https://github.com/example/repo/pull/2'));
  await assert.rejects(identity.graphql(install.id, 'query { viewer { id } }', {}, z.unknown()));
  assert.equal(fake.links.length, 1);
  assert.equal((await identity.status()).state, 'revoked');
}));

test('accepted append ownership and heartbeat survive a slow notification store', async () => withTempAnimaHome(async (home) => {
  const { service, fake, store } = await seedLinear(home);
  await service.receive(created(), install);
  const root = await firstItem(); const queue = new WakeQueueService('scout');
  await queue.takeNextRunnable({ workerId: 'worker', isWorkerAlive: () => true });
  await service.markStarted(root, root.id);
  await service.respond(sessionId, 'response', 'Root finished its request', root.id);
  await service.receive(prompted(), install);
  const child = (await queue.list())[1]!;
  await queue.takeFollowupBatch({ activeItemId: root.id, limit: 1, workerId: 'worker' });
  await queue.markAppendedBatch({ itemIds: [child.id], parentItemId: root.id, workerId: 'worker' });
  assert.equal((await store.read()).receipts[child.id]!.runItemId, undefined);
  await store.update((f) => ({ ...f, receipts: { ...f.receipts, [child.id]: { ...f.receipts[child.id]!, acknowledgement: 'accepted', receivedAt: new Date(Date.now() - 11 * 60_000).toISOString() } } }));
  await service.tick(); assert.equal(fake.posts.at(-1)!.content.body, 'Executing this request.');
  await service.respond(sessionId, 'response', 'Accepted followup', root.id);
  assert.ok((await store.read()).receipts[child.id]!.answered);
}));

test('failed final notice cannot republish settled run inputs; a newer prompt stays independent', async () => withTempAnimaHome(async (home) => {
  const { service, fake, store } = await seedLinear(home); await service.receive(created(), install);
  const root = await firstItem(); await service.markStarted(root, root.id);
  await new WakeQueueService('scout').fail(root.id);
  fake.failMutation = true; await assert.rejects(service.finishRun(root.id, 'Failed'));
  assert.equal((await store.read()).receipts[root.id]!.settled, true);
  assert.equal((await store.read()).receipts[root.id]!.item, undefined);
  await service.tick(); assert.equal((await new WakeQueueService('scout').list()).length, 0);
  await assert.rejects(service.assertRunnable(root));
  await service.receive(prompted(), install);
  assert.equal((await new WakeQueueService('scout').list()).length, 1);
  assert.ok(Object.values((await store.read()).receipts).some((r) => !r.settled && r.item));
}));

test('accepted PR link survives bookkeeping failure and reconciles without another mutation', async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, store } = await seedLinear(home); await service.receive(created(), install);
  const update = store.update.bind(store);
  const mock = t.mock.method(store, 'update', async (op: Parameters<LinearStore['update']>[0]) => {
    if (fake.links.length) throw new Error('synthetic-local-failure');
    return update(op);
  });
  assert.equal((await service.attach(sessionId, 'https://github.com/example/repo/pull/1')).bookkeeping, 'degraded');
  assert.equal(fake.links.length, 1); mock.mock.restore();
  assert.equal((await service.attach(sessionId, 'https://github.com/example/repo/pull/1')).bookkeeping, 'recorded');
  assert.equal(fake.links.length, 1);
}));
