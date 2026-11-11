import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LinearSessionService } from '../linear/session.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { waitFor, withTempAnimaHome } from './helpers/harness.js';
import { FakeLinear, seedLinear, install, created, prompted } from './helpers/linear.js';
import { linearQueryErrors } from './helpers/linear-schema.js';

function origin() {
  const createdAt = '2026-11-03T16:48:45.464Z';
  return { id: randomUUID(), appUser: { id: install.appUserId }, creator: null as { id: string } | null,
    issue: { id: randomUUID() }, comment: { id: randomUUID() }, createdAt,
    activities: { nodes: [{ createdAt, promptAuthor: { id: install.appUserId } as { id: string; name?: string } | null,
      content: { type: 'prompt' } as { type?: string } }] } };
}
class Delegations extends FakeLinear {
  origin = origin();
  failOrigin = false;
  beforeOrigin?: () => Promise<void>;
  constructor() {
    super();
    const baseFetch = this.fetch;
    this.fetch = async (url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes('activities(last:1,orderBy:createdAt)')) {
        this.calls.push({ query, variables });
        assert.deepEqual(linearQueryErrors(query), []);
        await this.beforeOrigin?.();
        if (this.failOrigin) throw new Error('Synthetic origin unavailable');
        return Response.json({ data: { agentSession: this.origin } });
      }
      return baseFetch(url, init);
    };
  }
  event() {
    const event = created(this.origin.id);
    event.agentSession.creatorId = null; delete event.agentSession.creator;
    event.agentSession.issueId = this.origin.issue.id;
    event.agentSession.createdAt = this.origin.createdAt;
    event.agentSession.commentId = this.origin.comment.id;
    return event;
  }
}

test('self-delegation is closed once by its acknowledgement, without a wake', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, identity, store } = await seedLinear(home, fake);
  const event = fake.event(); delete event.agentSession.creatorId;
  await service.receive(event, install);
  const key = `linear:${install.id}:created:${fake.origin.id}`;
  const receipt = (await store.read()).receipts[key]!;
  assert.equal(receipt.state, 'awaiting'); assert.equal(receipt.issueId, fake.origin.issue.id);
  assert.equal(receipt.commentId, fake.origin.comment.id, 'Linear also creates a session comment for self-delegation');
  assert.equal(receipt.acknowledgement, 'pending'); assert.equal(receipt.item, undefined);
  assert.equal(receipt.selfDelegated, true);
  assert.ok((await store.read()).lastSignedWebhookAt);
  const restarted = new LinearSessionService(identity);
  await restarted.receive(event, install);
  await Promise.all([restarted.tick(), service.tick()]);
  await new LinearSessionService(identity).receive(event, install); await restarted.tick();
  assert.equal(fake.calls.filter((call) => call.query.includes('activities(last:')).length, 1, 'A durable receipt handles repeat delivery');
  assert.equal((await new WakeQueueService('scout').list()).length, 0);
  // A response ends the session in Linear; a thought left it running.
  assert.equal(fake.posts.length, 1);
  assert.equal(fake.posts[0]!.content.type, 'response'); assert.equal(fake.posts[0]!.ephemeral, false);
  assert.match(fake.posts[0]!.content.body, /^Received by Anima\. This agent delegated the issue to itself, so this session ends here\./);
  const closed = (await store.read()).receipts[key]!;
  assert.equal(closed.acknowledgement, 'accepted'); assert.equal(closed.state, 'answered');
  await assert.rejects(service.respond(fake.origin.id, 'response', 'Finished the self-delegated work', 'existing-turn'),
    /This session came from your own delegation and is closed\. Report on the issue instead: reply --to issue:/);
  assert.equal(fake.posts.length, 1);
}));

