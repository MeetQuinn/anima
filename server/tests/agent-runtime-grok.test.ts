import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentRuntime } from '../providers/factory.js';
import type { AgentRuntime } from '../providers/contract.js';
import { runtimeSessionServiceForAgent } from '../runtime/runtime-session.service.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { withAnimaHome } from './anima-home.js';
import {
  assertFollowupPrompt,
  providerSessionStartedPayload,
  runtimeFollowupInput,
  runtimeInput,
  runtimeTestEnv,
} from './helpers/agent-runtime.js';
import { waitFor, withTimeout } from './helpers/harness.js';
import { ingestEvent } from './helpers/inbox.js';
import { enqueueInbox, queueFor, silentLogger } from './helpers/runtime-worker.js';
import { makeSlackEvent } from './helpers/slack.js';
import { allActivities, loadState } from './helpers/state.js';

test('grok-cli ACP starts, appends, dispatches agent requests, and reports actual model authority', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-runtime-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        'let promptCount = 0;',
        'let pendingPromptId;',
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-session-1', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [{ modelId: 'grok-4.5', _meta: { totalContextTokens: 500000 } }] } } } });",
        '      continue;',
        '    }',
        "    if (msg.method === 'session/new') {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-1', models: { currentModelId: 'grok-4.5', availableModels: [{ modelId: 'grok-4.5', _meta: { totalContextTokens: 500000 } }] } } });",
        '      continue;',
        '    }',
        "    if (msg.id === 'agent-request-1' && msg.error) {",
        '      if (msg.error.code !== -32601) process.exit(71);',
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first' } });",
        "      setTimeout(() => send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', inputTokens: 120, outputTokens: 30, cachedTokens: 10, reasoningTokens: 5, totalTokens: 160 } } }), 40);",
        '      continue;',
        '    }',
        "    if (msg.method === 'session/prompt') {",
        '      promptCount += 1;',
        '      if (promptCount === 1) {',
        '        pendingPromptId = msg.id;',
        "        send({ jsonrpc: '2.0', id: 'agent-request-1', method: 'fs/read_text_file', params: { path: 'PROBE.txt' } });",
        '      } else {',
        "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' + appended' } });",
        "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', inputTokens: 20, outputTokens: 4, totalTokens: 24 } } });",
        '      }',
        '    }',
        '  }',
        '});',
      ]);

      const first = await ingestGrokEvent(stateDir, 'Start Grok.', '1771000000.000001');
      const followup = await ingestGrokEvent(stateDir, 'Continue Grok.', '1771000000.000002');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      const runPromise = runtime.run(await runtimeInput(runtime, first, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((value) => value.includes('session/prompt')));
      assert.deepEqual(
        await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, first, followup, await loadState())),
        { accepted: true, text: 'queued for Grok ACP session' },
      );
      assert.equal((await withTimeout(runPromise, 2_000)).text, 'first + appended');

      const calls = await readJsonLines(callsPath);
      const launch = calls[0] as { argv?: string[] };
      assert.deepEqual(launch.argv, [
        '--no-auto-update',
        'agent',
        '--no-leader',
        '--always-approve',
        '-m',
        'grok-4.5',
        'stdio',
      ]);
      const prompts = calls.filter((call) => call['method'] === 'session/prompt');
      assert.equal(prompts.length, 2);
      assertFollowupPrompt(promptText(prompts[1]), 'Continue Grok.');
      assert.ok(calls.some((call) => call['id'] === 'agent-request-1' && isErrorCode(call, -32601)));
      assert.deepEqual(await providerSessionStartedPayload(first.item.id), {
        kind: 'grok-cli',
        resumed: false,
      });

      const state = await loadState();
      assert.equal(state.sessions.anima?.current?.id, 'grok-session-1');
      assert.equal(runtime.health?.().child?.version, '0.2.93');
      const stats = allActivities(state).find(
        (activity) =>
          activity.type === 'runtime.event' &&
          activity.payload?.['eventType'] === 'grok.context.stats' &&
          activity.payload?.['totalTokens'] === 24,
      );
      assert.equal(
        stats?.payload?.['model'],
        'grok-4.5',
        JSON.stringify(
          allActivities(state).filter((activity) => activity.payload?.['eventType'] === 'grok.context.stats'),
        ),
      );
      assert.equal(stats?.payload?.['contextWindow'], 500000);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli restores a persisted top-level session with session/load', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-load-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(
        stateDir,
        standardFakeGrok({
          callsPath,
          loadSessionId: 'grok-session-persisted',
          reply: 'loaded reply',
        }),
      );
      const ctx = await ingestGrokEvent(stateDir, 'Resume Grok.', '1771000010.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('grok-cli', {
        id: 'grok-session-persisted',
        updatedAt: '2026-07-13T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'loaded reply');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(
        calls.filter((call) => typeof call['method'] === 'string').map((call) => call['method']),
        ['initialize', 'session/load', 'session/prompt'],
      );
      assert.equal((calls[2]?.['params'] as Record<string, unknown>)?.['sessionId'], 'grok-session-persisted');
      assert.deepEqual(await providerSessionStartedPayload(ctx.item.id), {
        id: 'grok-session-persisted',
        kind: 'grok-cli',
        resumed: true,
      });
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli sends ACP cancel before tearing down an aborted turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-cancel-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        'let promptId;',
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-cancel' } });",
        "    if (msg.method === 'session/prompt') promptId = msg.id;",
        "    if (msg.method === 'session/cancel') send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled', _meta: { cancellationCategory: 'MidTurnAbort' } } });",
        '  }',
        '});',
      ]);
      const ctx = await ingestGrokEvent(stateDir, 'Cancel Grok.', '1771000020.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      const abort = new AbortController();
      const input = {
        ...(await runtimeInput(runtime, ctx, await loadState())),
        signal: abort.signal,
      };
      const run = runtime.run(input);
      await waitFor(() => readFile(callsPath, 'utf8').then((value) => value.includes('session/prompt')));
      abort.abort('operator_abort');
      await assert.rejects(run, /Grok turn cancelled/);
      const calls = await readJsonLines(callsPath);
      const cancel = calls.find((call) => call['method'] === 'session/cancel');
      assert.deepEqual(cancel?.['params'], {
        sessionId: 'grok-session-cancel',
      });
      assert.equal('id' in (cancel ?? {}), false);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli creates a new session only when session/load confirms the persisted session is missing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-load-missing-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-session-fresh', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/load') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'FS_NOT_FOUND: session was not found' } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-fresh' } });",
        "    if (msg.method === 'session/prompt') {",
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh reply' } });",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5' } } });",
        '    }',
        '  }',
        '});',
      ]);
      const ctx = await ingestGrokEvent(stateDir, 'Recover missing Grok session.', '1771000025.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('grok-cli', {
        id: 'grok-session-missing',
        updatedAt: '2026-07-13T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'fresh reply');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(
        calls.filter((call) => typeof call['method'] === 'string').map((call) => call['method']),
        ['initialize', 'session/load', 'session/new', 'session/prompt'],
      );
      assert.equal((await loadState()).sessions.anima?.current?.id, 'grok-session-fresh');
      assert.ok(
        allActivities(await loadState()).some(
          (activity) => activity.payload?.['eventType'] === 'grok.session.load_missing',
        ),
      );
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli child loss retries the same inbox item and reloads the persisted session', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-crash-retry-'));
  let runtime: AgentRuntime | undefined;
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const attemptsPath = join(stateDir, 'attempts.txt');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-session-retry', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/load') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-retry' } });",
        "    if (msg.method === 'session/prompt') {",
        "      const attempt = Number(fs.existsSync(process.env.ATTEMPTS_PATH) ? fs.readFileSync(process.env.ATTEMPTS_PATH, 'utf8') : '0') + 1;",
        '      fs.writeFileSync(process.env.ATTEMPTS_PATH, String(attempt));',
        '      if (attempt === 1) process.exit(51);',
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'retry succeeded' } });",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', totalTokens: 20 } } });",
        '    }',
        '  }',
        '});',
      ]);
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, {
          ATTEMPTS_PATH: attemptsPath,
          CALLS_PATH: callsPath,
        }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      worker = new AgentRuntimeWorker(
        {
          agentId: 'anima',
          agentRuntime: runtime,
          pollIntervalMs: 10_000,
          queue: queueFor('anima'),
          stateDir,
          workerId: 'grok-retry-worker',
        },
        silentLogger,
      );
      const decision = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-grok',
          eventId: 'evt-grok-retry',
          teamId: 'T-demo',
          text: 'Retry this Grok item.',
          ts: '1771000030.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      await runtimeSessionServiceForAgent('anima').persistProviderSession('grok-cli', {
        id: 'grok-session-retry',
        updatedAt: '2026-07-13T00:00:00.000Z',
      });
      assert.equal(await worker.drainOnce(), 1);
      assert.equal(await queueFor('anima').find(decision.ctx.item.id), undefined);
      assert.equal(await readFile(attemptsPath, 'utf8'), '2');
      const calls = await readJsonLines(callsPath);
      assert.equal(calls.filter((call) => call['method'] === 'session/load').length, 2);
      const prompts = calls.filter((call) => call['method'] === 'session/prompt');
      assert.equal(prompts.length, 2);
      assert.match(promptText(prompts[1]), /previous provider process crashed/i);
      const activities = allActivities(await loadState());
      assert.ok(
        activities.some(
          (activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry',
        ),
      );
      assert.equal(
        activities.some((activity) => activity.type === 'runtime.failed'),
        false,
      );
    });
  } finally {
    await worker?.close();
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function installFakeGrok(stateDir: string, body: string[]): Promise<void> {
  const executable = join(stateDir, 'grok');
  await writeFile(
    executable,
    [
      '#!/usr/bin/env node',
      `require('fs').appendFileSync(process.env.CALLS_PATH, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');`,
      ...body,
    ].join('\n'),
    'utf8',
  );
  await chmod(executable, 0o755);
}

function standardFakeGrok(input: { callsPath: string; loadSessionId: string; reply: string }): string[] {
  void input.callsPath;
  return [
    "const fs = require('fs');",
    "process.stdin.setEncoding('utf8');",
    "let buffer = '';",
    "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
    "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: " +
      JSON.stringify(input.loadSessionId) +
      ', update: value } }); }',
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    '  const lines = buffer.split(/\\r?\\n/);',
    "  buffer = lines.pop() || '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
    "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
    "    if (msg.method === 'session/load') {",
    '      if (msg.params.sessionId !== ' + JSON.stringify(input.loadSessionId) + ') process.exit(72);',
    "      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: " + JSON.stringify(input.loadSessionId) + ' } });',
    '    }',
    "    if (msg.method === 'session/prompt') {",
    "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: " +
      JSON.stringify(input.reply) +
      ' } });',
    "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', totalTokens: 10 } } });",
    '    }',
    '  }',
    '});',
  ];
}

async function ingestGrokEvent(stateDir: string, text: string, ts: string) {
  return ingestEvent(
    makeSlackEvent({
      channelId: 'D-grok',
      teamId: 'T-demo',
      text,
      ts,
      userId: 'U1',
    }),
    { agentId: 'anima', stateDir },
  );
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function promptText(call: Record<string, unknown> | undefined): string {
  const params = call?.['params'];
  if (!params || typeof params !== 'object') return '';
  const prompt = (params as { prompt?: Array<{ text?: string }> }).prompt;
  return prompt?.[0]?.text ?? '';
}

function isErrorCode(value: Record<string, unknown>, code: number): boolean {
  const error = value['error'];
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === code);
}
