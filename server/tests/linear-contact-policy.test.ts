import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { registerLinearCommands } from '../tools/linear-cli.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { withoutCode } from '../linear/contact-policy.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { FakeLinear, created, install, seedLinear, sessionId } from './helpers/linear.js';

const listed = { id: randomUUID(), displayName: 'nicholas', url: 'https://linear.app/synthetic/profiles/nicholas' };
const issue = { id: randomUUID(), identifier: 'SYN-1', title: 'Synthetic issue', url: 'https://linear.app/synthetic/issue/SYN-1' };

class Workspace extends FakeLinear {
  lookups = 0;
  failLookup = false;
  comments: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    const base = this.fetch;
    this.fetch = async (url, init) => {
      if (String(url).endsWith('/oauth/token')) return base(url, init);
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes('users(filter:{id:{in:')) {
        this.lookups++;
        if (this.failLookup) return new Response('{}', { status: 503 });
        const nodes = [listed].filter((user) => variables.ids.includes(user.id));
        return Response.json({ data: { users: { nodes } } });
      }
      if (query.includes('commentCreate')) {
        this.comments.push(variables.input);
        return Response.json({ data: { commentCreate: { success: true, comment: { id: variables.input.id, body: variables.input.body, url: 'https://linear.app/synthetic/comment', parent: null, issue } } } });
      }
      return base(url, init);
    };
  }
  mutations() { return this.calls.filter((call) => call.query.includes('mutation')).length + this.comments.length; }
}