test('a self-delegation closing notice whose result was lost is confirmed, not sent again', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, store } = await seedLinear(home, fake);
  await service.receive(fake.event(), install);
  const key = `linear:${install.id}:created:${fake.origin.id}`;
  const receipt = (await store.read()).receipts[key]!;
  // The notice reached Linear, then the process died before recording it.
  fake.posts.push({ id: receipt.acknowledgementId, agentSessionId: fake.origin.id, content: { type: 'response', body: 'sent' }, ephemeral: false });
  await store.update((file) => ({ ...file, receipts: { ...file.receipts, [key]: { ...receipt, acknowledgement: 'sending' } } }));
  await service.tick();
  assert.equal(fake.posts.length, 1);
  assert.equal((await store.read()).receipts[key]!.state, 'answered');
}));

test('a lost closing result is confirmed at once, so a later session reply cannot end it again', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, identity, store } = await seedLinear(home, fake);
  await service.receive(fake.event(), install);
  fake.loseResponse = true; await service.tick(); fake.loseResponse = false;
  await new LinearSessionService(identity).tick();
  assert.deepEqual(fake.posts.map((p) => p.content.type), ['response']);
  assert.deepEqual(Object.values((await store.read()).receipts).map((r) => [r.state, r.acknowledgement]), [['answered', 'accepted']]);
  await assert.rejects(new LinearSessionService(identity).respond(fake.origin.id, 'response', 'Finished work', 'existing-turn'), /came from your own delegation/);
  assert.equal(fake.posts.length, 1);
}));

test('an unconfirmed closing result blocks a reply unless that reply answers a person', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, store } = await seedLinear(home, fake);
  await service.receive(fake.event(), install);
  fake.failMutation = true; await service.tick(); fake.failMutation = false;
  assert.deepEqual(Object.values((await store.read()).receipts).map((r) => [r.state, r.acknowledgement]), [['awaiting', 'unknown']]);
  await assert.rejects(service.respond(fake.origin.id, 'response', 'Finished work', 'existing-turn'), /result is unknown/);
  assert.equal(fake.posts.length, 0);
  const human = prompted(fake.origin.id); human.agentActivity!.userId = randomUUID();
  await service.receive(human, install); await service.tick();
  // The person's prompt has not reached a turn yet, so an unrelated turn's reply would only end the session.
  await assert.rejects(service.respond(fake.origin.id, 'response', 'Unrelated', 'old-unrelated-turn'), /result is unknown/);
  assert.deepEqual(fake.posts.map((p) => p.content.type), ['thought']);
  const [item] = await new WakeQueueService('scout').list();
  assert.ok(item); await service.markStarted(item, 'human-turn');
  await service.respond(fake.origin.id, 'response', 'Answered the person', 'human-turn');
  assert.deepEqual(fake.posts.map((p) => p.content.type), ['thought', 'response']);
  assert.deepEqual(Object.values((await store.read()).receipts).map((r) => r.state).sort(), ['answered', 'answered']);
}));

test('a person\'s prompt acknowledged before the self-delegation keeps the session open', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, store } = await seedLinear(home, fake);
  const human = prompted(fake.origin.id); human.agentActivity!.userId = randomUUID();
  // The person writes while Anima is still checking who opened the session.
  fake.beforeOrigin = async () => { await service.receive(human, install); await service.tick(); };
  await service.receive(fake.event(), install); await service.tick();
  // Linear shows the latest activity as the session state; a closing response here would end the person's request.
  assert.deepEqual(fake.posts.map((p) => [p.content.type, p.content.body]), [['thought', 'Received by Anima.'], ['thought', 'Received by Anima.']]);
  const self = (await store.read()).receipts[`linear:${install.id}:created:${fake.origin.id}`]!;
  assert.equal(self.state, 'awaiting'); assert.equal(self.selfDelegated, undefined);
  const [item] = await new WakeQueueService('scout').list();
  assert.ok(item); await service.markStarted(item, 'human-turn');
  await service.respond(fake.origin.id, 'response', 'Answered the person', 'human-turn');
  assert.equal(fake.posts.at(-1)!.content.body, 'Answered the person'); assert.equal(fake.posts.length, 3);
  assert.deepEqual(Object.values((await store.read()).receipts).map((r) => r.state).sort(), ['answered', 'answered']);
}));

