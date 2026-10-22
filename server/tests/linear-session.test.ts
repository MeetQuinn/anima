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

async function settledRequest(service: LinearSessionService, session = sessionId) {
  await service.receive(created(session), install);
  const queue = new WakeQueueService('scout');
  const item = (await queue.list()).find((i) => i.kind === 'linear' && i.sessionId === session)!;
  await service.markStarted(item, item.id);
  await queue.complete(item.id); await service.markSettled(item);
  return item;
}

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

test('the status tick locks only sessions with pending work', async (t) => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  await service.receive(created(), install); const first = await firstItem(); await service.markStarted(first, first.id);
  await service.respond(sessionId, 'response', 'Done', first.id);
  const pending = randomUUID(); await service.receive(created(pending), install);
  await service.tick();
  const lock = t.mock.method(service as unknown as { sessionLock(id: string, op: () => Promise<unknown>): Promise<unknown> }, 'sessionLock');
  await service.tick();
  assert.deepEqual(lock.mock.calls.map((call) => call.arguments[0]), [pending]);
}));

test('a webhook drops receipts finished over 30 days ago and the operations of their sessions', async () => withTempAnimaHome(async (home) => {
  const { service, store } = await seedLinear(home);
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const receipt = (session: string, receivedAt: string, extra: object) => ({ sessionId: session, receivedAt, acknowledgement: 'accepted' as const, acknowledgementId: randomUUID(), itemId: randomUUID(), ...extra });
  const operation = (session: string) => ({ id: randomUUID(), sessionId: session, kind: 'activity' as const, state: 'accepted' as const, itemIds: [], contentHash: randomUUID() });
  const [expired, recent, active, unfinished, stopped] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await store.update((file) => ({ ...file,
    receipts: {
      expired: receipt(expired, daysAgo(31), { answered: true }),
      recent: receipt(recent, daysAgo(29), { settled: true }),
      active: receipt(active, daysAgo(40), { answered: true, lastActivityAt: daysAgo(1) }),
      unfinished: receipt(unfinished, daysAgo(40), {}),
      stopped: receipt(stopped, daysAgo(31), { stopped: true }),
    },
    operations: { expired: operation(expired), recent: operation(recent), stopped: operation(stopped) },
  }));
  await service.receive(created(), install);
  const file = await store.read();
  assert.deepEqual(Object.keys(file.receipts).filter((key) => !key.startsWith('linear:')).sort(), ['active', 'recent', 'unfinished']);
  assert.equal(Object.keys(file.receipts).filter((key) => key.startsWith('linear:')).length, 1);
  assert.deepEqual(Object.keys(file.operations), ['recent']);
}));

test('progress reconciliation keeps requests open; later turns can answer only delivered inputs', async () => withTempAnimaHome(async (home) => {
  const { service, fake, store, identity } = await seedLinear(home);
  await service.receive(created(), install); const first = await firstItem();
  await assert.rejects(service.respond(sessionId, 'response', 'Not yet', 'later-run'), /No accepted input/);
  const url = 'https://github.com/example/repo/pull/1';
  await assert.rejects(service.attach(sessionId, url, 'later-run'), /No authorized input/);
  await service.markStarted(first, first.id);
  fake.loseResponse = true; await assert.rejects(service.respond(sessionId, 'thought', 'Started', first.id));
  fake.loseResponse = false;
  const recovered = new LinearSessionService(identity);
  await recovered.respond(sessionId, 'thought', 'Started', first.id);
  assert.equal(fake.posts.length, 1); assert.notEqual((await store.read()).receipts[first.id]!.answered, true);
  await assert.rejects(recovered.respond(sessionId, 'response', 'Not this running turn', 'later-run'), /No accepted input/);
  await assert.rejects(recovered.attach(sessionId, url, 'later-run'), /No authorized input/);
  await new WakeQueueService('scout').complete(first.id); await recovered.markSettled(first);
  // A delivered but unanswered background request must survive receipt pruning.
  await store.update((f) => ({ ...f, receipts: { ...f.receipts, [first.id]: { ...f.receipts[first.id]!,
    receivedAt: new Date(Date.now() - 40 * 86400_000).toISOString(), lastActivityAt: undefined } } }));
  await recovered.receive(created(randomUUID()), install);
  assert.ok((await store.read()).receipts[first.id]);
  await recovered.attach(sessionId, url, 'later-run'); await recovered.attach(sessionId, url, 'later-run');
  assert.deepEqual(fake.links, [url]);
  await recovered.respond(sessionId, 'response', 'Finished', 'later-run');
  await recovered.respond(sessionId, 'response', 'Finished', 'later-run');
  await assert.rejects(recovered.respond(sessionId, 'response', 'Extra result', 'later-run'), /No accepted input/);
  await assert.rejects(recovered.attach(sessionId, url, 'later-run'), /No authorized input/);
  assert.deepEqual(fake.posts.map((p) => p.content.type), ['thought', 'response']);
  assert.equal((await store.read()).receipts[first.id]!.answered, true);
}));

