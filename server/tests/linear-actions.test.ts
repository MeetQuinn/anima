import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { z } from 'zod';
import { LinearClient } from '../linear/client.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearCommentService } from '../linear/comment.service.js';
import { managedProviderEnvForAgent } from '../runtime/host.js';
import { registerLinearCommands } from '../tools/linear-cli.js';
import { runLinearApi } from '../tools/linear-api.js';
import { ActivityService, activityServiceForAgent } from '../activities/activity.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { FakeLinear, install, seedLinear, created, prompted, sessionId } from './helpers/linear.js';
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
  commentOffIssue = false;
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
    else if (query.includes('commentCreate')) data = { commentCreate: { success: true, comment: { id: variables.input.id, body: variables.input.body, url: 'https://linear.app/synthetic/comment', issue } } };
    else if (query.includes('comment(id:')) data = { comment: { issue: this.commentOffIssue ? null : { id: issue.id, identifier: issue.identifier }, parent: this.replyRoot ? { id: this.replyRoot } : null } };
    else if (query.includes('searchIssues')) data = { searchIssues: { nodes: [issue], pageInfo } };
    else if (query.includes('teams(')) data = { teams: { nodes: [team], pageInfo } };
    else if (query.includes('issue(id:')) data = { issue: { ...issue, description: 'Previous work', state: { name: 'Done', type: 'completed' }, team,
      comments: { nodes: [{ id: parentId, body: 'Human question', url: 'https://linear.app/synthetic/comment', parent: null, user: { id: randomUUID(), name: 'Human' } }], pageInfo } } };
    else data = { viewer: { id: install.appUserId } };
    return Response.json({ data });
  };
}

test('ordinary Linear comments work without receipts and preserve reply targets', async () => withTempAnimaHome(async (home) => {
  const fake = new Workspace();
  const { identity, store } = await seedLinear(home, fake);
  const service = new LinearCommentService(identity);
  assert.deepEqual((await store.read()).receipts, {});
  const comment = await service.comment({ id: randomUUID(), issueId: 'SYN-1', parentId, body: 'More information after completion' });
  assert.equal(comment.body, 'More information after completion');
  assert.equal(fake.requests.at(-1)!.variables.input.parentId, parentId);
  assert.ok(fake.auth.every((value) => value === `Bearer ${install.accessToken}`));
  assert.deepEqual((await store.read()).receipts, {});
  const before = fake.requests.length;
  await assert.rejects(service.comment({ id: randomUUID(), issueId: issue.id, body: '' }));
  assert.equal(fake.requests.length, before);
  await assert.rejects(service.comment({ id: randomUUID(), issueId: 'SYN-OTHER', parentId, body: 'Wrong issue' }), /does not belong/);
  assert.equal(fake.requests.filter((r) => r.query.includes('commentCreate')).length, 1);
  fake.replyRoot = randomUUID();
  await service.comment({ id: randomUUID(), issueId: issue.id, parentId, body: 'Continue a reply thread' });
  assert.equal(fake.requests.at(-1)!.variables.input.parentId, fake.replyRoot);
}));

