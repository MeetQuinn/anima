import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  claudeSubagentsDir,
  subagentActivityLinkageFromClaudeJson,
  type ClaudeJsonlMapperState,
} from '../providers/claude-subagent-transcript.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'anima-subagent-index-'));
  const previousRoot = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  const state: ClaudeJsonlMapperState = {
    context: { cwd: '/test/project', sessionId: 'session-one' },
    emittedSubagentTextKeys: new Set(),
    emittedSubagentToolIds: new Set(),
    ingestedSubagentLogs: new Set(),
    pendingAgentToolIds: new Set(),
    pendingSubagentResultsByAgentId: new Map(),
    pendingUnlinkedTexts: [],
    pendingUnlinkedToolsById: new Map(),
    providerToolsById: new Map(),
    subagentTranscriptIndexesByDir: new Map(),
    subagentMetadataByKey: new Map(),
  };
  const dir = claudeSubagentsDir('/test/project', 'session-one');
  await fs.mkdir(dir, { recursive: true });
  const io = { bytes: 0, opened: [] as string[], failNext: '' };
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const name = basename(String(args[0]));
    io.opened.push(name);
    if (io.failNext === name) {
      io.failNext = '';
      throw new Error('transient read failure');
    }
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      io.bytes += result.bytesRead;
      return result;
    });
    return handle;
  });
  const readdir = t.mock.method(fs, 'readdir');
  const writeChild = async (agentId: string, contents: string, targetDir = dir) => {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(join(targetDir, `agent-${agentId}.jsonl`), contents);
    await fs.writeFile(join(targetDir, `agent-${agentId}.meta.json`), JSON.stringify({
      toolUseId: `parent-${agentId}`, agentType: 'Explore', description: agentId,
    }));
  };
  const lookup = (toolId: string, extra: Record<string, unknown> = {}) =>
    subagentActivityLinkageFromClaudeJson({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: toolId, name: 'Read' }] },
      ...extra,
    }, state);
  return { state, dir, io, readdir, writeChild, lookup };
}

function row(toolId: string, model = 'child-model'): string {
  return JSON.stringify({ type: 'assistant', message: {
    model, content: [{ type: 'tool_use', id: toolId, name: 'Read' }],
  } }) + '\n';
}

test('explicit root and child ownership bypass historical directory searches', async (t) => {
  const f = await fixture(t);
  await f.writeChild('child', row('child-tool'));
  await f.writeChild('historical', row('old-tool'));
  assert.deepEqual(await f.lookup('root-tool', { parent_tool_use_id: null }), {});
  assert.deepEqual(await f.lookup('root-tool', { isSidechain: false }), {});
  assert.equal(f.io.bytes, 0);
  assert.equal(f.readdir.mock.callCount(), 0);

  assert.equal((await f.lookup('child-tool', {
    agentId: 'child', message: { model: 'reported-child-model', content: [] },
  }))['model'], 'reported-child-model');
  assert.equal(f.io.bytes, 0);

  const linkage = await f.lookup('child-tool', { agentId: 'child' });
  assert.equal(linkage['parentToolCallId'], 'parent-child');
  assert.equal(linkage['subRunId'], 'child');
  assert.equal(linkage['model'], 'child-model');
  assert.deepEqual(f.io.opened, ['agent-child.jsonl']);
  assert.equal(f.readdir.mock.callCount(), 0);
  assert.equal((await f.lookup('child-tool', {
    parent_tool_use_id: 'parent-child', subRunId: 'child',
  }))['model'], 'child-model');
  assert.equal((await f.lookup('child-result', {
    toolUseResult: { agentId: 'child' },
    message: { model: 'parent-model', content: [] },
  }))['model'], 'child-model');
});

test('unique misses and hits reuse indexed history without rereading transcript bytes', async (t) => {
  const f = await fixture(t);
  let historyBytes = 0;
  for (let i = 0; i < 12; i += 1) {
    const contents = Array.from({ length: 500 }, (_, j) => row(`tool-${i}-${j}`)).join('');
    historyBytes += Buffer.byteLength(contents);
    await f.writeChild(`child-${i}`, contents);
  }
  assert.deepEqual(await f.lookup('missing-0'), {});
  assert.equal(f.io.bytes, historyBytes);
  const opens = f.io.opened.length;
  for (let i = 1; i < 20; i += 1) assert.deepEqual(await f.lookup(`missing-${i}`), {});
  assert.equal((await f.lookup('tool-11-499'))['subRunId'], 'child-11');
  assert.equal((await f.lookup('tool-0-0'))['model'], 'child-model');
  assert.equal(f.io.bytes, historyBytes);
  assert.equal(f.io.opened.length, opens);
});

