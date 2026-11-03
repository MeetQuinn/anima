import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTempAnimaHome } from './helpers/harness.js';
import { created, install, seedLinear, sessionId, prompted, FakeLinear } from './helpers/linear.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { runtimeContextForItemId } from '../runtime/context.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { LinearSessionService } from '../linear/session.service.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearClient } from '../linear/client.js';
import type { LinearStore } from '../storage/schema/linear.store.js';
import type { LinearInboxItem } from '../../shared/inbox.js';

async function firstItem() { return (await new WakeQueueService('scout').list())[0]! as LinearInboxItem; }

async function settledRequest(service: LinearSessionService, session = sessionId) {
  await service.receive(created(session), install);
  const queue = new WakeQueueService('scout');
  const item = (await queue.list()).find((i) => i.kind === 'linear' && i.sessionId === session)!;
  await service.markStarted(item, item.id);
  await queue.complete(item.id); await service.markSettled(item);
  return item;
}

for (const failure of ['401', '400', '500', 'network', 'invalid-json', 'partial'] as const) {
  test(`Linear response preserves explicit retry only after a confirmed rejection: ${failure}`, async () => withTempAnimaHome(async (home) => {
    const fake = new FakeLinear(), fetch = fake.fetch;
    let attempts = 0;
    const setup = await seedLinear(home, fake);
    // The client captured fake.fetch during construction; replace that instance
    // before constructing the service that sends the tested request.
    const { store } = setup;
    fake.fetch = async (url, init) => {
      const query = String(url).endsWith('/graphql') ? JSON.parse(String(init?.body)).query as string : '';
      if (query.includes('agentActivityCreate')) {
        attempts++;
        if (attempts === 1) {
          // A separate process has refreshed while the old request is in flight.
          assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${install.accessToken}`);
          await store.update((file) => ({ ...file, installation: { ...file.installation!, expiresAt: 0 } }));
          await setup.identity.credentials();
          if (failure === '401' || failure === '400' || failure === '500') return new Response('{}', { status: Number(failure) });
          if (failure === 'network') throw new Error('synthetic response lost');
          if (failure === 'invalid-json') return new Response('{');
          const accepted = await fetch(url, init);
          return new Response(JSON.stringify({ ...await accepted.json(), errors: [{ message: 'synthetic partial result' }] }));
        }
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer new-access-sentinel');
      }
      return fetch(url, init);
    };
    const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch), store);
    const service = new LinearSessionService(identity);
    const item = await settledRequest(service);
    const send = (target: LinearSessionService) => target.respond(sessionId, 'response', 'Done after refresh', item.id);
    await assert.rejects(send(service));
    assert.equal(attempts, 1, 'The failing call must never retry the write automatically');
    assert.equal((await store.read()).installation!.revoked, false);
    const recovered = new LinearSessionService(identity);
    if (failure === '401') {
      assert.deepEqual((await store.read()).operations, {});
      await send(recovered);
      await send(recovered);
      assert.equal(attempts, 2, 'One explicit retry succeeds; an accepted duplicate is not resent');
    } else {
      assert.equal(Object.values((await store.read()).operations)[0]?.state, 'unknown');
      if (failure === 'partial') await send(recovered);
      else await assert.rejects(send(recovered), /unknown/);
      assert.equal(attempts, 1, 'An ambiguous write must be reconciled, never blindly retried');
    }
    const accepted = failure === '401' || failure === 'partial';
    assert.equal(fake.posts.length, accepted ? 1 : 0);
    assert.equal(Boolean((await store.read()).receipts[item.id]!.answered), accepted);
  }));
}

for (const replacement of [false, true]) {
  test(`a rejected Linear write preserves identity isolation: replacement=${replacement}`, async () => withTempAnimaHome(async (home) => {
    const fake = new FakeLinear(), fetch = fake.fetch;
    const { store, agentStore } = await seedLinear(home, fake);
    let before: Awaited<ReturnType<typeof store.read>> | undefined;
    let writes = 0;
    fake.fetch = async (url, init) => {
      if (String(url).endsWith('/graphql') && String(init?.body).includes('agentActivityCreate')) {
        writes++;
        if (replacement) {
          await store.update((file) => ({ ...file, installation: { ...file.installation!, id: randomUUID() },
            operations: Object.fromEntries(Object.entries(file.operations).map(([key, op]) => [key, { ...op, id: randomUUID() }])) }));
          before = await store.read();
        }
        return new Response('{}', { status: 401 });
      }
      return fetch(url, init);
    };
    const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch), store);
    const service = new LinearSessionService(identity);
    const item = await settledRequest(service);
    await assert.rejects(service.respond(sessionId, 'response', 'Done', item.id), /request was unauthorized/);
    assert.equal(writes, 1);
    if (replacement) assert.deepEqual(await store.read(), before, 'A late failure cannot erase the new installation or its intent');
    else {
      assert.equal((await store.read()).installation!.revoked, true);
      assert.equal((await agentStore.read()).linear!.connected, false);
      assert.deepEqual((await store.read()).operations, {});
      await assert.rejects(service.respond(sessionId, 'response', 'Done', item.id), /disabled or disconnected/);
      assert.equal(writes, 1);
    }
  }));
}

test('a failed rejection cleanup leaves the Linear send intent blocking unsafe replay', async (t) => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(), fetch = fake.fetch;
  const { store } = await seedLinear(home, fake);
  let writes = 0;
  fake.fetch = async (url, init) => {
    if (String(url).endsWith('/graphql') && String(init?.body).includes('agentActivityCreate')) {
      writes++;
      await store.update((file) => ({ ...file, installation: { ...file.installation!, accessToken: 'rotated-sentinel' } }));
      return new Response('{}', { status: 401 });
    }
    return fetch(url, init);
  };
  const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch), store);
  const service = new LinearSessionService(identity);
  const item = await settledRequest(service);
  const update = store.update.bind(store);
  const mock = t.mock.method(store, 'update', (change: Parameters<typeof update>[0]) => update(async (file) => {
    const next = await change(file);
    if (Object.keys(file.operations).length && !Object.keys(next.operations).length) throw new Error('synthetic disk failed');
    return next;
  }));
  await assert.rejects(service.respond(sessionId, 'response', 'Done', item.id), /synthetic disk failed/);
  mock.mock.restore();
  assert.equal(Object.values((await store.read()).operations)[0]!.state, 'sending');
  await assert.rejects(new LinearSessionService(identity).respond(sessionId, 'response', 'Done', item.id), /unknown/);
  assert.equal(writes, 1);
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
  await service.markStarted(first, first.id);
  fake.loseResponse = true; await assert.rejects(service.respond(sessionId, 'thought', 'Started', first.id));
  fake.loseResponse = false;
  const recovered = new LinearSessionService(identity);
  await recovered.respond(sessionId, 'thought', 'Started', first.id);
  assert.equal(fake.posts.length, 1); assert.notEqual((await store.read()).receipts[first.id]!.answered, true);
  await assert.rejects(recovered.respond(sessionId, 'response', 'Not this running turn', 'later-run'), /No accepted input/);
  await new WakeQueueService('scout').complete(first.id); await recovered.markSettled(first);
  // A delivered but unanswered background request must survive receipt pruning.
  await store.update((f) => ({ ...f, receipts: { ...f.receipts, [first.id]: { ...f.receipts[first.id]!,
    receivedAt: new Date(Date.now() - 40 * 86400_000).toISOString(), lastActivityAt: undefined } } }));
  await recovered.receive(created(randomUUID()), install);
  assert.ok((await store.read()).receipts[first.id]);
  await recovered.respond(sessionId, 'response', 'Finished', 'later-run');
  await recovered.respond(sessionId, 'response', 'Finished', 'later-run');
  await assert.rejects(recovered.respond(sessionId, 'response', 'Extra result', 'later-run'), /No accepted input/);
  assert.deepEqual(fake.posts.map((p) => p.content.type), ['thought', 'response']);
  assert.equal((await store.read()).receipts[first.id]!.answered, true);
}));

test('legacy activity operations without a kind still count as terminal replies', async () => withTempAnimaHome(async (home) => {
  const { service, fake, store } = await seedLinear(home);
  await service.receive(created(), install); const first = await firstItem(); await service.markStarted(first, first.id);
  await new WakeQueueService('scout').complete(first.id); await service.markSettled(first);
  fake.loseResponse = true;
  await assert.rejects(service.respond(sessionId, 'response', 'Legacy accepted', first.id));
  fake.loseResponse = false;
  await store.update((f) => ({ ...f, operations: Object.fromEntries(Object.entries(f.operations).map(([key, op]) => {
    const legacy = { ...op }; delete legacy.activityKind; return [key, legacy];
  })) }));
  await service.respond(sessionId, 'response', 'Legacy accepted', first.id);
  assert.equal(fake.posts.length, 1); assert.equal((await store.read()).receipts[first.id]!.answered, true);
}));

test('a new prompt in a stale unanswered session clears the count until that request also ends unanswered', async () => withTempAnimaHome(async (home) => {
  const { service, identity, store, fake } = await seedLinear(home);
  await settledRequest(service);
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const age = async (minutes: number) => store.update((f) => ({ ...f, receipts: Object.fromEntries(Object.entries(f.receipts).map(([id, r]) => [id,
    { ...r, acknowledgement: 'accepted' as const, receivedAt: ago(minutes), lastActivityAt: ago(minutes) }])) }));
  await age(31);
  assert.equal((await identity.status()).unansweredSessions, 1);
  await service.receive(prompted(), install);
  await service.tick();
  assert.deepEqual(fake.posts.map((p) => p.content.body), ['Received by Anima.']);
  assert.equal((await identity.status()).unansweredSessions, undefined, 'The new prompt and its receipt are fresh session activity');
  // Even once Linear would show it stale, a request that is still queued has not ended.
  await age(45);
  assert.equal((await identity.status()).unansweredSessions, undefined);
  const queue = new WakeQueueService('scout');
  const item = (await queue.list()).find((i) => i.kind === 'linear')!;
  await service.markStarted(item, item.id); await queue.complete(item.id); await service.markSettled(item);
  assert.equal((await identity.status()).unansweredSessions, 1);
  // A crash notice answers only its own request, but it is still fresh activity in the session.
  await service.receive(prompted(), install);
  const crashed = (await queue.list()).find((i) => i.kind === 'linear')!;
  await service.markStarted(crashed, crashed.id);
  await service.finishRun(crashed.id, 'The model run failed.');
  assert.equal(Object.values((await store.read()).receipts).filter((r) => !r.answered).length, 2);
  assert.equal((await identity.status()).unansweredSessions, undefined, 'Linear shows the error, not a stale session');
  await age(31);
  assert.equal((await identity.status()).unansweredSessions, 1);
}));

test('a run that ends unanswered gets no runtime notice; the dashboard counts it once Linear shows it stale', async (t) => withTempAnimaHome(async (home) => {
  const { service, identity, store, fake } = await seedLinear(home);
  const first = await settledRequest(service);
  const other = randomUUID(); await settledRequest(service, other);
  await store.update((f) => ({ ...f, receipts: Object.fromEntries(Object.entries(f.receipts).map(([id, r]) => [id, { ...r, acknowledgement: 'accepted' }])) }));
  const lock = t.mock.method(service as unknown as { sessionLock(id: string, op: () => Promise<unknown>): Promise<unknown> }, 'sessionLock');
  const age = async (minutes: number) => store.update((f) => ({ ...f, receipts: Object.fromEntries(Object.entries(f.receipts).map(([id, r]) => [id,
    { ...r, receivedAt: new Date(Date.now() - minutes * 60_000).toISOString(), lastActivityAt: undefined, lastStatusAttemptAt: undefined }])) }));
  await age(11);
  for (let tick = 0; tick < 3; tick++) await service.tick();
  assert.equal(fake.posts.length, 0, 'No heartbeat or missing-response error once the run ended');
  assert.equal(lock.mock.callCount(), 0, 'Ended requests take no session lock');
  assert.equal((await identity.status()).unansweredSessions, undefined, 'Not stale in Linear yet');
  await age(31);
  assert.equal((await identity.status()).unansweredSessions, 2);
  assert.notEqual((await store.read()).receipts[first.id]!.answered, true);
  // A request that is still queued or running is not one that ended without a reply.
  const third = randomUUID(); await service.receive(created(third), install);
  await store.update((f) => ({ ...f, receipts: Object.fromEntries(Object.entries(f.receipts).map(([id, r]) => [id,
    r.sessionId === third ? { ...r, receivedAt: new Date(Date.now() - 31 * 60_000).toISOString() } : r])) }));
  assert.equal((await identity.status()).unansweredSessions, 2);
  // Progress keeps a session fresh; a reply or a Stop resolves it.
  await service.respond(sessionId, 'thought', 'Still checking', 'later-run');
  assert.equal((await identity.status()).unansweredSessions, 1);
  // A Stop resolves the session even when its notice cannot be sent.
  fake.failMutation = true;
  await service.receive(prompted(other, true), install).catch(() => {});
  fake.failMutation = false;
  assert.notEqual(Object.values((await store.read()).receipts).find((r) => r.sessionId === other)!.answered, true);
  assert.equal((await identity.status()).unansweredSessions, undefined);
  await age(31);
  assert.equal((await identity.status()).unansweredSessions, 1, 'Without further activity the session goes stale again');
  await service.respond(sessionId, 'response', 'Finished', 'later-run');
  assert.equal((await identity.status()).unansweredSessions, undefined);
  assert.deepEqual(fake.posts.map((p) => p.content.type), ['thought', 'response']);
}));
