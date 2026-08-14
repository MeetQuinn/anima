import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentRuntime } from '../providers/factory.js';
import type { AgentRuntime } from '../providers/contract.js';
import { openCodeLaunchEnvironment } from '../providers/opencode.js';
import { runtimeSessionServiceForAgent } from '../runtime/runtime-session.service.js';
import { withAnimaHome } from './anima-home.js';
import { agentTokenUsageServiceForAgent } from '../usage/agent-token-usage.service.js';
import {
  assertFollowupPrompt,
  providerSessionStartedPayload,
  runtimeFollowupInput,
  runtimeInput,
  runtimeTestEnv,
} from './helpers/agent-runtime.js';
import { waitFor, withTimeout } from './helpers/harness.js';
import { ingestEvent } from './helpers/inbox.js';
import { makeSlackEvent } from './helpers/slack.js';
import { allActivities, loadState } from './helpers/state.js';

test('opencode-cli pins machine-level identity paths and strips per-agent credential overrides', () => {
  const env = openCodeLaunchEnvironment(
    {
      DEEPSEEK_API_KEY: 'agent-key',
      HOME: '/agent/home',
      OPENCODE_AUTH_CONTENT: '{"deepseek":"agent-key"}',
      OPENCODE_CONFIG: '/agent/opencode.json',
      OPENCODE_CONFIG_CONTENT: '{"provider":{"deepseek":{"options":{"apiKey":"agent-key"}}}}',
      OPENCODE_CONFIG_DIR: '/agent/.opencode',
      PATH: '/agent/bin',
      XDG_CONFIG_HOME: '/agent/config',
      XDG_DATA_HOME: '/agent/data',
    },
    {
      HOME: '/machine/home',
      OPENCODE_CONFIG: '/machine/opencode.json',
      PATH: '/machine/bin',
      XDG_DATA_HOME: '/machine/data',
    },
  );

  assert.equal(env.HOME, '/machine/home');
  assert.equal(env.XDG_DATA_HOME, '/machine/data');
  assert.equal(env.OPENCODE_CONFIG, '/machine/opencode.json');
  assert.equal(env.XDG_CONFIG_HOME, undefined);
  assert.equal(env.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.OPENCODE_AUTH_CONTENT, undefined);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(env.PATH, '/agent/bin');
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
});

