import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { z } from 'zod';
import { LinearClient } from '../linear/client.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearIssueService } from '../linear/issue.service.js';
import { managedProviderEnvForAgent } from '../runtime/host.js';
import { registerLinearCommands } from '../tools/linear-cli.js';
import { runLinearApi } from '../tools/linear-api.js';
import { ActivityService, activityServiceForAgent } from '../activities/activity.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { FakeLinear, install, seedLinear } from './helpers/linear.js';
import { linearQueryErrors } from './helpers/linear-schema.js';

const team = { id: randomUUID(), key: 'SYN', name: 'Synthetic team' };
const issue = { id: randomUUID(), identifier: 'SYN-1', title: 'Existing completed issue', url: 'https://linear.app/synthetic/issue/SYN-1' };
const parentId = randomUUID();
const pageInfo = { hasNextPage: true, endCursor: 'next-synthetic-page' };

class Workspace extends FakeLinear {
  requests: Array<{ query: string; variables: Record<string, any>; operationName?: string }> = [];
  auth: string[] = [];
  loseWrite = false;
  partialWrite = false;
  replyRoot: string | null = null;
  fetch: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) {
      this.tokenCalls++;
      await this.tokenGate;
      return Response.json({ access_token: 'refreshed-synthetic-token', refresh_token: 'refreshed-private-token', expires_in: 86400 });
    }
    assert.equal(String(url), 'https://api.linear.app/graphql');
    const request = JSON.parse(String(init?.body));
    const { query, variables } = request;
    this.requests.push(request);
    this.auth.push(new Headers(init?.headers).get('authorization')!);
    assert.deepEqual(linearQueryErrors(query), []);
    if (this.quotaUnauthorized) return Response.json({}, { status: 401 });
    if (query.includes('mutation') && this.loseWrite) throw new Error('do-not-expose-private-http-body');
    if (query.includes('mutation') && this.partialWrite) return Response.json({ data: { commentCreate: { success: true, comment: { id: variables.input.id, body: variables.input.body, url: 'https://linear.app/comment' } } }, errors: [{ message: 'private-server-error' }] });
    let data: unknown;
    if (query.includes('issueCreate')) data = { issueCreate: { success: true, issue: { ...issue, id: variables.input.id, title: variables.input.title } } };
    else if (query.includes('commentCreate')) data = { commentCreate: { success: true, comment: { id: variables.input.id, body: variables.input.body, url: 'https://linear.app/synthetic/comment' } } };
    else if (query.includes('comment(id:')) data = { comment: { issue: { id: issue.id, identifier: issue.identifier }, parent: this.replyRoot ? { id: this.replyRoot } : null } };
    else if (query.includes('searchIssues')) data = { searchIssues: { nodes: [issue], pageInfo } };
    else if (query.includes('teams(')) data = { teams: { nodes: [team], pageInfo } };
    else if (query.includes('issue(id:')) data = { issue: { ...issue, description: 'Previous work', state: { name: 'Done', type: 'completed' }, team,
      comments: { nodes: [{ id: parentId, body: 'Human question', url: 'https://linear.app/synthetic/comment', parent: null, user: { id: randomUUID(), name: 'Human' } }], pageInfo } } };
    else data = { viewer: { id: install.appUserId } };
    return Response.json({ data });
  };
}

