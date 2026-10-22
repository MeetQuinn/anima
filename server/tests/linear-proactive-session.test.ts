import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { LinearSessionService } from '../linear/session.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { registerLinearCommands } from '../tools/linear-cli.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { makeSlackEvent } from './helpers/slack.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { FakeLinear, seedLinear, install, created, prompted } from './helpers/linear.js';
import { linearQueryErrors } from './helpers/linear-schema.js';

const issueId = randomUUID(), rootId = randomUUID(), replyId = randomUUID();
function details() {
  const id = randomUUID();
  return { id, appUser: { id: install.appUserId }, creator: null as { id: string } | null,
    issue: { id: issueId }, comment: { id: rootId }, status: 'active', url: `https://linear.app/synthetic/agent-session/${id}` };
}
class Sessions extends FakeLinear {
  sessions = new Map<string, ReturnType<typeof details>>();
  starts: Array<Record<string, string>> = [];
  loseCreate = false;
  beforeCreateReturn?: (session: ReturnType<typeof details>) => Promise<void>;
  constructor() {
    super();
    const baseFetch = this.fetch;
    this.fetch = async (url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      assert.deepEqual(linearQueryErrors(query), []);
      if (query.includes('agentSessionCreateOn')) {
        this.calls.push({ query, variables }); this.starts.push(variables.input);
        const session = details(); this.sessions.set(session.id, session);
        await this.beforeCreateReturn?.(session);
        if (this.loseCreate) throw new Error('Synthetic lost creation response');
        const field = query.includes('agentSessionCreateOnIssue') ? 'agentSessionCreateOnIssue' : 'agentSessionCreateOnComment';
        return Response.json({ data: { [field]: { success: true, agentSession: session } } });
      }
      if (query === 'query($id:String!){issue(id:$id){id}}') {
        this.calls.push({ query, variables });
        return Response.json({ data: { issue: { id: issueId } } });
      }
      if (query.includes('comment(id:')) {
        this.calls.push({ query, variables });
        return Response.json({ data: { comment: { id: variables.id, parent: variables.id === replyId ? { id: rootId } : null } } });
      }
      if (query.includes('agentSession(id:') && !query.includes('externalLinks')) {
        this.calls.push({ query, variables });
        return Response.json({ data: { agentSession: { ...this.sessions.get(variables.id), activities: {
          nodes: this.posts.filter((p) => p.agentSessionId === variables.id).map((p) => ({ id: p.id, content: p.content, createdAt: new Date().toISOString() })),
        } } } });
      }
      return baseFetch(url, init);
    };
  }
}

for (const omitCreator of [false, true]) test(`proactive starts are idempotent, normalize reply targets and do not enqueue their created webhook: missing creator=${omitCreator}`, async () => withTempAnimaHome(async (home) => {
  const fake = new Sessions(), f = await seedLinear(home, fake), queue = new WakeQueueService('scout');
  const deliveries: Promise<void>[] = [];
  fake.beforeCreateReturn = async (session) => {
    const event = created(session.id); event.agentSession.creatorId = null;
    if (omitCreator) delete event.agentSession.creatorId;
    event.agentSession.issueId = issueId; event.agentSession.commentId = rootId;
    deliveries.push(f.service.receive(event, install));
  };
  try {
    const request = randomUUID();
    const sessions = await Promise.all([f.service.start('issue', 'SYN-1', request, 'slack-owner'), f.service.start('issue', 'SYN-1', request, 'slack-owner')]);
    assert.equal(sessions[0]!.id, sessions[1]!.id); assert.equal(fake.starts.length, 1);
    assert.deepEqual(fake.starts[0], { issueId });
    await Promise.all(deliveries);
    assert.equal((await queue.list()).length, 0);
    assert.equal(Object.values((await f.store.read()).receipts)[0]!.runItemId, 'slack-owner');
    const restarted = new LinearSessionService(f.identity);
    assert.equal((await restarted.start('issue', 'SYN-1', request)).id, sessions[0]!.id);
    await assert.rejects(restarted.start('issue', 'SYN-OTHER', request), /different Linear target/);
    const comment = await restarted.start('comment', replyId, randomUUID(), 'slack-owner');
    await Promise.all(deliveries);
    assert.deepEqual(fake.starts.at(-1), { commentId: rootId });
    assert.equal((await queue.list()).length, 0);
    await restarted.respond(comment.id, 'thought', 'Started', 'slack-owner');
    await restarted.respond(comment.id, 'response', 'Finished later', 'another-turn');
    assert.deepEqual(fake.posts.map((p) => p.content.type), ['thought', 'response']);
    await restarted.receive(prompted(comment.id), install);
    assert.equal((await queue.list()).length, 1);
  } finally { await Promise.allSettled(deliveries); }
}));

