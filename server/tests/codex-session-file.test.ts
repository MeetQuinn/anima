import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { scanCodexSessionFile } from '../providers/codex-session-file.js';

function turnContext(turnId: string): string {
  return JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', turn_id: turnId } });
}

function webSearchEnd(callId: string, query = `query ${callId}`): string {
  return JSON.stringify({ type: 'event_msg', payload: { call_id: callId, query, type: 'web_search_end' } });
}

function taskComplete(turnId: string): string {
  return JSON.stringify({ type: 'event_msg', payload: { turn_id: turnId, type: 'task_complete' } });
}

async function withRollout(lines: string[], run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anima-codex-rollout-'));
  try {
    const path = join(dir, 'rollout-thread.jsonl');
    await writeFile(path, lines.join('\n'), 'utf8');
    await run(path);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function searchIds(scan: { webSearches: Record<string, unknown>[] }): unknown[] {
  return scan.webSearches.map((search) => search['providerToolId']);
}

test('Codex rollout scan collects one turn and reports the byte offset where it started', async () => {
  // Longer than one read chunk, with multi-byte characters, so the turn starts
  // in a later chunk and its offset counts bytes rather than characters. The
  // ws-a line spans three chunks.
  const padding = JSON.stringify({ type: 'response_item', payload: { type: 'message', text: '漢'.repeat(100_000) } });
  const lines = [
    padding,
    turnContext('turn-a'),
    webSearchEnd('ws-a', 'q'.repeat(600_000)),
    JSON.stringify({
      type: 'response_item',
      payload: {
        arguments: JSON.stringify({ agent_type: 'explorer', message: 'inspect' }),
        call_id: 'call-a',
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
        type: 'function_call',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { call_id: 'call-a', output: JSON.stringify({ agent_id: 'child-a', nickname: 'Gauss' }), type: 'function_call_output' },
    }),
    taskComplete('turn-a'),
    webSearchEnd('ws-after-complete'),
    '',
  ];
  await withRollout(lines, async (path) => {
    const scan = await scanCodexSessionFile(path, 0, 'turn-a');
    assert.equal(scan.turnStartOffset, Buffer.byteLength(`${padding}\n`));
    assert.equal(scan.complete, true);
    assert.deepEqual(searchIds(scan), ['ws-a']);
    assert.deepEqual(scan.spawnPairs.map((pair) => [pair.spawn.parentToolCallId, pair.output.subRunId]), [['call-a', 'child-a']]);
  });
});

test('Codex rollout scan from an earlier turn start skips lines before it', async () => {
  // The leading turn-b lines stand in for anything before the offset; a scan
  // from the top would take them as turn-b's.
  const lines = [
    turnContext('turn-b'),
    webSearchEnd('ws-stale'),
    turnContext('turn-a'),
    webSearchEnd('ws-a'),
    taskComplete('turn-a'),
    turnContext('turn-b'),
    webSearchEnd('ws-b'),
    taskComplete('turn-b'),
    '',
  ];
  await withRollout(lines, async (path) => {
    const first = await scanCodexSessionFile(path, 0, 'turn-a');
    assert.equal(first.turnStartOffset, Buffer.byteLength(`${lines.slice(0, 2).join('\n')}\n`));
    const next = await scanCodexSessionFile(path, first.turnStartOffset ?? 0, 'turn-b');
    assert.deepEqual(searchIds(next), ['ws-b']);
    assert.equal(next.turnStartOffset, Buffer.byteLength(`${lines.slice(0, 5).join('\n')}\n`));
    assert.deepEqual(searchIds(await scanCodexSessionFile(path, 0, 'turn-b')), ['ws-stale', 'ws-a', 'ws-b']);
  });
});

test('Codex rollout scan rereads a file shorter than the offset and reads an unterminated last line', async () => {
  const lines = [turnContext('turn-a'), webSearchEnd('ws-a'), webSearchEnd('ws-last')];
  await withRollout(lines, async (path) => {
    const scan = await scanCodexSessionFile(path, 1_000_000, 'turn-a');
    assert.equal(scan.turnStartOffset, 0);
    assert.equal(scan.complete, false);
    assert.deepEqual(searchIds(scan), ['ws-a', 'ws-last']);
  });
});