test('ordinary Linear actions work without receipts, preserve pagination and reply on completed issues', async () => withTempAnimaHome(async (home) => {
  const fake = new Workspace();
  const { identity, store } = await seedLinear(home, fake);
  const service = new LinearIssueService(identity);
  assert.deepEqual((await store.read()).receipts, {});
  assert.deepEqual(await service.teams({ limit: 2, after: 'team-cursor' }), { nodes: [team], pageInfo });
  assert.equal(fake.requests.at(-1)!.variables.after, 'team-cursor');
  assert.deepEqual(await service.search('quoted "text"', { limit: 3, after: 'issue-cursor' }), { nodes: [issue], pageInfo });
  assert.equal(fake.requests.at(-1)!.variables.term, 'quoted "text"');
  assert.equal(fake.requests.at(-1)!.variables.first, 3);
  const read = await service.read('SYN-1', { after: 'comments-cursor' });
  assert.equal(read.state.type, 'completed'); assert.equal(read.comments.nodes[0]!.id, parentId);
  assert.equal(fake.requests.at(-1)!.variables.after, 'comments-cursor');
  const id = randomUUID();
  assert.equal((await service.create({ id, teamId: team.id, title: 'Proactive issue', description: 'From Slack' })).id, id);
  const comment = await service.comment({ id: randomUUID(), issueId: 'SYN-1', parentId, body: 'More information after completion' });
  assert.equal(comment.body, 'More information after completion');
  assert.equal(fake.requests.at(-1)!.variables.input.parentId, parentId);
  assert.ok(fake.auth.every((value) => value === `Bearer ${install.accessToken}`));
  assert.deepEqual((await store.read()).receipts, {});
  const before = fake.requests.length;
  await assert.rejects(service.teams({ limit: 0 }));
  await assert.rejects(service.create({ id, teamId: 'bad', title: '' }));
  assert.equal(fake.requests.length, before);
  await assert.rejects(service.comment({ id: randomUUID(), issueId: 'SYN-OTHER', parentId, body: 'Wrong issue' }), /does not belong/);
  assert.equal(fake.requests.filter((r) => r.query.includes('commentCreate')).length, 1);
  fake.replyRoot = randomUUID();
  await service.comment({ id: randomUUID(), issueId: issue.id, parentId, body: 'Continue a reply thread' });
  assert.equal(fake.requests.at(-1)!.variables.input.parentId, fake.replyRoot);
}));

test('a lost or partial Linear write is never retried and keeps the caller-supplied id', async () => withTempAnimaHome(async (home) => {
  const fake = new Workspace(); const { identity } = await seedLinear(home, fake);
  const service = new LinearIssueService(identity);
  const id = randomUUID(); fake.loseWrite = true;
  await assert.rejects(service.create({ id, teamId: team.id, title: 'Single attempt' }), /may have succeeded/);
  assert.equal(fake.requests.length, 1); assert.equal(fake.requests[0]!.variables.input.id, id);
  fake.loseWrite = false; fake.partialWrite = true;
  await assert.rejects(service.comment({ id, issueId: issue.id, body: 'Partial result' }), /invalid or rejected/);
  assert.equal(fake.requests.length, 2);
}));

test('Linear credentials refresh once, omit refresh secrets, and cannot escape an identity change', async () => withTempAnimaHome(async (home) => {
  const fake = new Workspace(); const { identity, store, agentStore } = await seedLinear(home, fake);
  await store.update((f) => ({ ...f, installation: { ...f.installation!, expiresAt: 0 } }));
  const tokens = await Promise.all([identity.credentials(), identity.credentials()]);
  assert.equal(fake.tokenCalls, 1);
  for (const token of tokens) {
    assert.equal(token.accessToken, 'refreshed-synthetic-token'); assert.ok(Date.parse(token.expiresAt) > Date.now());
    assert.equal('refreshToken' in token, false); assert.equal('signingSecret' in token, false);
  }
  await store.update((f) => ({ ...f, installation: { ...f.installation!, expiresAt: 0 } }));
  let release!: () => void; let entered!: () => void;
  const didEnter = new Promise<void>((r) => { entered = r; });
  fake.tokenGate = new Promise<void>((r) => { release = r; });
  const client = new LinearClient(async (url, init) => { entered(); return fake.fetch(url, init); });
  const pending = new LinearIdentityService('scout', client, store).credentials();
  await didEnter;
  await agentStore.update((a) => ({ ...a, enabled: false }));
  release(); await assert.rejects(pending, /disabled/);
  await assert.rejects(identity.request('query { viewer { id } }', {}, z.unknown()), /disabled/);
  assert.equal(fake.requests.length, 0);
}));