test('a lost session creation is not repeated; its own open remote session can be inspected and recovered', async () => withTempAnimaHome(async (home) => {
  const fake = new Sessions(), f = await seedLinear(home, fake), request = randomUUID(); fake.loseCreate = true;
  await assert.rejects(f.service.start('issue', issueId, request, 'owner'));
  const session = [...fake.sessions.values()][0]!;
  const restarted = new LinearSessionService(f.identity);
  await assert.rejects(restarted.start('issue', issueId, request, 'next-turn'), /creation is unknown/);
  assert.equal(fake.starts.length, 1);
  assert.equal((await restarted.read(session.id)).id, session.id);
  fake.loseResponse = true;
  await assert.rejects(restarted.respond(session.id, 'thought', 'Recovered progress', 'next-turn'));
  fake.loseResponse = false;
  await restarted.respond(session.id, 'thought', 'Recovered progress', 'next-turn');
  assert.equal(fake.posts.length, 1);
  await restarted.attach(session.id, 'https://github.com/example/project/pull/1', 'later-turn');
  await restarted.respond(session.id, 'response', 'Recovered result', 'later-turn');
  assert.equal(fake.posts.length, 2); assert.equal(fake.links.length, 1);
}));

test('remote ownership, human requests and terminal sessions cannot be bypassed by proactive adoption', async () => withTempAnimaHome(async (home) => {
  const fake = new Sessions(), f = await seedLinear(home, fake);
  for (const change of [{ appUser: { id: randomUUID() } }, { creator: { id: randomUUID() } }, { status: 'complete' }, { status: 'error' }, { status: 'awaitingInput' }, { status: 'stopping' }]) {
    const session = { ...details(), ...change }; fake.sessions.set(session.id, session);
    await assert.rejects(f.service.respond(session.id, 'thought', 'Not authorized', 'turn'));
    await assert.rejects(f.service.attach(session.id, 'https://example.com/pr', 'turn'));
  }
  assert.equal(fake.posts.length, 0); assert.equal(fake.links.length, 0);
  assert.deepEqual((await f.store.read()).receipts, {});
  const other = details(); other.appUser.id = randomUUID(); fake.sessions.set(other.id, other);
  await assert.rejects(f.service.read(other.id), /does not belong/);
  const stale = details(); stale.status = 'stale'; fake.sessions.set(stale.id, stale);
  await f.service.respond(stale.id, 'thought', 'Still working', 'turn');
  await f.service.receive(prompted(stale.id, true), install);
  await assert.rejects(f.service.respond(stale.id, 'response', 'Too late', 'later'));
  assert.equal(fake.posts.filter((p) => p.content.type === 'response').length, 0);
}));

test('creation validates the returned owner and target without repeating an uncertain write', async () => withTempAnimaHome(async (home) => {
  const fake = new Sessions(), f = await seedLinear(home, fake);
  for (const change of [
    (session: ReturnType<typeof details>) => { session.appUser.id = randomUUID(); },
    (session: ReturnType<typeof details>) => { session.issue.id = randomUUID(); },
    (session: ReturnType<typeof details>) => { session.creator = { id: randomUUID() }; },
  ]) {
    fake.beforeCreateReturn = async (session) => { change(session); };
    const request = randomUUID();
    await assert.rejects(f.service.start('issue', issueId, request, 'turn'), /unexpected session owner|different session target/);
    await assert.rejects(f.service.start('issue', issueId, request, 'turn'), /creation is unknown/);
  }
  assert.equal(fake.starts.length, 3); assert.deepEqual((await f.store.read()).receipts, {});
  const unknownCreator = created(); delete unknownCreator.agentSession.creatorId;
  await f.service.receive(unknownCreator, install);
  assert.equal((await new WakeQueueService('scout').list()).length, 1, 'A missing creator alone does not identify our creation');
}));