async function fixture(t: TestContext, run: (f: {
  fake: Workspace; home: string; stdin: (value: string) => void;
  cli: (...args: string[]) => Promise<void>;
  setList: (lists: Record<string, string[]> | undefined) => Promise<void>;
  failures: () => Promise<Array<Record<string, unknown>>>;
}) => Promise<void>) {
  await withTempAnimaHome(async (home) => {
    const fake = new Workspace();
    const { service } = await seedLinear(home, fake);
    // A session a listed person opened.
    const event = created();
    event.agentSession.creatorId = listed.id;
    event.agentSession.creator = { name: 'Nicholas' };
    await service.receive(event, install);
    const [item] = await new WakeQueueService('scout').list(); await service.markStarted(item!, item!.id);
    t.mock.method(globalThis, 'fetch', fake.fetch);
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    let input = '';
    t.mock.getter(process, 'stdin', () => Readable.from([input]) as typeof process.stdin);
    const setList = async (lists: Record<string, string[]> | undefined) => { await serverConfigStore.update((config) => ({ ...config, linearDoNotContact: lists })); };
    await setList({ [install.organizationId]: [listed.id] });
    await run({
      fake, home, stdin: (value) => { input = value; },
      cli: async (...args) => { const cli = new Command(); registerLinearCommands(cli); await cli.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', ...args]); },
      setList,
      failures: async () => (await activityServiceForAgent('scout').readAll()).filter((r) => r.type === 'tool.call.failed').map((r) => r.payload ?? {}),
    });
  });
}

const refused = /Not sent\. (nicholas \([0-9a-f-]{36}\)|[0-9a-f-]{36}) is on this Linear workspace's do-not-contact list.*do not try another command, agent or API call.*hand it to your human owner/;

test('reply, comment, start and respond refuse an @displayName or profile URL mention before any write', async (t) => fixture(t, async ({ fake, stdin, cli, failures }) => {
  const cases: Array<[string, string[], string]> = [
    ['anima.linear.reply', ['reply', '--to', `session:${sessionId}`], 'Thanks, @Nicholas, done.'],
    ['anima.linear.reply', ['reply', '--to', `comment:${randomUUID()}`], `See ${listed.url}`],
    ['anima.linear.reply', ['reply', '--to', 'issue:SYN-1'], `cc [Nicholas](${listed.url.replace('https://', 'http://')}/)`],
    ['anima.linear.comment', ['comment', '--issue', 'SYN-1'], '@nicholas please look'],
    ['anima.linear.start', ['start', '--issue', 'SYN-1'], 'Starting; will ping @nicholas.'],
    ['anima.linear.respond', ['respond', '--session', sessionId], '(@nicholas)'],
  ];
  for (const [tool, args, body] of cases) {
    stdin(body);
    await assert.rejects(cli(...args), refused, `${tool}: ${body}`);
  }
  assert.equal(fake.mutations(), 0);
  assert.equal(fake.posts.length, 0);
  const records = await failures();
  assert.deepEqual(records.map((r) => [r.tool, r.platform, r.failureKind]), cases.map(([tool]) => [tool, 'linear', 'do-not-contact']));
  // No started or completed record: nothing was attempted.
  assert.ok(!(await activityServiceForAgent('scout').readAll()).some((r) => r.type === 'tool.call.started' || r.type === 'external.effect.completed'));
}));

test('answering a session the listed person opened, without a mention, is not blocked', async (t) => fixture(t, async ({ fake, stdin, cli, failures }) => {
  stdin('Here is the result you asked for.');
  await cli('reply', '--to', `session:${sessionId}`);
  assert.equal(fake.posts.length, 1);
  stdin('A comment for the thread they started.');
  await cli('reply', '--to', 'issue:SYN-1');
  assert.equal(fake.comments.length, 1);
  assert.equal(fake.lookups, 0, 'no mention text, no lookup');
  assert.deepEqual(await failures(), []);
}));

test('other mentions, look-alike names and mention text inside code pass', async (t) => fixture(t, async ({ fake, stdin, cli, failures }) => {
  for (const body of ['ping @nora', 'not @nicholas2 or @nicholas-bot', 'mail a@nicholas.dev', `profile ${listed.url}2`]) {
    stdin(body); await cli('reply', '--to', 'issue:SYN-1');
  }
  assert.equal(fake.lookups, 4);
  stdin('Use `@nicholas` here, and:\n\n```\nlinear.app/synthetic/profiles/nicholas\n```\n');
  await cli('reply', '--to', 'issue:SYN-1');
  assert.equal(fake.lookups, 4, 'code removed, nothing left to look up');
  assert.equal(fake.comments.length, 5);
  // An unclosed fence is checked, not trusted.
  stdin('```\n@nicholas'); await assert.rejects(cli('reply', '--to', 'issue:SYN-1'), refused);
  // An escaped backtick does not open a code span.
  stdin('\\`@nicholas\\`'); await assert.rejects(cli('reply', '--to', 'issue:SYN-1'), refused);
  assert.equal(fake.comments.length, 5);
  assert.equal((await failures()).length, 2);
}));

test('api mutations are refused for assigneeId, subscriberIds, bodyData mention nodes and inline text; reads pass', async (t) => fixture(t, async ({ fake, stdin, cli, failures }) => {
  const mutation = (query: string, variables: Record<string, unknown> = {}) => JSON.stringify({ query, variables });
  const writes = [
    mutation('mutation($id:String!,$input:IssueUpdateInput!) { issueUpdate(id:$id,input:$input) { success } }', { id: issue.id, input: { assigneeId: listed.id } }),
    mutation('mutation($input:IssueUpdateInput!) { issueUpdate(id:"SYN-1",input:$input) { success } }', { input: { subscriberIds: [randomUUID(), listed.id.toUpperCase()] } }),
    mutation('mutation($input:CommentCreateInput!) { commentCreate(input:$input) { success } }', { input: { issueId: issue.id, bodyData: JSON.stringify({ type: 'doc', content: [{ type: 'suggestion_userMentions', attrs: { id: listed.id, label: 'Nicholas' } }] }) } }),
    mutation(`mutation { issueUpdate(id:"SYN-1",input:{delegateId:"${listed.id}"}) { success } }`),
    mutation('mutation($input:CommentCreateInput!) { commentCreate(input:$input) { success } }', { input: { issueId: issue.id, body: 'Line one\n@nicholas see `code`' } }),
    mutation('mutation { commentCreate(input:{issueId:"SYN-1",body:"See linear.app/synthetic/profiles/nicholas"}) { success } }'),
  ];
  for (const write of writes) { stdin(write); await assert.rejects(cli('api'), /Not sent\. nicholas \([0-9a-f-]{36}\) is on/, write); }
  assert.equal(fake.mutations(), 0);
  const records = await failures();
  assert.equal(records.length, writes.length);
  assert.ok(records.every((r) => r.tool === 'anima.linear.api' && r.failureKind === 'do-not-contact' && r.operation === 'mutation' && typeof r.callId === 'string'));
  assert.ok(!(await activityServiceForAgent('scout').readAll()).some((r) => r.type === 'tool.call.started'));
  // Reads are unaffected, even when they name the listed person.
  stdin(JSON.stringify({ query: `query { users(filter:{id:{eq:"${listed.id}"}}) { nodes { id displayName } } }` }));
  await cli('api');
  // A write with no mention or ID passes without a lookup.
  stdin(mutation('mutation($input:IssueUpdateInput!) { issueUpdate(id:"SYN-1",input:$input) { success } }', { input: { stateId: 'started-state' } }));
  await cli('api');
  assert.equal(fake.issueState, 'started');
  assert.equal(fake.lookups, 6, 'one name lookup per refusal; none for the read or the plain write');
}));

test('no list for the organization: no lookup and no refusal', async (t) => fixture(t, async ({ fake, stdin, cli, setList, failures }) => {
  for (const lists of [undefined, {}, { [install.organizationId]: [] }, { [randomUUID()]: [listed.id] }]) {
    await setList(lists);
    stdin(`@nicholas ${listed.url}`); await cli('reply', '--to', 'issue:SYN-1');
    stdin(JSON.stringify({ query: 'mutation($input:IssueUpdateInput!) { issueUpdate(id:"SYN-1",input:$input) { success } }', variables: { input: { delegateId: listed.id } } }));
    await cli('api');
  }
  assert.equal(fake.lookups, 0);
  assert.equal(fake.comments.length, 4);
  assert.deepEqual(await failures(), []);
}));

test('a lookup failure holds only writes that could mention someone, and says it is not a match', async (t) => fixture(t, async ({ fake, stdin, cli, failures }) => {
  fake.failLookup = true;
  stdin('ping @nora');
  await assert.rejects(cli('reply', '--to', 'issue:SYN-1'), (error: Error) => {
    assert.match(error.message, /Could not look up .* \(Linear: HTTP 503\).*not a do-not-contact match/);
    assert.doesNotMatch(error.message, /nicholas|synthetic-access/i);
    return true;
  });
  stdin(JSON.stringify({ query: 'mutation { commentCreate(input:{issueId:"SYN-1",body:"@nora"}) { success } }' }));
  await assert.rejects(cli('api'), /Could not look up/);
  assert.equal(fake.mutations(), 0);
  // A listed ID needs no lookup; a body without mention text needs none either.
  stdin(JSON.stringify({ query: `mutation { issueUpdate(id:"SYN-1",input:{delegateId:"${listed.id}"}) { success } }` }));
  await assert.rejects(cli('api'), refused);
  stdin('Plain progress note.'); await cli('reply', '--to', 'issue:SYN-1');
  assert.equal(fake.comments.length, 1);
  assert.deepEqual((await failures()).map((r) => r.failureKind), ['contact-unverified', 'contact-unverified', 'do-not-contact']);
}));

test('an unreadable policy refuses Linear writes without exposing the file', async (t) => fixture(t, async ({ fake, home, stdin, cli, failures }) => {
  await writeFile(join(home, 'config.json'), '{"linearDoNotContact":{"bad":["x"]}, "secret":"do-not-print"}');
  stdin('Plain reply'); await assert.rejects(cli('reply', '--to', 'issue:SYN-1'), (error: Error) => {
    assert.match(error.message, /do-not-contact configuration could not be read or is invalid/);
    assert.doesNotMatch(error.message, /do-not-print/);
    return true;
  });
  assert.equal(fake.comments.length, 0);
  assert.deepEqual((await failures()).map((r) => r.failureKind), ['contact-policy-config']);
}));

test('withoutCode removes closed fences and single-line spans only', () => {
  assert.equal(withoutCode('a `@x` b'), 'a   b');
  assert.equal(withoutCode('a ``x ` y`` b'), 'a   b');
  assert.equal(withoutCode('```js\n@x\n```\nafter'), '\nafter');
  assert.equal(withoutCode('~~~~\n@x\n~~~\n@y\n~~~~'), '');
  assert.equal(withoutCode('```\n@x'), '```\n@x');
  assert.equal(withoutCode('`a\n@x`'), '`a\n@x`');
  assert.equal(withoutCode('\\`@x\\`'), '\\`@x\\`');
});