test('one reply command answers a comment thread at its root or comments on an issue, and refuses misuse before any request', async (t) => withTempAnimaHome(async (home) => {
  const fake = new Workspace(); await seedLinear(home, fake);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const output: string[] = []; const diagnostics: string[] = [];
  t.mock.method(console, 'log', (line: string) => output.push(line));
  t.mock.method(console, 'error', (line: string) => diagnostics.push(line));
  let stdin = '';
  t.mock.getter(process, 'stdin', () => Readable.from([stdin]) as typeof process.stdin);
  const run = async (...args: string[]) => { const cli = new Command(); registerLinearCommands(cli); await cli.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', ...args]); };
  const creates = () => fake.requests.filter((r) => r.query.includes('commentCreate')).map((r) => r.variables.input);
  // A target inside a thread continues at its root, on the comment's own issue.
  const root = randomUUID(); fake.replyRoot = root;
  stdin = 'Thread answer'; await run('reply', '--to', `comment:${parentId}`);
  assert.deepEqual({ ...creates().at(-1), id: undefined }, { id: undefined, issueId: issue.id, parentId: root, body: 'Thread answer' });
  assert.match(output.at(-1)!, /^Linear accepted comment /);
  assert.ok(diagnostics.some((line) => line.includes(creates().at(-1)!.id)), 'The comment id is printed before sending');
  // A root comment is its own thread. Questions and errors are ordinary comments here.
  fake.replyRoot = null;
  const id = randomUUID();
  stdin = 'Which option?'; await run('reply', '--to', `comment:${parentId}`, '--kind', 'elicitation', '--id', id);
  assert.deepEqual(creates().at(-1), { id, issueId: issue.id, parentId, body: 'Which option?' });
  stdin = 'New discussion'; await run('reply', '--to', 'issue:SYN-1');
  assert.equal(creates().at(-1)!.issueId, 'SYN-1'); assert.equal(creates().at(-1)!.parentId, undefined);
  const outbox = (await messageServiceForAgent('scout').list()).entries.filter((m) => m.direction === 'out');
  assert.deepEqual(outbox.map((m) => [m.text, m.channelId, m.threadTs]).reverse(), [
    ['Thread answer', issue.id, root], ['Which option?', issue.id, parentId], ['New discussion', issue.id, creates().at(-1)!.id]]);
  assert.ok(outbox.every((m) => m.issueKey === issue.identifier && m.issueTitle === issue.title && m.permalink === issue.url));
  const requests = fake.requests.length;
  stdin = 'Started';
  await assert.rejects(run('reply', '--to', `comment:${parentId}`, '--kind', 'thought'), /Progress updates go only to work sessions/);
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--kind', 'thought'), /Progress updates go only to work sessions/);
  await assert.rejects(run('reply', '--to', `session:${randomUUID()}`, '--id', randomUUID()), /--id applies to comment and issue targets/);
  await assert.rejects(run('reply', '--to', parentId), /reply_to value from the Linear envelope/);
  await assert.rejects(run('reply', '--to', `comment:${parentId}`, '--kind', 'shout'));
  stdin = '  '; await assert.rejects(run('reply', '--to', `comment:${parentId}`));
  assert.equal(fake.requests.length, requests);
  // A comment Linear cannot place on a reachable issue is refused before any write.
  fake.commentOffIssue = true; stdin = 'Lost thread';
  await assert.rejects(run('reply', '--to', `comment:${parentId}`), /not on an issue this app can reach/);
  assert.equal(creates().length, 3);
}));

test('a lost or partial Linear write is never retried and keeps the caller-supplied id', async () => withTempAnimaHome(async (home) => {
  const fake = new Workspace(); const { identity } = await seedLinear(home, fake);
  const service = new LinearCommentService(identity);
  const id = randomUUID(); fake.loseWrite = true;
  await assert.rejects(service.comment({ id, issueId: issue.id, body: 'Single attempt' }), /may have succeeded/);
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

test('the real token command keeps credentials off both output streams on every path', async () => withTempAnimaHome(async (home) => {
  await seedLinear(home);
  const cli = async (...args: string[]) => {
    const child = spawn(process.execPath, [resolve('dist/server/cli/anima.js'), 'linear', '--agent', 'scout', 'token', ...args], {
      env: { ...process.env, ANIMA_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; }); child.stderr.on('data', (chunk: string) => { out += chunk; });
    // `close` waits for both pipes to drain, so a write just before exit is still checked.
    const [status] = (await once(child, 'close')) as [number | null];
    for (const secret of [install.accessToken, install.refreshToken, install.clientSecret!, install.signingSecret]) {
      assert.ok(!out.includes(secret), `token ${args.join(' ') || '(no program)'} printed a credential`);
    }
    return { status, out };
  };
  const bare = await cli();
  assert.notEqual(bare.status, 0); assert.match(bare.out, /Name the program that needs the token/);
  const envFile = join(home, 'cli-token-env.json');
  const ok = await cli('--', process.execPath, '-e',
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ token: process.env.LINEAR_ACCESS_TOKEN, refresh: process.env.LINEAR_REFRESH_TOKEN ?? null }))", envFile);
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(await readFile(envFile, 'utf8')), { token: install.accessToken, refresh: null });
  assert.equal((await cli('--', process.execPath, '-e', 'process.exit(42)')).status, 42);
  const missing = await cli('--', join(home, 'no-such-program'));
  assert.notEqual(missing.status, 0); assert.match(missing.out, /ENOENT/);
}));

test('registered Linear CLI comments proactively, records outbox, and audits API metadata without token or request content', async (t) => withTempAnimaHome(async (home) => {
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
  const markdown = '**Done**\n\n- Fixed `pagination`\n- [PR](https://example.com/pr)\n\n```ts\nconst ok = true;\n```';
  stdin = markdown; const commented = await run('comment', '--issue', issue.id, '--reply-to', parentId);
  const messages = await messageServiceForAgent('scout').list();
  assert.ok(messages.entries.some((m) => m.direction === 'out' && m.platform === 'linear' && m.text === markdown && m.threadTs === parentId));
  assert.ok(messages.entries.every((m) => m.issueKey === issue.identifier && m.issueTitle === issue.title && m.permalink === issue.url));
  fake.replyRoot = randomUUID();
  stdin = 'Continue the same thread'; const reply = await run('comment', '--issue', issue.id, '--reply-to', parentId);
  assert.equal(reply.parentId, fake.replyRoot);
  stdin = 'Start a new discussion'; const root = await run('comment', '--issue', issue.id);
  const threaded = (await messageServiceForAgent('scout').list()).entries;
  assert.equal(threaded.find((m) => m.text === 'Continue the same thread')?.threadTs, fake.replyRoot);
  assert.equal(threaded.find((m) => m.text === 'Start a new discussion')?.threadTs, root.id);
  const auditBefore = await activityServiceForAgent('scout').readAll();
  // The token reaches only the named program's environment; nothing prints it.
  const runToken = async (...args: string[]) => {
    const command = new Command(); registerLinearCommands(command);
    await command.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', 'token', ...args]);
  };
  const printedBefore = output.length;
  await assert.rejects(runToken(), /Name the program that needs the token: anima linear token -- <command>/);
  const envFile = join(home, 'token-env.json');
  const keys = ['LINEAR_ACCESS_TOKEN', 'LINEAR_ACCESS_TOKEN_EXPIRES_AT', 'LINEAR_ORGANIZATION_ID', 'LINEAR_APP_USER_ID', 'LINEAR_REFRESH_TOKEN'];
  const writeEnv = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k] ?? null]))))`;
  try {
    await runToken('--', process.execPath, '-e', writeEnv, envFile);
    assert.equal(process.exitCode, 0);
    const env = JSON.parse(await readFile(envFile, 'utf8')) as Record<string, string | null>;
    assert.deepEqual({ ...env, LINEAR_ACCESS_TOKEN_EXPIRES_AT: null }, { LINEAR_ACCESS_TOKEN: install.accessToken, LINEAR_ACCESS_TOKEN_EXPIRES_AT: null,
      LINEAR_ORGANIZATION_ID: install.organizationId, LINEAR_APP_USER_ID: install.appUserId, LINEAR_REFRESH_TOKEN: null });
    assert.ok(!Number.isNaN(Date.parse(env.LINEAR_ACCESS_TOKEN_EXPIRES_AT!)));
    await runToken('--', process.execPath, '-e', 'process.exit(3)');
    assert.equal(process.exitCode, 3, 'The program exit status is the command status');
  } finally { process.exitCode = undefined; }
  assert.equal(output.length, printedBefore);
  assert.doesNotMatch([...output, ...diagnostics].join('\n'), /synthetic-access-sentinel|synthetic-refresh-sentinel/);
  assert.deepEqual(await activityServiceForAgent('scout').readAll(), auditBefore);
  stdin = JSON.stringify({ query: 'query First { viewer { id } } query Second { viewer { id } }', variables: {}, operationName: 'Second' });
  assert.equal((await run('api')).viewer.id, install.appUserId);
  assert.equal(fake.requests.at(-1)!.operationName, 'Second');
  assert.doesNotMatch(JSON.stringify(await messageServiceForAgent('scout').list()), /access-sentinel|refresh-sentinel|query First/);
  const apiAudit = (await activityServiceForAgent('scout').readAll()).slice(auditBefore.length);
  assert.deepEqual(apiAudit.map((a) => a.type), ['tool.call.started', 'tool.call.completed']);
  assert.ok(apiAudit.every((a) => a.payload?.operation === 'query'));
  assert.doesNotMatch(JSON.stringify(apiAudit), /query First|Second|access-sentinel|refresh-sentinel/);
  assert.equal(commented.body, markdown);
  assert.equal(fake.requests.find((r) => r.query.includes('commentCreate'))!.variables.input.body, markdown);
  assert.ok((await activityServiceForAgent('scout').readAll()).some((r) => r.type === 'external.effect.completed' && r.payload?.text === markdown)); assert.deepEqual((await store.read()).receipts, {});
}));

test('raw Linear mutations correlate metadata while operation names, aliases, literals, variables and results stay private', async (t) => withTempAnimaHome(async (home) => {
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
    assert.deepEqual(row.payload?.fields, ['issueDelete'], 'the schema field, not its alias');
    assert.deepEqual(Object.keys(row.payload ?? {}).sort(), ['callId', 'fields', 'itemId', 'operation', ...(row.type.endsWith('completed') ? ['outcome'] : []), 'platform', 'status', 'tool'].sort());
  }
  assert.equal(rows[1]!.payload?.outcome, 'request_completed', 'HTTP success does not claim mutation success:true');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|PrivateOperationName|privateAlias|secret|access-sentinel/);
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
  assert.ok(rows.every((r) => JSON.stringify(r.payload?.fields) === '["issueDelete"]'));
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|HiddenName|privateAlias|sentinel/);
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
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|sentinel/);
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_|sentinel|issueDelete/);
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
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|literal/);
}));

test('API audit keeps top-level schema field names and an exact issue key, never query text, aliases or other variables', async (t) => withTempAnimaHome(async (home) => {
  const { identity } = await seedLinear(home);
  t.mock.method(identity, 'request', async () => ({}));
  const cases: { query: string; variables?: Record<string, unknown>; operationName?: string; fields?: string[]; issueKey?: string }[] = [
    { query: 'query PRIVATE_NAME($id:String!) { PRIVATE_ALIAS: issue(id:$id) { PRIVATE_NESTED: title } }', variables: { id: 'ANI-11' }, fields: ['issue'], issueKey: 'ANI-11' },
    { query: 'mutation($id:String!,$input:IssueUpdateInput!) { issueUpdate(id:$id,input:$input) { success } }', variables: { id: 'ANI-11', input: { title: 'PRIVATE_TITLE' } }, fields: ['issueUpdate'], issueKey: 'ANI-11' },
    // Only a whole top-level variable is an issue key; nothing nested, padded or embedded.
    { query: 'mutation($input:CommentCreateInput!) { commentCreate(input:$input) { success } }', variables: { input: { issueId: 'ANI-11', body: 'PRIVATE_BODY ANI-12' } }, fields: ['commentCreate'] },
    ...[' ANI-11', 'ANI-11 ', 'PRIVATE ANI-11', 'ANI-11 PRIVATE', 'ani-11', 'ANI-011', 'ANI-', ['ANI-11'], { id: 'ANI-11' }, 11].map((a) => (
      { query: 'query($a:String) { issue(id:$a) { id } }', variables: { a }, fields: ['issue'] })),
    { query: 'query($a:String,$b:String) { issue(id:$a) { id } }', variables: { a: 'ANI-11', b: 'ANI-12' }, fields: ['issue'] },
    { query: 'query($a:String,$b:String) { issue(id:$a) { id } }', variables: { a: 'ANI-11', b: 'ANI-11' }, fields: ['issue'], issueKey: 'ANI-11' },
    { query: '{ PRIVATE_A: issue(id:"PRIVATE_LITERAL") { id } PRIVATE_B: issue(id:"PRIVATE_LITERAL_2") { id } }', fields: ['issue'] },
    { query: '{ a1: viewer { id } teams { nodes { id } } issues { nodes { id } } organization { id } comments { nodes { id } } searchIssues(term:"PRIVATE_TERM") { nodes { id } } issue(id:"x") { id } }', fields: ['viewer', 'teams', 'issues', 'organization', 'comments'] },
    { query: 'query { ...PRIVATE_FRAGMENT ... on Query { teams { nodes { id } } } } fragment PRIVATE_FRAGMENT on Query { viewer { id } }', fields: ['viewer', 'teams'] },
    { query: 'query { ...A } fragment A on Query { ...B } fragment B on Query { ...A viewer { id } }', fields: ['viewer'] },
    { query: `{ PRIVATE_${'x'.repeat(60)} { id } viewer { id } }`, fields: ['viewer'] },
    { query: 'query Q { viewer { id } } mutation M { issueDelete(id:"x") { success } }', variables: { id: 'ANI-11' } },
    { query: 'query malformed { PRIVATE_FIELD(', variables: { id: 'ANI-11' } },
  ];
  for (const input of cases) {
    const before = (await activityServiceForAgent('scout').readAll()).length;
    await runLinearApi(identity, { query: input.query, variables: input.variables ?? {}, operationName: input.operationName });
    const rows = (await activityServiceForAgent('scout').readAll()).slice(before);
    assert.equal(rows.length, 2, input.query);
    for (const row of rows) {
      assert.deepEqual(row.payload?.fields, input.fields, input.query);
      assert.equal(row.payload?.issueKey, input.issueKey, input.query);
      for (const key of Object.keys(row.payload ?? {})) assert.ok(['callId', 'fields', 'issueKey', 'itemId', 'operation', 'outcome', 'platform', 'status', 'tool'].includes(key), key);
    }
  }
  assert.doesNotMatch(JSON.stringify(await activityServiceForAgent('scout').readAll()), /PRIVATE|title|ANI-12|ani-11|ANI-011| ANI-11|ANI-11 /);
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


test('removed Linear commands fail before credentials or effects, and help gives the API migration path', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Unexpected network request'); });
  for (const name of ['teams', 'search', 'issue', 'create', 'read', 'attach-pr']) {
    const cli = new Command().exitOverride().configureOutput({ writeErr() {} }); registerLinearCommands(cli);
    await assert.rejects(cli.parseAsync(['node', 'anima', 'linear', name]), /unknown command/);
  }
  const cli = new Command(); registerLinearCommands(cli);
  const linear = cli.commands.find((c) => c.name() === 'linear')!;
  assert.deepEqual(linear.commands.map((c) => c.name()).sort(), ['api', 'comment', 'reply', 'respond', 'start', 'token']);
  let help = ''; linear.configureOutput({ writeOut: (text) => { help += text; } }); linear.outputHelp();
  assert.match(help, /Use api.*session reads/);
  // One visible reply command; the earlier names still work but are not offered.
  assert.match(help, /\n\s+reply \[options\]/);
  assert.doesNotMatch(help, /\n\s+(respond|comment) \[options\]/);
  const guidePath = help.match(/Examples and pagination: (.+)/)?.[1]!;
  assert.equal(isAbsolute(guidePath), true);
  assert.match(await readFile(guidePath, 'utf8'), /# Work in Linear/);
  assert.equal(requests, 0);
});

async function documentedApiExamples() {
  const doc = await readFile('docs/agent/linear.md', 'utf8');
  return [...doc.matchAll(/anima linear api <<'JSON'\n([^]+?)\nJSON/g)].map((m) => JSON.parse(m[1]!));
}

test('every documented Linear API example parses and validates against the schema fixture', async () => {
  const examples = await documentedApiExamples();
  assert.equal(examples.length, 12);
  for (const input of examples) assert.deepEqual(linearQueryErrors(input.query), [], input.query);
  assert.ok(linearQueryErrors('query { agentSession(id:"bad") { activities { nodes { content } } } }').length);
});

test('an agent can read paginated session context through the documented API, then reply once with Markdown and verify outbox', async (t) => withTempAnimaHome(async (home) => {
  const fake = new FakeLinear(), originalFetch = fake.fetch;
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: `context-${i}`, content: { type: 'prompt', body: `Message ${i}` }, createdAt: new Date().toISOString() }));
  fake.fetch = async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (!request.query.includes('activities(first:50')) return originalFetch(url, init);
    assert.deepEqual(linearQueryErrors(request.query), []);
    const start = Number(request.variables.after ?? 0), nodes = rows.slice(start, start + 50), end = start + nodes.length;
    return Response.json({ data: { agentSession: { id: request.variables.id, status: 'active', appUser: { id: install.appUserId }, externalLinks: fake.links.map((url) => ({ url })),
      activities: { nodes, pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) } } } } });
  };
  const { service, store } = await seedLinear(home, fake);
  const event = created();
  event.agentSession.issueId = issue.id;
  event.agentSession.issue = issue;
  await service.receive(event, install);
  const [item] = await new WakeQueueService('scout').list(); await service.markStarted(item!, item!.id);
  await service.receive(prompted(), install); // A follow-up can omit display metadata.
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const output: string[] = []; t.mock.method(console, 'log', (line: string) => { output.push(line); });
  let stdin = ''; t.mock.getter(process, 'stdin', () => Readable.from([stdin]) as typeof process.stdin);
  const run = async (...args: string[]) => { const cli = new Command(); registerLinearCommands(cli); await cli.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', ...args]); };
  const input = (await documentedApiExamples()).find((e) => e.query.includes('activities(first:50'))!;
  input.variables.id = sessionId; stdin = JSON.stringify(input); await run('api');
  const first = JSON.parse(output.at(-1)!).agentSession.activities;
  assert.equal(first.nodes.length, 50); assert.equal(first.pageInfo.hasNextPage, true);
  input.variables.after = first.pageInfo.endCursor; stdin = JSON.stringify(input); await run('api');
  const second = JSON.parse(output.at(-1)!).agentSession.activities;
  assert.equal(second.nodes[0].content.body, 'Message 50'); assert.equal(second.pageInfo.hasNextPage, false);
  const link = (await documentedApiExamples()).find((e) => e.query.includes('agentSessionUpdate'))!;
  link.variables.id = sessionId; stdin = JSON.stringify(link); await run('api');
  assert.equal(JSON.parse(output.at(-1)!).agentSessionUpdate.success, true);
  stdin = JSON.stringify(input); await run('api');
  assert.deepEqual(JSON.parse(output.at(-1)!).agentSession.externalLinks, [{ url: 'https://github.com/example/repo/pull/1' }]);
  const markdown = '**Done**\n\n- Verified `pagination`\n- [PR](https://example.com/pr)';
  // The envelope's reply_to and the earlier respond name reach the same deduplicated activity.
  const callsBeforeReply = fake.calls.length;
  stdin = markdown; await run('reply', '--to', `session:${sessionId}`); await run('respond', '--session', sessionId);
  assert.equal(fake.posts.length, 1); assert.equal(fake.posts[0]!.content.body, markdown);
  assert.match(output.at(-2)!, /Linear accepted activity/);
  assert.equal((await store.read()).receipts[item!.id]!.state, 'answered');
  const outbox = (await messageServiceForAgent('scout').list()).entries;
  assert.ok(outbox.some((m) => m.direction === 'out' && m.text === markdown && m.channelId === issue.id
    && m.threadTs === sessionId && m.issueKey === issue.identifier && m.issueTitle === issue.title && m.permalink === issue.url));
  assert.deepEqual(fake.calls.slice(callsBeforeReply).map((call) => call.query.includes('agentActivityCreate')), [true], 'Display fields require no extra lookup, even after service recreation');

}));