test('managed child environment gets a Linear token in the selected home; failure leaves Slack available', async (t) => withTempAnimaHome(async (home) => {
  const fake = new Workspace(); const { agentStore, store } = await seedLinear(home, fake);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const warnings: string[] = []; t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  await store.update((f) => ({ ...f, installation: { ...f.installation!, expiresAt: 0 } }));
  const agent = await agentStore.read();
  const env = await managedProviderEnvForAgent(agent, home, 'synthetic-slack');
  assert.equal(env.LINEAR_ACCESS_TOKEN, 'refreshed-synthetic-token');
  assert.ok(Date.parse(env.LINEAR_ACCESS_TOKEN_EXPIRES_AT!) > Date.now());
  assert.equal(env.SLACK_BOT_TOKEN, 'synthetic-slack'); assert.equal(env.ANIMA_HOME, home);
  assert.doesNotMatch(JSON.stringify(env), /refreshed-private-token|signing-secret/);
  await store.update((f) => ({ ...f, installation: { ...f.installation!, revoked: true } }));
  const disconnected = await managedProviderEnvForAgent(agent, home, 'synthetic-slack');
  assert.equal(disconnected.LINEAR_ACCESS_TOKEN, undefined); assert.equal(disconnected.SLACK_BOT_TOKEN, 'synthetic-slack');
  assert.equal(warnings.length, 1); assert.doesNotMatch(warnings.join(), /sentinel|refreshed/);
  assert.doesNotMatch(warnings.join(), /anima linear token/);
  assert.match(warnings.join(), /commands refresh them on demand/);
}));

test('registered Linear CLI creates and comments proactively, records outbox, and audits API metadata without token or request content', async (t) => withTempAnimaHome(async (home) => {
  const fake = new Workspace(); const { store } = await seedLinear(home, fake);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const output: string[] = []; const diagnostics: string[] = [];
  t.mock.method(console, 'log', (line: string) => output.push(line));
  t.mock.method(console, 'error', (line: string) => diagnostics.push(line));
  let stdin = '';
  t.mock.getter(process, 'stdin', () => Readable.from([stdin]) as typeof process.stdin);
  const run = async (...args: string[]) => {
    const command = new Command(); registerLinearCommands(command);
    await command.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', ...args]);
    return JSON.parse(output.at(-1)!);
  };
  assert.equal((await run('teams')).nodes[0].id, team.id);
  assert.equal((await run('search', 'original work')).nodes[0].identifier, 'SYN-1');
  assert.equal((await run('issue', 'SYN-1')).comments.nodes[0].id, parentId);
  stdin = 'Proactive description'; const created = await run('create', '--team', team.id, '--title', 'From Slack');
  assert.match(diagnostics.at(-1)!, new RegExp(created.id));
  stdin = 'An ordinary reply'; const commented = await run('comment', '--issue', issue.id, '--reply-to', parentId);
  const messages = await messageServiceForAgent('scout').list();
  assert.ok(messages.entries.some((m) => m.direction === 'out' && m.platform === 'linear' && m.text === 'An ordinary reply' && m.threadTs === parentId));
  assert.ok(messages.entries.some((m) => m.channelId === created.id && m.text === 'From Slack\n\nProactive description' && m.permalink === created.url));
  fake.replyRoot = randomUUID();
  stdin = 'Continue the same thread'; const reply = await run('comment', '--issue', issue.id, '--reply-to', parentId);
  assert.equal(reply.parentId, fake.replyRoot);
  stdin = 'Start a new discussion'; const root = await run('comment', '--issue', issue.id);
  const threaded = (await messageServiceForAgent('scout').list()).entries;
  assert.equal(threaded.find((m) => m.text === 'Continue the same thread')?.threadTs, fake.replyRoot);
  assert.equal(threaded.find((m) => m.text === 'Start a new discussion')?.threadTs, root.id);
  const auditBefore = await activityServiceForAgent('scout').readAll();
  const token = await run('token'); assert.equal(token.accessToken, install.accessToken); assert.equal(token.refreshToken, undefined);
  assert.deepEqual(await activityServiceForAgent('scout').readAll(), auditBefore);
  stdin = JSON.stringify({ query: 'query First { viewer { id } } query Second { viewer { id } }', variables: {}, operationName: 'Second' });
  assert.equal((await run('api')).viewer.id, install.appUserId);
  assert.equal(fake.requests.at(-1)!.operationName, 'Second');
  assert.doesNotMatch(JSON.stringify(await messageServiceForAgent('scout').list()), /access-sentinel|refresh-sentinel|query First/);
  const apiAudit = (await activityServiceForAgent('scout').readAll()).slice(auditBefore.length);
  assert.deepEqual(apiAudit.map((a) => a.type), ['tool.call.started', 'tool.call.completed']);
  assert.ok(apiAudit.every((a) => a.payload?.operation === 'query'));
  assert.doesNotMatch(JSON.stringify(apiAudit), /query First|Second|access-sentinel|refresh-sentinel/);
  assert.equal(commented.body, 'An ordinary reply'); assert.deepEqual((await store.read()).receipts, {});
}));

