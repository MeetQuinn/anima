import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { activityServiceForAgent } from '../activities/activity.service.js';
import { createClaudeJsonlActivityMapper } from '../providers/claude-events.js';
import { recordRuntimeEvent, recordRuntimeToolStarted } from '../runtime/activity.js';
import { ProviderTaskNameStore } from '../storage/schema/provider-task-name.store.js';
import { withAnimaHome } from './anima-home.js';

async function isolated(body: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'anima-task-names-'));
  try { await withAnimaHome(home, () => body(home)); }
  finally { await rm(home, { recursive: true, force: true }); }
}

function mapper(agentId = 'anima') {
  const target = { agentId };
  return createClaudeJsonlActivityMapper({
    async persistProviderSession() {},
    async recordAgentText() {},
    recordEvent: (event) => recordRuntimeEvent(target, 'claude-code', undefined, event),
    async recordOutput() {},
    async recordUsage() {},
    async recordRuntime() {},
    async recordToolFailed() {},
    recordToolStarted: (tool) => recordRuntimeToolStarted(target, tool),
  }, 'claude-code');
}

function use(id: string, name: string, input: Record<string, unknown>, session = 'session-a', parent: string | null = null) {
  return { type: 'assistant', session_id: session, parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } };
}
function result(id: string, output: unknown, session = 'session-a', error = false) {
  return { type: 'user', session_id: session, parent_tool_use_id: null, tool_use_result: output,
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: 'synthetic result' }] } };
}
async function send(m: ReturnType<typeof mapper>, ...events: unknown[]) {
  await m.accept(events.map((event) => JSON.stringify(event) + '\n').join(''));
}
async function create(m: ReturnType<typeof mapper>, subject = 'Check login', session = 'session-a') {
  await send(m, use('create', 'TaskCreate', { subject, description: 'DO_NOT_COPY_DESCRIPTION', metadata: { secret: 'DO_NOT_COPY_METADATA' } }, session),
    result('create', { task: { id: '7', subject, metadata: 'DO_NOT_COPY_OUTPUT' } }, session));
}
async function updates(agentId = 'anima') {
  return (await activityServiceForAgent(agentId).readAll()).filter((a) => a.payload?.['providerToolName'] === 'TaskUpdate').map((a) => a.payload!);
}

test('confirmed task names survive new mappers and only enrich the same native session and agent', async () => isolated(async (home) => {
  await create(mapper());
  await send(mapper(), use('complete', 'TaskUpdate', { taskId: '7', status: 'completed' }));
  await send(mapper(), use('new-session', 'TaskUpdate', { taskId: '7', status: 'completed' }, 'session-b'));
  await send(mapper('other'), use('other-agent', 'TaskUpdate', { taskId: '7', status: 'completed' }));
  const rows = await updates();
  assert.equal(rows[0]?.['taskSubject'], 'Check login');
  assert.equal(rows[0]?.['target'], 'Check login');
  assert.equal(rows[1]?.['target'], 'Task #7');
  assert.equal((await updates('other'))[0]?.['taskSubject'], undefined);
  const persisted = await readFile(join(home, 'agents/anima/claude-task-names.json'), 'utf8');
  assert.doesNotMatch(persisted, /DO_NOT_COPY|description|metadata/);
  assert.doesNotMatch(JSON.stringify(await activityServiceForAgent('anima').readAll()), /DO_NOT_COPY|claude.task.name/);
}));

test('successful rename and delete update the durable name; rejected rename does not', async () => isolated(async () => {
  const m = mapper();
  await create(m);
  await send(m, use('bad', 'TaskUpdate', { taskId: '7', subject: 'Wrong' }), result('bad', {}, 'session-a', true));
  await send(mapper(), use('after-error', 'TaskUpdate', { task_id: '7', status: 'completed' }));
  assert.equal((await updates()).at(-1)?.['taskSubject'], 'Check login');
  await send(m, use('rename', 'TaskUpdate', { id: '7', subject: 'Check sign-in' }), result('rename', { success: true }));
  await send(mapper(), use('delete', 'TaskUpdate', { id: '7', status: 'deleted' }), result('delete', { success: true }));
  assert.equal((await updates()).at(-1)?.['taskSubject'], 'Check sign-in');
  await send(mapper(), use('unknown', 'TaskUpdate', { taskId: '7', status: 'completed' }));
  assert.equal((await updates()).at(-1)?.['target'], 'Task #7');
}));

