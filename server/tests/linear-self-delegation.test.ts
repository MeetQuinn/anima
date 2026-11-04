import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { LinearSessionService } from '../linear/session.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { registerLinearCommands } from '../tools/linear-cli.js';
import { withTempAnimaHome } from './helpers/harness.js';
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

test('self-delegation is acknowledged once without a wake and the registered reply CLI works', async (t) => withTempAnimaHome(async (home) => {
  const fake = new Delegations(), { service, identity, store } = await seedLinear(home, fake);
  const event = fake.event(); delete event.agentSession.creatorId;
  await service.receive(event, install);
  const key = `linear:${install.id}:created:${fake.origin.id}`;
  const receipt = (await store.read()).receipts[key]!;
  assert.equal(receipt.state, 'awaiting'); assert.equal(receipt.issueId, fake.origin.issue.id);
  assert.equal(receipt.commentId, fake.origin.comment.id, 'Linear also creates a session comment for self-delegation');
  assert.equal(receipt.acknowledgement, 'pending'); assert.equal(receipt.item, undefined);
  assert.ok((await store.read()).lastSignedWebhookAt);
  const restarted = new LinearSessionService(identity);
  await restarted.receive(event, install);
  await Promise.all([restarted.tick(), service.tick()]);
  await new LinearSessionService(identity).receive(event, install); await restarted.tick();
  assert.equal(fake.calls.filter((call) => call.query.includes('activities(last:')).length, 1, 'A durable receipt handles repeat delivery');
  assert.equal((await new WakeQueueService('scout').list()).length, 0);
  assert.deepEqual(fake.posts.map((post) => post.content.body), ['Received by Anima.']);
  assert.equal(fake.posts[0]!.ephemeral, true);
  assert.equal((await store.read()).receipts[key]!.acknowledgement, 'accepted');
  t.mock.method(globalThis, 'fetch', fake.fetch);
  t.mock.getter(process, 'stdin', () => Readable.from(['Finished the self-delegated work']) as typeof process.stdin);
  t.mock.method(console, 'log', () => {});
  const command = new Command(); registerLinearCommands(command);
  await command.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', 'reply', '--to', `session:${fake.origin.id}`]);
  assert.equal(fake.posts.length, 2); assert.equal(fake.posts[1]!.content.type, 'response');
  assert.equal((await store.read()).receipts[key]!.state, 'answered');
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