test('idle closure skips missing or revoked installations before checking work and rechecks identity under the lock', async () => withTempAnimaHome(async (home) => {
  const { service, store, identity, fake } = await seedLinear(home);
  const neverCheck = async () => { assert.fail('No eligible Linear receipt needs a queue read'); };
  await service.completeIdleRuns(neverCheck);
  await settledRequest(service);
  await store.update((f) => ({ ...f, installation: undefined }));
  await service.completeIdleRuns(neverCheck);
  await store.update((f) => ({ ...f, installation: { ...install } }));
  await identity.revoke(install.id);
  for (let i = 0; i < 3; i++) await service.completeIdleRuns(neverCheck);
  await store.update((f) => ({ ...f, installation: { ...install } }));
  let checks = 0;
  await service.completeIdleRuns(async () => { checks++; await identity.revoke(install.id); return true; });
  assert.equal(checks, 1); assert.equal(fake.calls.length, 0);
}));

for (const failure of ['not-created', 'lost-response', 'bookkeeping'] as const) test(`idle closure records ${failure} once, continues other sessions and preserves explicit recovery`, async (t) => withTempAnimaHome(async (home) => {
  const { service, store, identity, fake } = await seedLinear(home);
  const first = await settledRequest(service);
  const otherSession = randomUUID(); const other = await settledRequest(service, otherSession);
  const graphql = identity.graphql.bind(identity);
  t.mock.method(identity, 'graphql', async (...args: Parameters<typeof identity.graphql>) => {
    const input = args[2].input as { agentSessionId?: string } | undefined;
    fake.failMutation = failure === 'not-created' && input?.agentSessionId === sessionId;
    fake.loseResponse = failure === 'lost-response' && input?.agentSessionId === sessionId;
    return graphql(...args);
  });
  const update = store.update.bind(store);
  let bookkeepingFailed = false;
  t.mock.method(store, 'update', (op: Parameters<LinearStore['update']>[0]) => update(async (f) => {
    const next = await op(f);
    if (failure === 'bookkeeping' && !bookkeepingFailed && next.receipts[first.id]?.answered) {
      bookkeepingFailed = true; throw new Error('synthetic-bookkeeping-secret');
    }
    return next;
  }));
  await service.completeIdleRuns(async () => true);
  const file = await store.read();
  assert.equal(file.receipts[first.id]!.idleCompletionFailed, true);
  assert.notEqual(file.receipts[first.id]!.answered, true);
  assert.equal(file.receipts[other.id]!.answered, true, 'One failure does not block another session');
  assert.match(file.lastError!, /Automatic retry stopped/);
  assert.doesNotMatch(file.lastError!, /secret/);
  const recovered = new LinearSessionService(identity); const before = fake.calls.length;
  for (let i = 0; i < 3; i++) await recovered.completeIdleRuns(async () => { assert.fail('Failed owners need no further idle checks'); });
  assert.equal(fake.calls.length, before, 'No repeated confirmation queries, including after service recreation');
  const body = 'The model run ended without a confirmed Linear response. Check progress before sending a new prompt.';
  if (failure === 'not-created') {
    await assert.rejects(recovered.respond(sessionId, 'response', 'Changed result', 'later-run'), /unknown/);
    assert.equal(fake.posts.filter((p) => p.agentSessionId === sessionId).length, 0);
  } else {
    await recovered.respond(sessionId, 'error', body, first.id);
    assert.equal(fake.posts.filter((p) => p.agentSessionId === sessionId).length, 1);
    assert.equal((await store.read()).receipts[first.id]!.answered, true);
  }
  const freshSession = randomUUID(); const fresh = await settledRequest(recovered, freshSession);
  await recovered.completeIdleRuns(async () => true);
  assert.equal((await store.read()).receipts[fresh.id]!.answered, true, 'Failure suppression is scoped to its receipts');
}));

test('idle closure rechecks work after locking and preserves legacy terminal operation semantics', async () => withTempAnimaHome(async (home) => {
  const { service, fake, store } = await seedLinear(home);
  await service.receive(created(), install); const first = await firstItem(); await service.markStarted(first, first.id);
  await new WakeQueueService('scout').complete(first.id); await service.markSettled(first);
  let checks = 0;
  await service.completeIdleRuns(async () => ++checks === 1);
  assert.equal(checks, 2); assert.equal(fake.posts.length, 0);
  fake.loseResponse = true;
  await assert.rejects(service.respond(sessionId, 'response', 'Legacy accepted', first.id));
  fake.loseResponse = false;
  await store.update((f) => ({ ...f, operations: Object.fromEntries(Object.entries(f.operations).map(([key, op]) => {
    const legacy = { ...op }; delete legacy.activityKind; return [key, legacy];
  })) }));
  await service.respond(sessionId, 'response', 'Legacy accepted', first.id);
  assert.equal(fake.posts.length, 1); assert.equal((await store.read()).receipts[first.id]!.answered, true);
}));
