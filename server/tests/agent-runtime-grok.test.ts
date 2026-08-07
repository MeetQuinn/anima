import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import {
  enqueueInbox,
  queueFor,
  silentLogger,
  waitForInboxItemAppendedTo,
  waitForInboxItemRemoved,
} from './helpers/runtime-worker.js';
import { makeSlackEvent } from './helpers/slack.js';
import { allActivities, loadState } from './helpers/state.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { agentTokenUsageServiceForAgent } from '../usage/agent-token-usage.service.js';

test('grok-cli ACP starts, appends, dispatches agent requests, and reports actual model authority', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-runtime-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const grokHome = join(stateDir, 'grok-home');
      await mkdir(grokHome, { recursive: true });
      await writeFile(
        join(grokHome, 'models_cache.json'),
        JSON.stringify({
          models: {
            'grok-4.5': {
              api_key: 'secret-sentinel',
              info: { context_window: 500_000 },
            },
          },
        }),
        'utf8',
      );
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "const config = fs.readFileSync(process.env.GROK_HOME + '/config.toml', 'utf8');",
        "if (!config.includes('auto_compact_threshold_percent = 40') || config.includes('context_window = 200000')) process.exit(72);",
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
        "    if (msg.method === 'session/cancel') {",
        '      if (pendingPromptId !== undefined) {',
        "        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled', _meta: { cancellationCategory: 'MidTurnAbort' } } });",
        '        pendingPromptId = undefined;',
        '      }',
        '      continue;',
        '    }',
        "    if (msg.id === 'agent-request-1' && msg.error) {",
        '      if (msg.error.code !== -32601) process.exit(71);',
        '      // Leave primary open; mid-turn follow-up cancel must complete it.',
        '      continue;',
        '    }',
        "    if (msg.method === 'session/prompt') {",
        '      promptCount += 1;',
        '      if (promptCount === 1) {',
        '        pendingPromptId = msg.id;',
        "        send({ jsonrpc: '2.0', id: 'agent-request-1', method: 'fs/read_text_file', params: { path: 'PROBE.txt' } });",
        '      } else {',
        "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'appended' } });",
        "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', inputTokens: 20, outputTokens: 4, totalTokens: 24 } } });",
        '      }',
        '    }',
        '  }',
        '});',
      ]);

      await defaultServerSettingsService.setProviderContextLimit(
        'grok-cli',
        200_000,
      );

      const first = await ingestGrokEvent(stateDir, 'Start Grok.', '1771000000.000001');
      const followup = await ingestGrokEvent(stateDir, 'Continue Grok.', '1771000000.000002');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, {
          CALLS_PATH: callsPath,
          GROK_HOME: grokHome,
        }),
        kind: 'grok-cli',
        model: 'grok-4.5',
        reasoningEffort: 'high',
      });
      const runPromise = runtime.run(await runtimeInput(runtime, first, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((value) => value.includes('session/prompt')));
      assert.deepEqual(
        await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, first, followup, await loadState())),
        { accepted: true, text: 'Grok follow-up applied (interrupts active prompt)' },
      );
      const finalText = (await withTimeout(runPromise, 2_000)).text ?? '';
      assert.equal(finalText, 'appended');

      const calls = await readJsonLines(callsPath);
      const launch = calls[0] as { argv?: string[] };
      // Launch argv never carries --effort: effort is applied post-init via
      // session/set_model against the live ACP catalog, never as a spawn flag.
      assert.deepEqual(launch.argv, [
        '--no-auto-update',
        'agent',
        '--no-leader',
        '--always-approve',
        '-m',
        'grok-4.5',
        'stdio',
      ]);
      assert.equal(launch.argv?.includes('--effort'), false);
      // This model's catalog entry advertises no reasoning-effort capability, so a
      // configured effort is fail-closed: no session/set_model is issued (unknown
      // capability must never fall back to model-name inference).
      assert.equal(
        calls.some((call) => call['method'] === 'session/set_model'),
        false,
      );
      const prompts = calls.filter((call) => call['method'] === 'session/prompt');
      assert.equal(prompts.length, 2);
      assertFollowupPrompt(promptText(prompts[1]), 'Continue Grok.');
      assert.ok(calls.some((call) => call['method'] === 'session/cancel'), 'mid-turn follow-up must cancel the active prompt');
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
      assert.equal(stats?.payload?.['currentContextTokens'], undefined);
      assert.equal(
        state.sessions.anima?.latestProviderStats?.currentContextTokens,
        undefined,
      );
      assert.equal(state.sessions.anima?.latestProviderStats?.totalTokens, 24);
      const usage = await agentTokenUsageServiceForAgent('anima').summary({
        agentName: 'Anima',
        from: '2000-01-01',
        through: '2100-01-01',
        timezone: 'UTC',
      });
      // Follow-up reports 24; cancelled primary may leave an unavailable/unknown run.
      assert.equal(usage.totalTokens, 24);
      assert.equal(usage.reportedRuns, 1);
      assert.ok(usage.unknownRuns <= 1);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli applies configured effort via session/set_model on the live current model before the first prompt (new session)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-effort-new-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, effortCapableFakeGrok({ sessionId: 'grok-session-effort' }));
      const ctx = await ingestGrokEvent(stateDir, 'Effort Grok.', '1771000030.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
        reasoningEffort: 'high',
      });
      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'effort reply');
      const calls = await readJsonLines(callsPath);
      const launch = calls[0] as { argv?: string[] };
      assert.equal(launch.argv?.includes('--effort'), false);
      // The setter runs after session/new (live catalog captured) and before the
      // first prompt, targeting the ACP-reported current model — not the config name.
      assert.deepEqual(
        calls.filter((call) => typeof call['method'] === 'string').map((call) => call['method']),
        ['initialize', 'session/new', 'session/set_model', 'session/prompt'],
      );
      const setter = calls.find((call) => call['method'] === 'session/set_model');
      assert.deepEqual(setter?.['params'], {
        _meta: { reasoningEffort: 'high' },
        modelId: 'grok-4.5',
        sessionId: 'grok-session-effort',
      });
      assert.ok(
        allActivities(await loadState()).some(
          (activity) =>
            activity.payload?.['eventType'] === 'grok.model.effort' &&
            activity.payload?.['model'] === 'grok-4.5' &&
            activity.payload?.['reasoningEffort'] === 'high',
        ),
      );
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli applies configured effort via session/set_model after restoring a persisted session (loaded session)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-effort-load-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(
        stateDir,
        effortCapableFakeGrok({ sessionId: 'grok-session-effort-persisted', loadSessionId: 'grok-session-effort-persisted' }),
      );
      const ctx = await ingestGrokEvent(stateDir, 'Resume with effort.', '1771000031.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('grok-cli', {
        id: 'grok-session-effort-persisted',
        updatedAt: '2026-07-13T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
        reasoningEffort: 'high',
      });
      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'effort reply');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(
        calls.filter((call) => typeof call['method'] === 'string').map((call) => call['method']),
        ['initialize', 'session/load', 'session/set_model', 'session/prompt'],
      );
      const setter = calls.find((call) => call['method'] === 'session/set_model');
      assert.deepEqual(setter?.['params'], {
        _meta: { reasoningEffort: 'high' },
        modelId: 'grok-4.5',
        sessionId: 'grok-session-effort-persisted',
      });
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli does not reuse a stale effort snapshot when session/new switches to a no-capability model', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-crossed-new-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, crossedModelFakeGrok({ mode: 'new', sessionId: 'grok-session-crossed' }));
      const ctx = await ingestGrokEvent(stateDir, 'Crossed new Grok.', '1771000032.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
        reasoningEffort: 'high',
      });
      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'crossed reply');
      const calls = await readJsonLines(callsPath);
      // initialize advertised grok-4.5/high, but session/new switched the live current
      // model to composer, which carries no capability signal. The snapshot is bound to
      // grok-4.5, so it must not fire against composer: no setter at all.
      assert.equal(
        calls.some((call) => call['method'] === 'session/set_model'),
        false,
      );
      assert.deepEqual(
        calls.filter((call) => typeof call['method'] === 'string').map((call) => call['method']),
        ['initialize', 'session/new', 'session/prompt'],
      );
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli does not reuse a stale effort snapshot when session/load switches to a no-capability model', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-crossed-load-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, crossedModelFakeGrok({ mode: 'load', sessionId: 'grok-session-crossed-load' }));
      const ctx = await ingestGrokEvent(stateDir, 'Crossed load Grok.', '1771000033.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('grok-cli', {
        id: 'grok-session-crossed-load',
        updatedAt: '2026-07-13T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
        reasoningEffort: 'high',
      });
      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'crossed reply');
      const calls = await readJsonLines(callsPath);
      // The persisted session/load restored composer (no capability). The grok-4.5
      // snapshot from initialize is model-bound and must not be reused: no setter.
      assert.equal(
        calls.some((call) => call['method'] === 'session/set_model'),
        false,
      );
      assert.deepEqual(
        calls.filter((call) => typeof call['method'] === 'string').map((call) => call['method']),
        ['initialize', 'session/load', 'session/prompt'],
      );
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli surfaces ReadFile target_file on tool.call.started for Activity', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-read-target-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-session-read', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-read' } });",
        "    if (msg.method === 'session/prompt') {",
        // Live Grok Build ACP uses target_file (not file_path) on read_file.
        "      update({ sessionUpdate: 'tool_call', toolCallId: 'call-read-1', title: 'read_file', rawInput: { target_file: 'shared/provider-catalog.ts' }, _meta: { 'x.ai/tool': { name: 'read_file', input: { path: 'shared/provider-catalog.ts' } } } });",
        "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] });",
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'read done' } });",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', totalTokens: 12 } } });",
        '    }',
        '  }',
        '});',
      ]);

      const ctx = await ingestGrokEvent(stateDir, 'Read a file.', '1771000099.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      assert.equal((await withTimeout(runtime.run(await runtimeInput(runtime, ctx, await loadState())), 2_000)).text, 'read done');

      const started = allActivities(await loadState()).find(
        (activity) =>
          activity.type === 'tool.call.started' &&
          activity.payload?.['providerToolId'] === 'call-read-1',
      );
      assert.equal(started?.payload?.['providerToolName'], 'ReadFile');
      assert.equal(started?.payload?.['target'], 'shared/provider-catalog.ts');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli surfaces ListDir from live ACP meta/title as narrative ListDir', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-listdir-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-session-list', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-list' } });",
        "    if (msg.method === 'session/prompt') {",
        // Live ListDir: title List `path`, kind Other, meta name list_dir (not a hand-built ListDir name).
        "      update({ sessionUpdate: 'tool_call', toolCallId: 'call-list-1', title: 'List `server/providers`', kind: 'Other', rawInput: { target_directory: 'server/providers' }, _meta: { 'x.ai/tool': { name: 'list_dir', kind: 'other' } } });",
        "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-list-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'entries' } }] });",
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'listed' } });",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', totalTokens: 8 } } });",
        '    }',
        '  }',
        '});',
      ]);

      const ctx = await ingestGrokEvent(stateDir, 'List a directory.', '1771000099.000002');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      assert.equal((await withTimeout(runtime.run(await runtimeInput(runtime, ctx, await loadState())), 2_000)).text, 'listed');

      const started = allActivities(await loadState()).find(
        (activity) =>
          activity.type === 'tool.call.started' &&
          activity.payload?.['providerToolId'] === 'call-list-1',
      );
      assert.equal(started?.payload?.['providerToolName'], 'ListDir');
      assert.equal(started?.payload?.['target'], 'server/providers');
      assert.equal(started?.payload?.['tool'], 'grok.ListDir');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli defers StrReplace until terminal frame supplies path (diff-only start)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-strreplace-path-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-session-strreplace', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-strreplace' } });",
        "    if (msg.method === 'session/prompt') {",
        // Live two-frame edit: start has old/new text only; path arrives on terminal content diff.
        "      update({ sessionUpdate: 'tool_call', toolCallId: 'call-edit-1', title: 'str_replace_file', kind: 'edit', rawInput: { old_string: 'a', new_string: 'b' }, _meta: { 'x.ai/tool': { name: 'str_replace_file' } } });",
        "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-edit-1', status: 'completed', content: [{ type: 'diff', path: 'server/providers/grok.ts', oldText: 'a', newText: 'b' }] });",
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'edited' } });",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', totalTokens: 9 } } });",
        '    }',
        '  }',
        '});',
      ]);

      const ctx = await ingestGrokEvent(stateDir, 'Edit a file.', '1771000099.000004');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      assert.equal((await withTimeout(runtime.run(await runtimeInput(runtime, ctx, await loadState())), 2_000)).text, 'edited');

      const started = allActivities(await loadState()).find(
        (activity) =>
          activity.type === 'tool.call.started' &&
          activity.payload?.['providerToolId'] === 'call-edit-1',
      );
      assert.equal(started?.payload?.['providerToolName'], 'StrReplaceFile');
      assert.equal(started?.payload?.['tool'], 'grok.StrReplaceFile');
      // Path must come from the terminal content diff, not stay blank after a diff-only start.
      assert.equal(started?.payload?.['target'], 'server/providers/grok.ts');
      assert.ok(typeof started?.payload?.['diff'] === 'string' && String(started?.payload?.['diff']).length > 0);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli keeps the start-frame tool identity when the terminal update has none', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-defer-identity-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-session-defer', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-defer' } });",
        "    if (msg.method === 'session/prompt') {",
        // Start frame has identity (title) but no rawInput/target → deferred, not emitted yet.
        "      update({ sessionUpdate: 'tool_call', toolCallId: 'call-defer-1', title: 'read_file' });",
        // Terminal update carries only status/output and the generic ACP kind Other —
        // no real identity, so it must not overwrite the start-frame ReadFile.
        "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-defer-1', status: 'completed', kind: 'Other', content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }] });",
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', totalTokens: 5 } } });",
        '    }',
        '  }',
        '});',
      ]);

      const ctx = await ingestGrokEvent(stateDir, 'Read deferred.', '1771000099.000003');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      assert.equal((await withTimeout(runtime.run(await runtimeInput(runtime, ctx, await loadState())), 2_000)).text, 'done');

      const started = allActivities(await loadState()).find(
        (activity) =>
          activity.type === 'tool.call.started' &&
          activity.payload?.['providerToolId'] === 'call-defer-1',
      );
      // Identity-less terminal update must not clobber the start-frame ReadFile with the Tool fallback.
      assert.equal(started?.payload?.['providerToolName'], 'ReadFile');
      assert.equal(started?.payload?.['tool'], 'grok.ReadFile');
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
      const crashPath = join(stateDir, 'crash-now');
      const primaryReadyPath = join(stateDir, 'primary-ready');
      const homePath = join(stateDir, 'agent-home');
      await mkdir(homePath, { recursive: true });
      const expectedCwd = await realpath(homePath);
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify({ cwd: process.cwd() }) + '\\n');",
        "const launchAttempt = Number(fs.existsSync(process.env.ATTEMPTS_PATH) ? fs.readFileSync(process.env.ATTEMPTS_PATH, 'utf8') : '0') + 1;",
        "fs.writeFileSync(process.env.ATTEMPTS_PATH, String(launchAttempt));",
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
        "      if (launchAttempt === 1) {",
        "        fs.writeFileSync(process.env.PRIMARY_READY_PATH, 'ready');",
        "        const crashTimer = setInterval(() => {",
        "          if (!fs.existsSync(process.env.CRASH_PATH)) return;",
        "          clearInterval(crashTimer);",
        "          process.exit(51);",
        "        }, 10);",
        "        continue;",
        "      }",
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
          CRASH_PATH: crashPath,
          PRIMARY_READY_PATH: primaryReadyPath,
        }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      worker = new AgentRuntimeWorker(
        {
          agentId: 'anima',
          agentRuntime: runtime,
          homePath,
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
        { agentId: 'anima', homePath, stateDir },
      );
      await runtimeSessionServiceForAgent('anima').persistProviderSession('grok-cli', {
        id: 'grok-session-retry',
        updatedAt: '2026-07-13T00:00:00.000Z',
      });
      const drain = worker.drainOnce();
      await waitFor(() => readFile(primaryReadyPath, 'utf8').then((value) => value === 'ready'));
      const followup = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-grok',
          eventId: 'evt-grok-retry-followup',
          teamId: 'T-demo',
          text: 'Preserve this accepted follow-up.',
          ts: '1771000030.000002',
          userId: 'U1',
        }),
        { agentId: 'anima', homePath, stateDir },
      );
      await waitForInboxItemAppendedTo('anima', followup.ctx.item.id, decision.ctx.item.id);
      await writeFile(crashPath, 'crash', 'utf8');

      assert.equal(await drain, 1);
      assert.equal(await queueFor('anima').find(decision.ctx.item.id), undefined);
      assert.equal(await queueFor('anima').find(followup.ctx.item.id), undefined);
      const activities = allActivities(await loadState());
      assert.deepEqual(
        activities.filter((activity) => activity.type === 'runtime.failed'),
        [],
        'provider retry settled as failure before the fake completed',
      );
      const calls = await readJsonLines(callsPath);
      assert.equal(await readFile(attemptsPath, 'utf8'), '2');
      assert.deepEqual(
        calls.filter((call) => typeof call['cwd'] === 'string').map((call) => call['cwd']),
        [expectedCwd, expectedCwd],
      );
      assert.equal(calls.filter((call) => call['method'] === 'session/load').length, 2);
      const prompts = calls.filter((call) => call['method'] === 'session/prompt');
      assert.equal(prompts.length, 3);
      assert.match(promptText(prompts[1]), /previous provider process crashed/i);
      assert.match(promptText(prompts[2]), /Preserve this accepted follow-up/);
      assert.ok(
        activities.some(
          (activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry',
        ),
      );
      assert.equal(
        activities.some((activity) => activity.type === 'runtime.failed'),
        false,
      );
      assert.equal(
        activities.some((activity) => activity.payload?.['reason'] === 'followup_rejected'),
        false,
      );
    });
  } finally {
    await worker?.close();
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});