test('appends and new files invalidate misses and update the child model', async (t) => {
  const f = await fixture(t);
  await f.writeChild('child', JSON.stringify({ type: 'user', message: {
    content: [{ type: 'tool_result', tool_use_id: 'early-tool' }],
  } }) + '\n');
  assert.equal((await f.lookup('early-tool'))['model'], undefined);
  assert.deepEqual(await f.lookup('late-tool'), {});
  const before = f.io.bytes;
  const appended = row('late-tool', 'late-model');
  await fs.appendFile(join(f.dir, 'agent-child.jsonl'), appended);
  assert.equal((await f.lookup('late-tool'))['subRunId'], 'child');
  assert.equal(f.io.bytes - before, Buffer.byteLength(appended));
  assert.equal((await f.lookup('early-tool'))['model'], 'late-model');

  assert.deepEqual(await f.lookup('new-file-tool'), {});
  await f.writeChild('new-child', row('new-file-tool'));
  assert.equal((await f.lookup('new-file-tool'))['subRunId'], 'new-child');
});

test('partial JSON and UTF-8 tails are retried, and text mentions do not claim tools', async (t) => {
  const f = await fixture(t);
  const textRow = JSON.stringify({ type: 'assistant', message: {
    model: 'child-model', content: [{ type: 'text', text: 'a mention of root-tool' }],
  } }) + '\r\n';
  await f.writeChild('child', textRow);
  assert.deepEqual(await f.lookup('root-tool'), {});

  const pending = Buffer.from(JSON.stringify({ type: 'assistant', message: {
    content: [{ type: 'tool_use', id: 'late-tool', name: 'Read', input: {
      text: 'x'.repeat(70_000) + '你好',
    } }],
  } }) + '\n');
  const split = pending.indexOf(Buffer.from('你')) + 1;
  await fs.appendFile(join(f.dir, 'agent-child.jsonl'), pending.subarray(0, split));
  assert.deepEqual(await f.lookup('late-tool'), {});
  await fs.appendFile(join(f.dir, 'agent-child.jsonl'), pending.subarray(split));
  assert.equal((await f.lookup('late-tool'))['subRunId'], 'child');
  await fs.appendFile(join(f.dir, 'agent-child.jsonl'), row('no-newline-tool').trimEnd());
  assert.equal((await f.lookup('no-newline-tool'))['subRunId'], 'child');
});

test('truncation, same-size rewrites, replacement and deletion remove stale ownership', async (t) => {
  const f = await fixture(t);
  const path = join(f.dir, 'agent-child.jsonl');
  await f.writeChild('child', row('old-tool') + row('extra-tool'));
  assert.equal((await f.lookup('old-tool'))['subRunId'], 'child');
  await fs.writeFile(path, row('new-tool'));
  assert.deepEqual(await f.lookup('old-tool'), {});
  assert.equal((await f.lookup('new-tool'))['subRunId'], 'child');

  await fs.writeFile(path, row('alt-tool'));
  await fs.utimes(path, new Date('2026-01-01'), new Date('2026-01-01'));
  assert.deepEqual(await f.lookup('new-tool'), {});
  assert.equal((await f.lookup('alt-tool'))['subRunId'], 'child');
  await fs.writeFile(`${path}.replacement`, row('replacement-tool'));
  await fs.rename(`${path}.replacement`, path);
  assert.deepEqual(await f.lookup('alt-tool'), {});
  assert.equal((await f.lookup('replacement-tool'))['subRunId'], 'child');
  await fs.rm(path);
  assert.deepEqual(await f.lookup('replacement-tool'), {});
  await fs.rm(f.dir, { recursive: true });
  assert.deepEqual(await f.lookup('replacement-tool'), {});
  await f.writeChild('child', row('replacement-tool'));
  assert.equal((await f.lookup('replacement-tool'))['subRunId'], 'child');
});

test('failed file reads and late metadata are retried without blocking other files', async (t) => {
  const f = await fixture(t);
  await f.writeChild('a', row('a-tool'));
  await f.writeChild('b', row('b-tool'));
  f.io.failNext = 'agent-a.jsonl';
  assert.equal((await f.lookup('b-tool'))['subRunId'], 'b');
  assert.equal((await f.lookup('a-tool'))['subRunId'], 'a');
  await f.writeChild('late-meta', row('meta-tool'));
  await fs.rm(join(f.dir, 'agent-late-meta.meta.json'));
  assert.deepEqual(await f.lookup('meta-tool'), { model: 'child-model' });
  await fs.writeFile(join(f.dir, 'agent-late-meta.meta.json'), JSON.stringify({ toolUseId: 'parent-late' }));
  assert.equal((await f.lookup('meta-tool'))['parentToolCallId'], 'parent-late');
});

test('indexes are isolated by project and native session', async (t) => {
  const f = await fixture(t);
  await f.writeChild('one', row('shared-tool', 'model-one'));
  assert.equal((await f.lookup('shared-tool'))['subRunId'], 'one');
  const secondDir = claudeSubagentsDir('/another/project', 'session-two');
  await f.writeChild('two', row('shared-tool', 'model-two'), secondDir);
  const second = await f.lookup('shared-tool', { cwd: '/another/project', session_id: 'session-two' });
  assert.equal(second['subRunId'], 'two');
  assert.equal(second['model'], 'model-two');
  assert.equal((await f.lookup('shared-tool'))['model'], 'model-one');
});