test('a Stop during the closing acknowledgement still gets its own notice', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), base = fake.fetch;
  let started = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fake.fetch = async (url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('agentActivityCreate') && variables.input.content.type === 'response') { started = true; await gate; }
    return base(url, init);
  };
  const { service, store } = await seedLinear(home, fake);
  await service.receive(fake.event(), install);
  const tick = service.tick(); await waitFor(() => started);
  const stop = service.receive(prompted(fake.origin.id, true), install);
  await waitFor(async () => Object.values((await store.read()).receipts).some((r) => r.state === 'stopping'));
  release(); await Promise.all([tick, stop]);
  assert.deepEqual(Object.values((await store.read()).receipts).map((r) => r.state).sort(), ['confirmed', 'stopped']);
  assert.deepEqual(fake.posts.map((p) => p.content.type), ['response', 'error']);
}));

test('a reply from the delegating turn before the acknowledgement answers the session once', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, store } = await seedLinear(home, fake);
  await service.receive(fake.event(), install);
  await service.respond(fake.origin.id, 'response', 'Already done', 'existing-turn');
  await service.tick();
  assert.deepEqual(fake.posts.map((p) => p.content.body), ['Already done']);
  assert.deepEqual(Object.values((await store.read()).receipts).map((r) => r.state), ['answered']);
}));

test('a later human prompt in self-delegated work wakes and keeps normal reply ownership', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, store } = await seedLinear(home, fake);
  await service.receive(fake.event(), install);
  const followup = prompted(fake.origin.id); followup.agentSession.creatorId = null;
  followup.agentActivity!.userId = randomUUID();
  await service.receive(followup, install);
  const queue = new WakeQueueService('scout'), [item] = await queue.list();
  assert.ok(item); assert.equal(item.kind, 'linear'); assert.equal(item.text, 'Only this new prompt');
  await service.markStarted(item, 'later-human-turn');
  await service.respond(fake.origin.id, 'response', 'Addressed your follow-up', 'later-human-turn');
  assert.ok(Object.values((await store.read()).receipts).every((r) => r.state === 'answered'));
}));

test('self-delegated work remains replyable from an existing agent turn and Stop blocks later replies', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, identity, store } = await seedLinear(home, fake);
  await service.receive(fake.event(), install);
  await service.respond(fake.origin.id, 'thought', 'Working already', 'existing-turn');
  const restarted = new LinearSessionService(identity);
  await restarted.receive(prompted(fake.origin.id, true), install);
  await assert.rejects(restarted.respond(fake.origin.id, 'response', 'Too late', 'existing-turn'), /No accepted input/);
  assert.equal((await new WakeQueueService('scout').list()).length, 0);
  assert.deepEqual(Object.values((await store.read()).receipts).map((r) => r.state).sort(), ['confirmed', 'stopped']);
  assert.match(fake.posts.at(-1)!.content.body, /Stopped accepting replies/);
}));

for (const timing of ['before', 'during'] as const) test(`Stop ${timing} the self-delegation lookup wins over created`, async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, store } = await seedLinear(home, fake);
  const stop = () => service.receive(prompted(fake.origin.id, true), install);
  if (timing === 'before') await stop(); else fake.beforeOrigin = stop;
  await service.receive(fake.event(), install); await service.tick();
  assert.equal((await new WakeQueueService('scout').list()).length, 0);
  assert.deepEqual(Object.values((await store.read()).receipts).map((r) => r.state).sort(), ['confirmed', 'stopped']);
  assert.equal(fake.posts.length, 1); assert.equal(fake.posts[0]!.content.type, 'error');
  await assert.rejects(service.respond(fake.origin.id, 'response', 'Too late', 'turn'));
}));