test('grok-cli mid-turn follow-up cancels active prompt then runs the follow-up immediately', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-interrupt-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        'let pendingPromptId;',
        'let promptCount = 0;',
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-session-interrupt', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-interrupt' } });",
        "    if (msg.method === 'session/cancel') {",
        '      if (pendingPromptId !== undefined) {',
        "        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled', _meta: { cancellationCategory: 'MidTurnAbort' } } });",
        '        pendingPromptId = undefined;',
        '      }',
        '      continue;',
        '    }',
        "    if (msg.method === 'session/prompt') {",
        '      promptCount += 1;',
        '      if (promptCount === 1) {',
        '        pendingPromptId = msg.id;',
        '        // Hold open until cancel — never end_turn on primary.',
        '      } else {',
        "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'interrupted-ok' } });",
        "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5' } } });",
        '      }',
        '    }',
        '  }',
        '});',
      ]);
      const first = await ingestGrokEvent(stateDir, 'Start long Grok work.', '1771000090.000001');
      const followup = await ingestGrokEvent(stateDir, 'Interrupt now.', '1771000090.000002');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      const runPromise = runtime.run(await runtimeInput(runtime, first, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((value) => value.includes('session/prompt')));
      assert.deepEqual(
        await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, first, followup, await loadState())),
        { accepted: true, text: 'Grok follow-up applied (interrupts active prompt)' },
      );
      assert.equal((await withTimeout(runPromise, 3_000)).text, 'interrupted-ok');
      const calls = await readJsonLines(callsPath);
      const methods = calls.filter((call) => typeof call['method'] === 'string').map((call) => call['method']);
      assert.ok(methods.includes('session/cancel'));
      const prompts = calls.filter((call) => call['method'] === 'session/prompt');
      assert.equal(prompts.length, 2);
      assertFollowupPrompt(promptText(prompts[1]), 'Interrupt now.');
      // Cancel must land before the second prompt is issued.
      const cancelIdx = methods.indexOf('session/cancel');
      const secondPromptIdx = methods.lastIndexOf('session/prompt');
      assert.ok(cancelIdx >= 0 && secondPromptIdx > cancelIdx);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('grok-cli operator stop ends the active run (follow-up interrupt may have already cancelled primary)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-grok-cancel-followup-'));
  let runtime: AgentRuntime | undefined;
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const homePath = join(stateDir, 'agent-home');
      await mkdir(homePath, { recursive: true });
      await installFakeGrok(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "let promptId;",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const lines = buffer.split(/\\r?\\n/);",
        "  buffer = lines.pop() || '';",
        "  for (const line of lines) {",
        "    if (!line.trim()) continue;",
        "    const msg = JSON.parse(line);",
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, _meta: { agentVersion: '0.2.93', modelState: { currentModelId: 'grok-4.5', availableModels: [] } } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'grok-session-cancel-followup' } });",
        "    if (msg.method === 'session/prompt') promptId = msg.id;",
        "    if (msg.method === 'session/cancel') send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });",
        "  }",
        "});",
      ]);
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'grok-cli',
        model: 'grok-4.5',
      });
      worker = new AgentRuntimeWorker(
        {
          agentId: 'anima',
          agentRuntime: runtime,
          homePath,
          idleTimeoutMs: 60_000,
          pollIntervalMs: 10_000,
          queue: queueFor('anima'),
          stateDir,
          workerId: 'grok-cancel-followup-worker',
        },
        silentLogger,
      );
      const primary = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-grok',
          eventId: 'evt-grok-cancel-followup-primary',
          teamId: 'T-demo',
          text: 'Start a cancellable Grok item.',
          ts: '1771000040.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', homePath, stateDir },
      );
      const drain = worker.drainOnce();
      await waitFor(() => readFile(callsPath, 'utf8').then((value) => value.includes('session/prompt')));
      const followup = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-grok',
          eventId: 'evt-grok-cancel-followup-secondary',
          teamId: 'T-demo',
          text: 'Do not start this after cancellation.',
          ts: '1771000040.000002',
          userId: 'U1',
        }),
        { agentId: 'anima', homePath, stateDir },
      );
      await waitForInboxItemAppendedTo('anima', followup.ctx.item.id, primary.ctx.item.id);
      await queueFor('anima').requestStop(primary.ctx.item.id);
      await waitForInboxItemRemoved('anima', primary.ctx.item.id, 5_000);
      await waitForInboxItemRemoved('anima', followup.ctx.item.id, 5_000);
      await drain;

      const calls = await readJsonLines(callsPath);
      const methods = calls.filter((call) => typeof call['method'] === 'string').map((call) => call['method']);
      // Follow-up append interrupts the primary prompt (cancel) and may start a second prompt
      // before operator stop cancels again. No third prompt after the final stop.
      assert.ok(methods.includes('session/cancel'));
      assert.equal(methods[0], 'initialize');
      assert.equal(methods[1], 'session/new');
      assert.equal(methods[2], 'session/prompt');
      const promptCount = methods.filter((m) => m === 'session/prompt').length;
      assert.ok(promptCount <= 2, `unexpected prompts: ${methods.join(',')}`);
      assert.equal(methods.at(-1), 'session/cancel');
      const activities = allActivities(await loadState());
      assert.equal(
        activities.find((activity) => activity.type === 'runtime.aborted')?.payload?.['reason'],
        'user_stop',
      );
      assert.equal(
        activities.some((activity) => activity.payload?.['reason'] === 'followup_rejected'),
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

// A fake Grok whose current model advertises reasoning-effort support (low/high),
// so a configured, advertised effort triggers exactly one same-model session/set_model.
// When loadSessionId is set the fake also honors session/load for the loaded-session path.
function effortCapableFakeGrok(input: { sessionId: string; loadSessionId?: string }): string[] {
  const sessionId = JSON.stringify(input.sessionId);
  return [
    "const fs = require('fs');",
    "process.stdin.setEncoding('utf8');",
    "let buffer = '';",
    "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
    'function update(value) { send({ jsonrpc: ' +
      "'2.0', method: 'session/update', params: { sessionId: " +
      sessionId +
      ', update: value } }); }',
    "const modelState = { currentModelId: 'grok-4.5', availableModels: [{ modelId: 'grok-4.5', _meta: { totalContextTokens: 500000, supportsReasoningEffort: true, reasoningEfforts: [{ value: 'low' }, { value: 'high' }] } }] };",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    '  const lines = buffer.split(/\\r?\\n/);',
    "  buffer = lines.pop() || '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
    "    if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { agentVersion: '0.2.93', modelState } } }); continue; }",
    "    if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: " +
      sessionId +
      ', models: modelState } }); continue; }',
    "    if (msg.method === 'session/load') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: " +
      sessionId +
      ', models: modelState } }); continue; }',
    "    if (msg.method === 'session/set_model') { send({ jsonrpc: '2.0', id: msg.id, result: { models: modelState } }); continue; }",
    "    if (msg.method === 'session/prompt') { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'effort reply' } }); send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-4.5', totalTokens: 10 } } }); continue; }",
    '  }',
    '});',
  ];
}

// A fake Grok that advertises effort support for grok-4.5 at initialize, then switches
// the current model to composer (no capability signal) at session/new or session/load.
// Reproduces the stale-positive: the effort snapshot for grok-4.5 must NOT be reused
// for composer, so no session/set_model may be issued.
function crossedModelFakeGrok(input: { mode: 'new' | 'load'; sessionId: string }): string[] {
  const sessionId = JSON.stringify(input.sessionId);
  const switchMethod = input.mode === 'load' ? 'session/load' : 'session/new';
  return [
    "const fs = require('fs');",
    "process.stdin.setEncoding('utf8');",
    "let buffer = '';",
    "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
    'function update(value) { send({ jsonrpc: ' +
      "'2.0', method: 'session/update', params: { sessionId: " +
      sessionId +
      ', update: value } }); }',
    "const reasoningState = { currentModelId: 'grok-4.5', availableModels: [{ modelId: 'grok-4.5', _meta: { supportsReasoningEffort: true, reasoningEfforts: [{ value: 'low' }, { value: 'high' }] } }] };",
    "const composerState = { currentModelId: 'grok-composer-2.5-fast', availableModels: [{ modelId: 'grok-composer-2.5-fast', _meta: { totalContextTokens: 200000 } }] };",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    '  const lines = buffer.split(/\\r?\\n/);',
    "  buffer = lines.pop() || '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
    "    if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { agentVersion: '0.2.93', modelState: reasoningState } } }); continue; }",
    "    if (msg.method === '" +
      switchMethod +
      "') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: " +
      sessionId +
      ', models: composerState } }); continue; }',
    "    if (msg.method === 'session/set_model') { send({ jsonrpc: '2.0', id: msg.id, result: { models: composerState } }); continue; }",
    "    if (msg.method === 'session/prompt') { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'crossed reply' } }); send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', _meta: { modelId: 'grok-composer-2.5-fast', totalTokens: 10 } } }); continue; }",
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