test('raw Linear mutations correlate metadata while names, literals, variables and results stay private', async (t) => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear();
  const result = { issueDelete: { success: false, privateResult: 'PRIVATE_RESULT_SENTINEL' } };
  let requests = 0;
  fake.fetch = async (_url, init) => {
    requests++;
    assert.equal(JSON.parse(String(init?.body)).operationName, 'PrivateOperationName');
    return Response.json({ data: result });
  };
  const { identity } = await seedLinear(home, fake);
  const previous = process.env.ANIMA_INBOX_ITEM_ID;
  process.env.ANIMA_INBOX_ITEM_ID = 'synthetic-api-run';
  t.after(() => { if (previous === undefined) delete process.env.ANIMA_INBOX_ITEM_ID; else process.env.ANIMA_INBOX_ITEM_ID = previous; });
  const input = {
    query: '# PRIVATE_COMMENT_SENTINEL\nquery Other { viewer { id } } mutation PrivateOperationName($secret:String!) { privateAlias: issueDelete(id:$secret) { success } }',
    operationName: 'PrivateOperationName', variables: { secret: 'PRIVATE_VARIABLE_SENTINEL' },
  };
  assert.deepEqual(await runLinearApi(identity, input), result);
  const rows = await activityServiceForAgent('scout').readAll();
  assert.equal(requests, 1);
  assert.deepEqual(rows.map((r) => r.type), ['tool.call.started', 'tool.call.completed']);
  assert.equal(rows[0]!.payload?.callId, rows[1]!.payload?.callId);
  assert.match(String(rows[0]!.payload?.callId), /^[0-9a-f-]{36}$/);
  for (const row of rows) {
    assert.equal(row.payload?.itemId, 'synthetic-api-run');
    assert.equal(row.payload?.operation, 'mutation');
    assert.equal(row.payload?.tool, 'anima.linear.api');
    assert.equal(row.payload?.platform, 'linear');
    assert.deepEqual(Object.keys(row.payload ?? {}).sort(), ['callId', 'itemId', 'operation', ...(row.type.endsWith('completed') ? ['outcome'] : []), 'platform', 'status', 'tool'].sort());
  }
  assert.equal(rows[1]!.payload?.outcome, 'request_completed', 'HTTP success does not claim mutation success:true');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|PrivateOperationName|privateAlias|issueDelete|secret|access-sentinel/);
  assert.equal((await messageServiceForAgent('scout').list()).entries.length, 0);
}));

for (const mode of ['network', 'partial', 'invalid-json', 'unauthorized'] as const) test(`raw Linear API records uncertainty without response content or retry: ${mode}`, async () => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(); let requests = 0;
  fake.fetch = async () => {
    requests++;
    if (mode === 'network') throw new Error('PRIVATE_NETWORK_SENTINEL');
    if (mode === 'partial') return Response.json({ data: { privateData: 'PRIVATE_RESULT_SENTINEL' }, errors: [{ message: 'PRIVATE_ERROR_SENTINEL' }] });
    if (mode === 'invalid-json') return new Response('PRIVATE_INVALID_SENTINEL');
    return new Response('PRIVATE_UNAUTHORIZED_SENTINEL', { status: 401 });
  };
  const { identity } = await seedLinear(home, fake);
  await assert.rejects(runLinearApi(identity, { query: 'mutation HiddenName { privateAlias: issueDelete(id:"PRIVATE_LITERAL_SENTINEL") { success } }', variables: {} }));
  const rows = await activityServiceForAgent('scout').readAll();
  assert.deepEqual(rows.map((r) => r.type), ['tool.call.started', 'tool.call.failed']);
  assert.equal(rows[1]!.payload?.outcome, 'unknown');
  assert.equal(rows[1]!.payload?.callId, rows[0]!.payload?.callId);
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|HiddenName|privateAlias|issueDelete|sentinel/);
  assert.equal((await messageServiceForAgent('scout').list()).entries.length, 0);
}));