test('opencode-cli ACP uses global DeepSeek auth, selects the model, and appends follow-ups', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-opencode-runtime-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const launchPath = join(stateDir, 'launch.json');
      const permissionPath = join(stateDir, 'permission.json');
      await installFakeOpenCode(stateDir, [
        "const fs = require('fs');",
        "fs.writeFileSync(process.env.LAUNCH_PATH, JSON.stringify({ argv: process.argv.slice(2), autoUpdate: process.env.OPENCODE_DISABLE_AUTOUPDATE, deepseek: process.env.DEEPSEEK_API_KEY, authContent: process.env.OPENCODE_AUTH_CONTENT, configContent: process.env.OPENCODE_CONFIG_CONTENT }));",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        'let effortSelected = false;',
        'let modelSelected = false;',
        'let promptCount = 0;',
        'let promptRequestId;',
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'opencode-session-1', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.id === 'permission-1' && msg.result) {",
        "      fs.writeFileSync(process.env.PERMISSION_PATH, JSON.stringify(msg.result));",
        "      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering' } });",
        "      update({ sessionUpdate: 'usage_update', used: 4096, size: 1000000, cost: { amount: 0.012 } });",
        "      update({ sessionUpdate: 'tool_call', toolCallId: 'opencode-tool-1', title: 'Run command', kind: 'execute', rawInput: { command: 'pwd', description: 'Show working directory' } });",
        "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'opencode-tool-1', status: 'completed', rawOutput: { output: '/tmp\\n' } });",
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'handled first' } });",
        "      setTimeout(() => send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } } }), 80);",
        '      continue;',
        '    }',
        "    if (msg.method === 'initialize') {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.18.4' }, agentCapabilities: { loadSession: true } } });",
        '      continue;',
        '    }',
        "    if (msg.method === 'session/new') {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'opencode-session-1' } });",
        '      continue;',
        '    }',
        "    if (msg.method === 'session/set_config_option') {",
        "      if (msg.params.configId === 'model' && msg.params.value === 'deepseek/deepseek-v4-pro') modelSelected = true;",
        "      else if (msg.params.configId === 'effort' && msg.params.value === 'max' && modelSelected) effortSelected = true;",
        '      else process.exit(41);',
        "      send({ jsonrpc: '2.0', id: msg.id, result: {} });",
        '      continue;',
        '    }',
        "    if (msg.method === 'session/prompt') {",
        '      if (!modelSelected || !effortSelected) process.exit(42);',
        '      promptCount += 1;',
        '      if (promptCount === 1) {',
        '        promptRequestId = msg.id;',
        "        send({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'opencode-session-1', options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }, { optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Allow always' }] } });",
        '      } else {',
        "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' + appended' } });",
        "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } } });",
        '      }',
        '    }',
        '  }',
        '});',
      ]);

      const firstCtx = await ingestOpenCodeEvent(stateDir, 'Start OpenCode.', '1785000000.000001');
      const secondCtx = await ingestOpenCodeEvent(stateDir, 'Steer OpenCode.', '1785000000.000002');
      runtime = createAgentRuntime(
        {
          env: runtimeTestEnv(stateDir, {
            CALLS_PATH: callsPath,
            DEEPSEEK_API_KEY: 'per-agent-secret-must-be-removed',
            LAUNCH_PATH: launchPath,
            OPENCODE_AUTH_CONTENT: '{"deepseek":"must-be-removed"}',
            OPENCODE_CONFIG_CONTENT: '{"provider":{"deepseek":{"options":{"apiKey":"must-be-removed"}}}}',
            PERMISSION_PATH: permissionPath,
          }),
          kind: 'opencode-cli',
          model: 'deepseek/deepseek-v4-pro',
          reasoningEffort: 'max',
        },
        { args: ['--profile', 'team one'] },
      );

      const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      assert.deepEqual(
        await runtime.appendToActiveRun(
          await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState()),
        ),
        { accepted: true, text: 'OpenCode follow-up applied (interrupts active prompt)' },
      );
      assert.equal((await withTimeout(runPromise, 2_000)).text, 'handled first + appended');

      const launch = JSON.parse(await readFile(launchPath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(launch.argv, ['--profile', 'team one', 'acp', '--pure']);
      assert.equal(launch.autoUpdate, '1');
      assert.equal(launch.deepseek, undefined);
      assert.equal(launch.authContent, undefined);
      assert.equal(launch.configContent, undefined);
      assert.deepEqual(JSON.parse(await readFile(permissionPath, 'utf8')), {
        outcome: { optionId: 'always', outcome: 'selected' },
      });
      assert.equal(runtime.health?.().child?.version, '1.18.4');

      const calls = await readJsonLines(callsPath);
      const methods = calls
        .filter((call) => typeof call.method === 'string')
        .map((call) => call.method);
      assert.deepEqual(methods.slice(0, 5), [
        'initialize',
        'session/new',
        'session/set_config_option',
        'session/set_config_option',
        'session/prompt',
      ]);
      assert.deepEqual(
        calls
          .filter((call) => call.method === 'session/set_config_option')
          .map((call) => call.params),
        [
          {
            configId: 'model',
            sessionId: 'opencode-session-1',
            value: 'deepseek/deepseek-v4-pro',
          },
          {
            configId: 'effort',
            sessionId: 'opencode-session-1',
            value: 'max',
          },
        ],
      );
      const prompts = calls.filter((call) => call.method === 'session/prompt');
      assert.equal(prompts.length, 2);
      const firstPrompt = ((prompts[0]?.params as Record<string, unknown>)?.prompt as Array<{ text?: string }>)[0]?.text ?? '';
      const secondPrompt = ((prompts[1]?.params as Record<string, unknown>)?.prompt as Array<{ text?: string }>)[0]?.text ?? '';
      assert.match(firstPrompt, /You are Anima/);
      assertFollowupPrompt(secondPrompt, 'Steer OpenCode.');
      assert.deepEqual(await providerSessionStartedPayload(firstCtx.item.id), {
        kind: 'opencode-cli',
        resumed: false,
      });

      const state = await loadState();
      assert.equal(state.sessions.anima?.current?.id, 'opencode-session-1');
      assert.equal(state.sessions.anima?.latestProviderStats?.currentContextTokens, 4096);
      assert.equal(state.sessions.anima?.latestProviderStats?.contextWindow, 1_000_000);
      const activities = allActivities(state);
      const shell = activities.find((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'opencode-tool-1');
      assert.equal(shell?.payload?.['tool'], 'opencode.Shell');
      assert.equal(shell?.payload?.['command'], 'pwd');
      assert.equal(shell?.payload?.['target'], 'Show working directory');
      assert.ok(activities.some((activity) =>
        activity.type === 'runtime.event'
          && activity.payload?.['eventType'] === 'opencode.context.stats'
          && activity.payload?.['currentContextTokens'] === 4096
          && activity.payload?.['contextWindow'] === 1_000_000
          && activity.payload?.['costUsd'] === 0.012));
      const usage = await agentTokenUsageServiceForAgent('anima').summary({
        agentName: 'Anima',
        from: '2000-01-01',
        through: '2100-01-01',
        timezone: 'UTC',
      });
      assert.equal(usage.totalTokens, 132);
      assert.equal(usage.reportedRuns, 2);
      assert.equal(usage.unknownRuns, 0);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('opencode-cli resumes an existing session and creates a fresh one only when ACP reports it missing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-opencode-resume-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeOpenCode(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'opencode-session-fresh', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.18.4' } } });",
        "    if (msg.method === 'session/resume') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Session not found' } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'opencode-session-fresh' } });",
        "    if (msg.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: msg.id, result: {} });",
        "    if (msg.method === 'session/prompt') {",
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh reply' } });",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
        '    }',
        '  }',
        '});',
      ]);
      const ctx = await ingestOpenCodeEvent(stateDir, 'Recover OpenCode.', '1785000010.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('opencode-cli', {
        id: 'opencode-session-missing',
        updatedAt: '2026-07-25T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'opencode-cli',
        model: 'deepseek/deepseek-v4-flash',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'fresh reply');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(
        calls.filter((call) => typeof call.method === 'string').map((call) => call.method),
        ['initialize', 'session/resume', 'session/new', 'session/set_config_option', 'session/prompt'],
      );
      assert.deepEqual((calls[1]?.params as Record<string, unknown>), {
        cwd: stateDir,
        mcpServers: [],
        sessionId: 'opencode-session-missing',
      });
      assert.deepEqual(await providerSessionStartedPayload(ctx.item.id), {
        id: 'opencode-session-missing',
        kind: 'opencode-cli',
        resumed: true,
      });
      assert.equal((await loadState()).sessions.anima?.current?.id, 'opencode-session-fresh');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('opencode-cli resumes a persisted session without creating a replacement', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-opencode-resume-existing-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeOpenCode(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'opencode-session-existing', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.18.4' } } });",
        "    if (msg.method === 'session/resume') send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } });",
        "    if (msg.method === 'session/new') process.exit(51);",
        "    if (msg.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: msg.id, result: {} });",
        "    if (msg.method === 'session/prompt') {",
        "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed reply' } });",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
        '    }',
        '  }',
        '});',
      ]);
      const ctx = await ingestOpenCodeEvent(stateDir, 'Resume OpenCode.', '1785000012.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('opencode-cli', {
        id: 'opencode-session-existing',
        updatedAt: '2026-07-25T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'opencode-cli',
        model: 'deepseek/deepseek-v4-pro',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'resumed reply');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(
        calls.filter((call) => typeof call.method === 'string').map((call) => call.method),
        ['initialize', 'session/resume', 'session/set_config_option', 'session/prompt'],
      );
      assert.deepEqual((calls[1]?.params as Record<string, unknown>), {
        cwd: stateDir,
        mcpServers: [],
        sessionId: 'opencode-session-existing',
      });
      assert.equal((await loadState()).sessions.anima?.current?.id, 'opencode-session-existing');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('opencode-cli turns ACP DeepSeek authentication errors into machine-level setup guidance', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-opencode-auth-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeOpenCode(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.18.4' } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'opencode-session-auth' } });",
        "    if (msg.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: msg.id, result: {} });",
        "    if (msg.method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required for provider deepseek' } });",
        '  }',
        '});',
      ]);
      const ctx = await ingestOpenCodeEvent(stateDir, 'Use DeepSeek.', '1785000015.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'opencode-cli',
        model: 'deepseek/deepseek-v4-pro',
      });

      await assert.rejects(
        runtime.run(await runtimeInput(runtime, ctx, await loadState())),
        /machine-level credential with `opencode auth login --provider deepseek`/,
      );
      assert.equal(runtime.health?.().child, undefined);
      assert.equal((await readFile(callsPath, 'utf8')).includes('DEEPSEEK_API_KEY'), false);
      const usage = await agentTokenUsageServiceForAgent('anima').summary({
        agentName: 'Anima',
        from: '2000-01-01',
        through: '2100-01-01',
        timezone: 'UTC',
      });
      assert.equal(usage.reportedRuns, 0);
      assert.equal(usage.unknownRuns, 1);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('opencode-cli sends ACP cancel before tearing down an aborted turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-opencode-cancel-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeOpenCode(stateDir, [
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
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.18.4' } } });",
        "    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'opencode-session-cancel' } });",
        "    if (msg.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: msg.id, result: {} });",
        "    if (msg.method === 'session/prompt') promptId = msg.id;",
        "    if (msg.method === 'session/cancel') send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });",
        '  }',
        '});',
      ]);
      const ctx = await ingestOpenCodeEvent(stateDir, 'Cancel OpenCode.', '1785000020.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'opencode-cli',
        model: 'deepseek/deepseek-v4-pro',
      });
      const abort = new AbortController();
      const run = runtime.run({
        ...(await runtimeInput(runtime, ctx, await loadState())),
        signal: abort.signal,
      });
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      abort.abort('operator_abort');
      await assert.rejects(run, /OpenCode turn cancelled/);
      const cancel = (await readJsonLines(callsPath)).find((call) => call.method === 'session/cancel');
      assert.deepEqual(cancel?.params, { sessionId: 'opencode-session-cancel' });
      assert.equal('id' in (cancel ?? {}), false);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('opencode-cli mid-turn follow-up cancels active prompt then runs the follow-up immediately', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-opencode-interrupt-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeOpenCode(stateDir, [
        "const fs = require('fs');",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        'let pendingPromptId;',
        'let promptCount = 0;',
        "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
        "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'opencode-session-interrupt', update: value } }); }",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        '  const lines = buffer.split(/\\r?\\n/);',
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "    if (msg.method === 'initialize') {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.18.4' }, agentCapabilities: { loadSession: true } } });",
        '      continue;',
        '    }',
        "    if (msg.method === 'session/new') {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'opencode-session-interrupt' } });",
        '      continue;',
        '    }',
        "    if (msg.method === 'session/set_config_option') {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: {} });",
        '      continue;',
        '    }',
        "    if (msg.method === 'session/cancel') {",
        '      if (pendingPromptId !== undefined) {',
        "        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } });",
        '        pendingPromptId = undefined;',
        '      }',
        '      continue;',
        '    }',
        "    if (msg.method === 'session/prompt') {",
        '      promptCount += 1;',
        '      if (promptCount === 1) {',
        '        pendingPromptId = msg.id;',
        "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale-primary' } });",
        '      } else {',
        "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'interrupted-ok' } });",
        "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
        '      }',
        '    }',
        '  }',
        '});',
      ]);

      const firstCtx = await ingestOpenCodeEvent(stateDir, 'Start long OpenCode work.', '1785000090.000001');
      const followupCtx = await ingestOpenCodeEvent(stateDir, 'Interrupt now.', '1785000090.000002');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'opencode-cli',
        model: 'deepseek/deepseek-v4-pro',
      });
      const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        await runtime.appendToActiveRun(
          await runtimeFollowupInput(runtime, firstCtx, followupCtx, await loadState()),
        ),
        { accepted: true, text: 'OpenCode follow-up applied (interrupts active prompt)' },
      );
      const finalText = (await withTimeout(runPromise, 3_000)).text ?? '';
      assert.equal(finalText, 'interrupted-ok');
      assert.ok(!finalText.includes('stale-primary'), finalText);
      const calls = await readJsonLines(callsPath);
      const methods = calls
        .filter((call) => typeof call.method === 'string')
        .map((call) => call.method as string);
      assert.ok(methods.includes('session/cancel'));
      const prompts = calls.filter((call) => call.method === 'session/prompt');
      assert.equal(prompts.length, 2);
      const secondPrompt = ((prompts[1]?.params as Record<string, unknown>)?.prompt as Array<{ text?: string }>)[0]?.text ?? '';
      assertFollowupPrompt(secondPrompt, 'Interrupt now.');
      const cancelIdx = methods.indexOf('session/cancel');
      const secondPromptIdx = methods.lastIndexOf('session/prompt');
      assert.ok(cancelIdx >= 0 && secondPromptIdx > cancelIdx);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function installFakeOpenCode(stateDir: string, body: string[]): Promise<void> {
  const path = join(stateDir, 'opencode');
  await writeFile(path, ['#!/usr/bin/env node', ...body].join('\n'), 'utf8');
  await chmod(path, 0o755);
}

async function ingestOpenCodeEvent(stateDir: string, text: string, ts: string) {
  return ingestEvent(
    makeSlackEvent({
      channelId: 'D-opencode',
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