test('unconfirmed, mismatched, failed and ambiguous create results cannot assign a task name', async () => isolated(async () => {
  for (const mode of ['missing', 'wrong-tool', 'wrong-session', 'error', 'malformed', 'ambiguous', 'failed-output']) {
    const m = mapper(mode);
    await send(m, use('c', 'TaskCreate', { subject: 'Must not associate' }));
    const reply = result(mode === 'wrong-tool' ? 'other' : 'c', { task: { id: '7' } }, mode === 'wrong-session' ? 'other' : 'session-a', mode === 'error');
    if (mode === 'malformed') reply.tool_use_result = { arbitrary: { id: '7' } };
    if (mode === 'failed-output') reply.tool_use_result = { success: false, task: { id: '7' } };
    if (mode === 'ambiguous') reply.message.content.push({ type: 'tool_result', tool_use_id: 'other', is_error: false, content: 'other' });
    if (mode !== 'missing') await send(m, reply);
    await send(m, use('u', 'TaskUpdate', { taskId: '7', status: 'completed' }));
    assert.equal((await updates(mode)).at(-1)?.['taskSubject'], undefined, mode);
    if (mode === 'wrong-session') {
      await send(m, use('other-session-update', 'TaskUpdate', { taskId: '7', status: 'completed' }, 'other'));
      assert.equal((await updates(mode)).at(-1)?.['taskSubject'], undefined, 'mismatched result cannot poison its own session either');
    }
  }
}));

test('subagent and unscoped task calls never borrow a root task name', async () => isolated(async () => {
  await create(mapper());
  const m = mapper();
  const noScope: Record<string, unknown> = use('no-session', 'TaskUpdate', { taskId: '7', status: 'completed' });
  delete noScope['session_id'];
  const noRoot: Record<string, unknown> = use('no-root', 'TaskUpdate', { taskId: '7', status: 'completed' });
  delete noRoot['parent_tool_use_id'];
  await send(m, noScope, noRoot, use('child', 'TaskUpdate', { taskId: '7', status: 'completed' }, 'session-a', 'parent-tool'));
  await m.flush();
  assert.equal((await updates()).length, 3);
  for (const row of await updates()) assert.equal(row['taskSubject'], undefined);
}));

test('block-level and transcript structured results preserve exact tool attribution', async () => isolated(async () => {
  for (const variant of ['block', 'transcript']) {
    const m = mapper(variant);
    await send(m, use('c', 'TaskCreate', { subject: variant }));
    const event: Record<string, unknown> = result('c', undefined);
    if (variant === 'transcript') {
      delete event['parent_tool_use_id'];
      event['isSidechain'] = false;
      event['toolUseResult'] = { task: { id: '7' } };
    } else {
      event['message'] = { content: [{ type: 'tool_result', tool_use_id: 'c', tool_use_result: { task: { id: '7' } } }] };
    }
    await send(m, event, use('u', 'TaskUpdate', { taskId: '7', status: 'completed' }));
    assert.equal((await updates(variant))[0]?.['taskSubject'], variant);
  }
}));

test('corrupt display cache cannot fail provider work and falls back to IDs', async () => isolated(async (home) => {
  await create(mapper());
  await writeFile(join(home, 'agents/anima/claude-task-names.json'), '{broken');
  await create(mapper(), 'another');
  await send(mapper(), use('u', 'TaskUpdate', { taskId: '7', status: 'completed' }));
  assert.equal((await updates())[0]?.['target'], 'Task #7');
}));

test('display cache is bounded and concurrent updates preserve unrelated names', async () => isolated(async (home) => {
  await create(mapper());
  const path = join(home, 'agents/anima/claude-task-names.json');
  await writeFile(path, JSON.stringify(Array.from({ length: 1_000 }, (_, i) => ({ sessionId: 's', taskId: String(i), subject: `name ${i}` }))));
  await Promise.all([new ProviderTaskNameStore('anima').put('s', '1000', 'new a'), new ProviderTaskNameStore('anima').put('s', '1001', 'new b')]);
  const rows = JSON.parse(await readFile(path, 'utf8')) as unknown[];
  assert.equal(rows.length, 1_000);
  const store = new ProviderTaskNameStore('anima');
  assert.equal(await store.find('s', '0'), undefined);
  assert.equal(await store.find('s', '1000'), 'new a');
  assert.equal(await store.find('s', '1001'), 'new b');
}));
