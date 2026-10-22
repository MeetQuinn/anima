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
import { activityServiceForAgent } from '../activities/activity.service.js';
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
}));

test('registered Linear CLI creates and comments proactively, records outbox, and keeps token/API secrets out of audit', async (t) => withTempAnimaHome(async (home) => {
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
  const auditBefore = await activityServiceForAgent('scout').readAll();
  const token = await run('token'); assert.equal(token.accessToken, install.accessToken); assert.equal(token.refreshToken, undefined);
  stdin = JSON.stringify({ query: 'query First { viewer { id } } query Second { viewer { id } }', variables: {}, operationName: 'Second' });
  assert.equal((await run('api')).viewer.id, install.appUserId);
  assert.equal(fake.requests.at(-1)!.operationName, 'Second');
  assert.doesNotMatch(JSON.stringify(await messageServiceForAgent('scout').list()), /access-sentinel|refresh-sentinel|query First/);
  assert.deepEqual(await activityServiceForAgent('scout').readAll(), auditBefore);
  assert.equal(commented.body, 'An ordinary reply'); assert.deepEqual((await store.read()).receipts, {});
}));