test('Stop and identity replacement during creation cannot be overwritten by the creation response', async () => withTempAnimaHome(async (home) => {
  const fake = new Sessions(), f = await seedLinear(home, fake);
  fake.beforeCreateReturn = async (session) => { await f.service.receive(prompted(session.id, true), install); };
  await assert.rejects(f.service.start('issue', issueId, randomUUID(), 'running-turn'), /was stopped/);
  assert.equal(fake.posts.length, 0);
  const delayed = created([...fake.sessions.keys()][0]!); delayed.agentSession.creatorId = null; delayed.agentSession.issueId = issueId;
  await f.service.receive(delayed, install);
  assert.equal((await new WakeQueueService('scout').list()).length, 0, 'A delayed created event cannot undo the Stop');
  fake.beforeCreateReturn = async () => { await f.store.update((file) => ({ ...file, installation: { ...install, id: randomUUID() }, receipts: {}, operations: {}, sessionStarts: {} })); };
  await assert.rejects(f.service.start('issue', issueId, randomUUID(), 'running-turn'), /identity changed/);
  assert.deepEqual((await f.store.read()).receipts, {}); assert.deepEqual((await f.store.read()).sessionStarts, {});
}));

test('registered CLI starts a session with progress and records its session surface', async (t) => withTempAnimaHome(async (home) => {
  const fake = new Sessions(); await seedLinear(home, fake); t.mock.method(globalThis, 'fetch', fake.fetch);
  const output: string[] = [], diagnostics: string[] = [];
  t.mock.method(console, 'log', (line: string) => output.push(line)); t.mock.method(console, 'error', (line: string) => diagnostics.push(line));
  t.mock.getter(process, 'stdin', () => Readable.from(['Started voluntarily']) as typeof process.stdin);
  const command = new Command(); registerLinearCommands(command);
  await command.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', 'start', '--issue', issueId]);
  const result = JSON.parse(output.at(-1)!);
  assert.equal(fake.starts.length, 1); assert.equal(fake.posts[0]!.content.type, 'thought');
  assert.ok(diagnostics.some((line) => line.includes(result.requestId))); assert.ok(diagnostics.some((line) => line.includes(result.session.id)));
  const messages = (await messageServiceForAgent('scout').list()).entries;
  assert.ok(messages.some((m) => m.platform === 'linear' && m.channelKind === 'linear_session' && m.threadTs === result.session.id && m.text === 'Started voluntarily'));
}));

test('automation created events remain eligible, even on the same target during our creation', async () => withTempAnimaHome(async (home) => {
  const fake = new Sessions(), f = await seedLinear(home, fake), queue = new WakeQueueService('scout');
  const automation = created(randomUUID()); automation.agentSession.creatorId = null; automation.agentSession.issueId = issueId;
  await f.service.receive(automation, install);
  let during!: Promise<void>;
  const concurrent = created(randomUUID()); concurrent.agentSession.creatorId = null; concurrent.agentSession.issueId = issueId;
  fake.beforeCreateReturn = async () => { during = f.service.receive(concurrent, install); };
  await f.service.start('issue', 'SYN-1', randomUUID(), 'slack-owner'); await during;
  const items = await queue.list();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.kind === 'linear' && i.sessionId).sort(), [automation.agentSession.id, concurrent.agentSession.id].sort());
  assert.ok(items.every((i) => i.kind === 'linear' && !i.humanRequested));
  // An uncertain create is not a permanent wildcard swallowing automation.
  fake.beforeCreateReturn = undefined; fake.loseCreate = true;
  await assert.rejects(f.service.start('issue', issueId, randomUUID()));
  const later = created(randomUUID()); later.agentSession.creatorId = null; later.agentSession.issueId = issueId;
  await f.service.receive(later, install); assert.equal((await queue.list()).length, 3);
}));

for (const running of [false, true]) test(`proactive Stop keeps external queued input and interrupts only a running owner: running=${running}`, async () => withTempAnimaHome(async (home) => {
  const fake = new Sessions(), f = await seedLinear(home, fake), queue = new WakeQueueService('scout');
  const owner = makeSlackEvent({ eventId: 'external-owner', channelId: 'D-control', userId: 'U-control', teamId: 'T-control', ts: '1770000030.000001', text: 'Unrelated Slack input' });
  await queue.enqueue(owner);
  if (running) await queue.takeNextRunnable({ workerId: 'synthetic', isWorkerAlive: () => true });
  const session = await f.service.start('issue', issueId, randomUUID(), owner.id);
  const receipt = Object.values((await f.store.read()).receipts)[0]!;
  assert.notEqual(receipt.itemId, owner.id); assert.equal(receipt.runItemId, owner.id);
  await f.service.receive(prompted(session.id, true), install);
  const retained = await queue.find(owner.id);
  assert.ok(retained); assert.equal(retained.handling.status, running ? 'running' : 'queued');
  assert.equal(Boolean(retained.handling.stopRequestedAt), running);
  await assert.rejects(f.service.respond(session.id, 'response', 'Too late', 'new-turn'));
}));