for (const stage of ['started', 'completed', 'failed'] as const) test(`Linear API audit failure at ${stage} never resends or conceals the API result`, async (t) => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(); let requests = 0;
  fake.fetch = async () => { requests++; if (stage === 'failed') throw new Error('PRIVATE_NETWORK_SENTINEL'); return Response.json({ data: { ok: true } }); };
  const { identity } = await seedLinear(home, fake);
  const record = ActivityService.prototype.record;
  t.mock.method(ActivityService.prototype, 'record', async function (this: ActivityService, input: Parameters<ActivityService['record']>[0]) {
    if (input.type === `tool.call.${stage}`) throw new Error('PRIVATE_AUDIT_SENTINEL');
    return record.call(this, input);
  });
  const warnings: string[] = [];
  t.mock.method(console, 'error', (message: string) => warnings.push(message));
  const request = runLinearApi(identity, { query: 'mutation { issueDelete(id:"PRIVATE_LITERAL_SENTINEL") { success } }', variables: {} });
  if (stage === 'completed') await assert.doesNotReject(async () => { assert.deepEqual(await request, { ok: true }); });
  else await assert.rejects(request, stage === 'started' ? /no request was sent/ : /Linear request failed/);
  assert.equal(requests, stage === 'started' ? 0 : 1);
  const rows = await activityServiceForAgent('scout').readAll();
  assert.equal(rows.length, stage === 'started' ? 0 : 1);
  assert.doesNotMatch(JSON.stringify([rows, warnings]), /PRIVATE_|sentinel|issueDelete/);
  assert.equal((await messageServiceForAgent('scout').list()).entries.length, 0);
}));

test('API operation classification follows selection and never changes arbitrary request forwarding', async (t) => withTempAnimaHome(async (home) => {
  const { identity } = await seedLinear(home);
  const calls: string[] = [];
  t.mock.method(identity, 'request', async (query: string) => { calls.push(query); return {}; });
  const cases = [
    { query: '{ viewer { id } }', operation: 'query' },
    { query: 'query Q { viewer { ...F } } fragment F on User { id }', operation: 'query' },
    { query: 'mutation M { issueDelete(id:"literal") { success } } query Q { viewer { id } }', operationName: 'Q', operation: 'query' },
    { query: 'query Q { viewer { id } } mutation M { issueDelete(id:"literal") { success } }', operationName: 'M', operation: 'mutation' },
    { query: 'query Q { viewer { id } } mutation M { issueDelete(id:"literal") { success } }', operation: 'unknown' },
    { query: 'query malformed { PRIVATE_FIELD_SENTINEL(', operation: 'unknown' },
  ];
  for (const input of cases) {
    await runLinearApi(identity, { query: input.query, variables: {}, operationName: input.operationName });
    const row = (await activityServiceForAgent('scout').readAll()).at(-1)!;
    assert.equal(row.payload?.operation, input.operation);
  }
  assert.deepEqual(calls, cases.map((c) => c.query));
  const rows = await activityServiceForAgent('scout').readAll();
  assert.equal(new Set(rows.map((r) => r.payload?.callId)).size, cases.length);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|literal|issueDelete/);
}));

test('API audit keeps the inherited run when the active-item lookup fails without exposing its error', async (t) => withTempAnimaHome(async (home) => {
  const { identity } = await seedLinear(home);
  t.mock.method(WakeQueueService.prototype, 'list', async () => { throw new Error('PRIVATE_QUEUE_ERROR_SENTINEL'); });
  t.mock.method(identity, 'request', async () => ({ ok: true }));
  const warnings: string[] = [];
  t.mock.method(console, 'error', (message: string) => warnings.push(message));
  const previous = process.env.ANIMA_INBOX_ITEM_ID;
  t.after(() => { if (previous === undefined) delete process.env.ANIMA_INBOX_ITEM_ID; else process.env.ANIMA_INBOX_ITEM_ID = previous; });
  process.env.ANIMA_INBOX_ITEM_ID = '  inherited-api-run  ';
  assert.deepEqual(await runLinearApi(identity, { query: '{ viewer { id } }', variables: {} }), { ok: true });
  process.env.ANIMA_INBOX_ITEM_ID = '  ';
  assert.deepEqual(await runLinearApi(identity, { query: '{ viewer { id } }', variables: {} }), { ok: true });
  const rows = await activityServiceForAgent('scout').readAll();
  assert.deepEqual(rows.map((r) => r.payload?.itemId), ['inherited-api-run', 'inherited-api-run', undefined, undefined]);
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(JSON.stringify([rows, warnings]), /PRIVATE_QUEUE_ERROR_SENTINEL/);
}));