const uncertainOrigins: Record<string, (fake: Delegations) => void> = {
  'another app delegated it (null creator)': (f) => { f.origin.activities.nodes[0]!.promptAuthor!.id = randomUUID(); },
  'automation has no prompt author': (f) => { f.origin.activities.nodes[0]!.promptAuthor = null; },
  'no activity yet': (f) => { f.origin.activities.nodes = []; },
  'a later own prompt': (f) => { f.origin.activities.nodes[0]!.createdAt = '2026-11-03T16:49:45.464Z'; },
  'first activity is not a prompt': (f) => { f.origin.activities.nodes[0]!.content = {}; },
  'remote human creator': (f) => { f.origin.creator = { id: randomUUID() }; },
  'different session': (f) => { f.origin.id = randomUUID(); },
  'different app owner': (f) => { f.origin.appUser.id = randomUUID(); },
  'different issue': (f) => { f.origin.issue.id = randomUUID(); },
  'API failure': (f) => { f.failOrigin = true; },
  'malformed API result': (f) => { f.origin.createdAt = 'not a date'; },
};
for (const [name, change] of Object.entries(uncertainOrigins)) test(`created still wakes when self-delegation is unproven: ${name}`, async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service } = await seedLinear(home, fake), event = fake.event();
  change(fake); await service.receive(event, install); await service.tick();
  assert.equal((await new WakeQueueService('scout').list()).length, 1);
  assert.deepEqual(fake.posts.map((p) => p.content.body), ['Received by Anima.']);
}));

test('another agent\'s delegation names that agent, as a person\'s would', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service } = await seedLinear(home, fake), event = fake.event();
  const delegator = randomUUID();
  fake.origin.activities.nodes[0]!.promptAuthor = { id: delegator, name: 'Synthetic lead' };
  await service.receive(event, install); await service.tick();
  const [item] = await new WakeQueueService('scout').list();
  assert.ok(item?.kind === 'linear');
  assert.equal(item.actorId, delegator); assert.equal(item.actorName, 'Synthetic lead');
  assert.equal(item.origin, 'delegation');
}));

for (const [name, change] of Object.entries({
  'automation has no prompt author': (f: Delegations) => { f.origin.activities.nodes[0]!.promptAuthor = null; },
  'a later prompt': (f: Delegations) => { f.origin.activities.nodes[0]!.promptAuthor = { id: randomUUID(), name: 'Later' }; f.origin.activities.nodes[0]!.createdAt = '2026-11-03T16:49:45.464Z'; },
  'API failure': (f: Delegations) => { f.failOrigin = true; },
})) test(`an unproven delegator is left out: ${name}`, async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service } = await seedLinear(home, fake), event = fake.event();
  change(fake); await service.receive(event, install); await service.tick();
  const [item] = await new WakeQueueService('scout').list();
  assert.ok(item?.kind === 'linear');
  assert.equal(item.actorId, undefined); assert.equal(item.actorName, undefined);
}));

test('human delegation is unchanged and does not need a remote origin lookup', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service } = await seedLinear(home, fake), event = fake.event();
  event.agentSession.creatorId = randomUUID();
  await service.receive(event, install); await service.tick();
  assert.equal((await new WakeQueueService('scout').list()).length, 1);
  assert.equal(fake.calls.filter((call) => call.query.includes('activities(last:')).length, 0);
  assert.deepEqual(fake.posts.map((p) => p.content.body), ['Received by Anima.']);
}));

test('a human prompt racing origin lookup remains queued when self-delegation is linked', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, store } = await seedLinear(home, fake);
  const prompt = prompted(fake.origin.id);
  fake.beforeOrigin = () => service.receive(prompt, install);
  await service.receive(fake.event(), install);
  const items = await new WakeQueueService('scout').list();
  assert.equal(items.length, 1); assert.equal(items[0]!.kind, 'linear');
  assert.equal(items[0]!.id, `linear:${install.id}:prompted:${prompt.agentActivity!.id}`);
  assert.equal(Object.values((await store.read()).receipts).filter((r) => r.state === 'awaiting').length, 1);
}));

test('identity replacement during origin lookup cannot link work to the replacement', async () => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, store } = await seedLinear(home, fake);
  fake.beforeOrigin = async () => { await store.update((f) => ({ ...f, installation: { ...install, id: randomUUID() } })); };
  await assert.rejects(service.receive(fake.event(), install), /identity changed/);
  assert.deepEqual((await store.read()).receipts, {});
  assert.equal((await new WakeQueueService('scout').list()).length, 0);
}));
