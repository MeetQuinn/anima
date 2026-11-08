import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentRuntime } from '../providers/factory.js';
import type { AgentRuntime } from '../providers/contract.js';
import {
  antigravityAcpLaunchArgs,
  antigravityCommandProblem,
  antigravityLaunchEnvironment,
  antigravityToolName,
  parseAcpSelectOptions,
} from '../providers/antigravity.js';
import { classifyProviderRetry } from '../providers/provider-retry.js';
import { runtimeSessionServiceForAgent } from '../runtime/runtime-session.service.js';
import { antigravityAcpModelCatalog, parseAntigravityConfigOptions } from '../services/system.service.js';
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

/** configOptions as `agy acp` 1.5 reports them on a free-tier account (values trimmed). */
const CONFIG_OPTIONS = [
  {
    category: 'model',
    currentValue: 'gemini-3.8-flash',
    id: 'model',
    name: 'Model',
    options: [
      { name: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash' },
      { name: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
    ],
    type: 'select',
  },
  {
    category: 'thought_level',
    currentValue: 'high',
    id: 'thought_level',
    name: 'Thinking',
    options: [
      { name: 'Low', value: 'low' },
      { name: 'Medium', value: 'medium' },
      { name: 'High', value: 'high' },
    ],
    type: 'select',
  },
  {
    category: 'mode',
    currentValue: 'agent',
    id: 'mode',
    options: [{ value: 'agent' }, { value: 'plan' }],
    type: 'select',
  },
];

/**
 * Fake `agy acp`. The scenario (JSON in AGY_SCENARIO) picks the responses:
 * - appendSystemPrompt: advertise `_meta.antigravity.systemPrompt.append`
 * - resume: 'ok' | 'missing'
 * - newError / promptError: JSON-RPC error objects
 * - richTurn: emit permission request, thought, tool call and usage on the first prompt
 */
const FAKE_AGY = [
  "const fs = require('fs');",
  "const scenario = JSON.parse(process.env.AGY_SCENARIO || '{}');",
  "const configOptions = JSON.parse(process.env.AGY_CONFIG_OPTIONS);",
  "if (process.env.LAUNCH_PATH) fs.writeFileSync(process.env.LAUNCH_PATH, JSON.stringify({ argv: process.argv.slice(2), home: process.env.HOME }));",
  "process.stdin.setEncoding('utf8');",
  "let buffer = '';",
  "let sessionId = 'agy-session-1';",
  'let promptCount = 0;',
  'let pendingPromptId;',
  "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
  "function update(value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } }); }",
  'function select(category, value) {',
  '  const option = configOptions.find((entry) => entry.category === category);',
  '  if (!option || !option.options.some((entry) => entry.value === value)) return false;',
  '  option.currentValue = value;',
  '  return true;',
  '}',
  "process.stdin.on('data', (chunk) => {",
  '  buffer += chunk;',
  '  const lines = buffer.split(/\\r?\\n/);',
  "  buffer = lines.pop() || '';",
  '  for (const line of lines) {',
  '    if (!line.trim()) continue;',
  '    const msg = JSON.parse(line);',
  "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
  "    if (msg.id === 'permission-1' && msg.result) {",
  "      fs.writeFileSync(process.env.CALLS_PATH + '.permission', JSON.stringify(msg.result));",
  "      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering' } });",
  "      update({ sessionUpdate: 'tool_call', toolCallId: 'agy-tool-1', title: 'pwd', kind: 'execute', status: 'pending', rawInput: { command: 'pwd' } });",
  "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '/tmp' } }] });",
  "      update({ sessionUpdate: 'tool_call', toolCallId: 'agy-tool-2', title: 'Read notes.md', kind: 'read', status: 'pending', locations: [{ path: '/work/notes.md' }] });",
  "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-tool-2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'no such file' } }] });",
  "      update({ sessionUpdate: 'usage_update', used: 4096, size: 1048576 });",
  "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'handled first' } });",
  "      setTimeout(() => send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } }), 80);",
  '      continue;',
  '    }',
  "    if (msg.method === 'initialize') {",
  "      const agentCapabilities = { loadSession: true, sessionCapabilities: { close: {}, resume: {} } };",
  "      if (scenario.appendSystemPrompt) agentCapabilities._meta = { antigravity: { systemPrompt: { append: true } } };",
  "      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'antigravity', version: '1.5.3' }, agentCapabilities, authMethods: [] } });",
  '      continue;',
  '    }',
  "    if (msg.method === 'session/new') {",
  "      if (scenario.newError) { send({ jsonrpc: '2.0', id: msg.id, error: scenario.newError }); continue; }",
  "      sessionId = 'agy-session-new';",
  "      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId, configOptions } });",
  '      continue;',
  '    }',
  "    if (msg.method === 'session/resume') {",
  "      if (scenario.resume === 'missing') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Failed to read session ' + msg.params.sessionId + '; retry, or load it with session/load' } }); continue; }",
  '      sessionId = msg.params.sessionId;',
  "      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions } });",
  '      continue;',
  '    }',
  "    if (msg.method === 'session/set_config_option') {",
  '      const option = configOptions.find((entry) => entry.id === msg.params.configId);',
  "      if (!option || !select(option.category, msg.params.value)) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad value' } }); continue; }",
  "      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions } });",
  '      continue;',
  '    }',
  "    if (msg.method === 'session/cancel') {",
  '      if (scenario.hang && pendingPromptId !== undefined) {',
  "        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } });",
  '        pendingPromptId = undefined;',
  '      }',
  '      continue;',
  '    }',
  "    if (msg.method === 'session/prompt') {",
  "      if (scenario.promptError) { send({ jsonrpc: '2.0', id: msg.id, error: scenario.promptError }); continue; }",
  "      if (scenario.exitOnPrompt) process.exit(0);",
  '      promptCount += 1;',
  '      if (scenario.hang) { pendingPromptId = msg.id; continue; }',
  '      if (scenario.richTurn && promptCount === 1) {',
  '        pendingPromptId = msg.id;',
  "        send({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'agy-tool-1' }, options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }, { optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'allow-always', kind: 'allow_always', name: 'Always allow' }] } });",
  '        continue;',
  '      }',
  "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: scenario.richTurn ? ' + appended' : 'reply ' + promptCount } });",
  "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '    }',
  '  }',
  '});',
];

test('antigravity-cli launches `agy acp` with permissions pre-approved and the machine HOME', () => {
  assert.deepEqual(antigravityAcpLaunchArgs(), ['acp', '--dangerously-skip-permissions']);
  assert.deepEqual(antigravityAcpLaunchArgs(['--disable-telemetry']), [
    'acp',
    '--disable-telemetry',
    '--dangerously-skip-permissions',
  ]);
  const env = antigravityLaunchEnvironment(
    { HOME: '/agent/home', PATH: '/agent/bin' },
    { HOME: '/machine/home', PATH: '/machine/bin' },
  );
  assert.equal(env.HOME, '/machine/home');
  assert.equal(env.PATH, '/agent/bin');
});

test('antigravity-cli refuses the Antigravity app editor launcher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-agy-launcher-'));
  try {
    const appBin = join(dir, 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin');
    await mkdir(appBin, { recursive: true });
    await writeFile(join(appBin, 'agy'), '#!/bin/sh\n', 'utf8');
    await chmod(join(appBin, 'agy'), 0o755);
    const pathDir = join(dir, 'bin');
    await mkdir(pathDir);
    await symlink(join(appBin, 'agy'), join(pathDir, 'agy'));
    assert.match(antigravityCommandProblem('agy', { PATH: pathDir }) ?? '', /editor launcher, not Antigravity CLI/);

    const cliDir = join(dir, 'cli');
    await mkdir(cliDir);
    await writeFile(join(cliDir, 'agy'), '#!/bin/sh\n', 'utf8');
    await chmod(join(cliDir, 'agy'), 0o755);
    assert.equal(antigravityCommandProblem('agy', { PATH: cliDir }), undefined);
    assert.equal(antigravityCommandProblem('agy', { PATH: join(dir, 'missing') }), undefined);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('antigravity-cli parses ACP select options and names tools by ACP kind', () => {
  const options = parseAcpSelectOptions([
    ...CONFIG_OPTIONS,
    { id: 'grouped', options: [{ group: 'g', name: 'G', options: [{ value: 'a' }, { value: 'b' }] }, { value: 'c' }] },
    { id: 'toggle', type: 'boolean', currentValue: true },
  ]);
  assert.deepEqual(options?.map((option) => option.id), ['model', 'thought_level', 'mode', 'grouped']);
  assert.deepEqual(options?.[3]?.values.map((entry) => entry.value), ['a', 'b', 'c']);
  assert.equal(parseAcpSelectOptions(undefined), undefined);

  assert.equal(antigravityToolName({ kind: 'execute', title: 'ls' }), 'Shell');
  assert.equal(antigravityToolName({ kind: 'edit', title: 'Edit a.ts' }), 'EditFile');
  assert.equal(antigravityToolName({ kind: 'other', title: 'browser subagent: open page' }), 'BrowserSubagent');
  assert.equal(antigravityToolName({}), 'Tool');
});

test('antigravity-cli model catalog comes from the session model select', () => {
  assert.deepEqual(parseAntigravityConfigOptions(CONFIG_OPTIONS), {
    defaultModel: 'gemini-3.8-flash',
    modelReasoningEfforts: { 'gemini-3.8-flash': ['low', 'medium', 'high'] },
    models: ['gemini-3.8-flash', 'claude-sonnet-4-6'],
  });
  assert.throws(() => parseAntigravityConfigOptions([]), /did not report any models/);
});

test('antigravity-cli catalog probe survives a JSON null line and kills a child that ignores SIGTERM', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const pidPath = join(stateDir, 'probe.pid');
      const agy = join(stateDir, 'agy');
      await writeFile(agy, [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        `const configOptions = ${JSON.stringify(CONFIG_OPTIONS)};`,
        "process.stdout.write('null\\n42\\n');",
        "let buffer = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        "  const lines = buffer.split('\\n');",
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');",
        "    if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } });",
        "    if (msg.method === 'session/new') reply({ sessionId: 'probe-session', configOptions });",
        "    if (msg.method === 'session/close') reply({});",
        '  }',
        '});',
        'setInterval(() => {}, 1000);',
      ].join('\n'), 'utf8');
      await chmod(agy, 0o755);

      const catalog = await antigravityAcpModelCatalog(agy, { killGraceMs: 100, timeoutMs: 5_000 });
      assert.equal(catalog.defaultModel, 'gemini-3.8-flash');
      const pid = Number(await readFile(pidPath, 'utf8'));
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli catalog probe times out and still kills a child that ignores SIGTERM', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-timeout-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const pidPath = join(stateDir, 'probe.pid');
      const agy = join(stateDir, 'agy');
      await writeFile(agy, [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        "process.stdin.resume();",
        'setInterval(() => {}, 1000);',
      ].join('\n'), 'utf8');
      await chmod(agy, 0o755);

      await assert.rejects(
        antigravityAcpModelCatalog(agy, { killGraceMs: 100, timeoutMs: 1_500 }),
        /model catalog probe timed out/,
      );
      await waitFor(() => readFile(pidPath, 'utf8').then(() => true, () => false));
      const pid = Number(await readFile(pidPath, 'utf8'));
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli catalog probe refuses the app editor launcher without starting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-launcher-'));
  try {
    const appBin = join(dir, 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin');
    const marker = join(dir, 'launched');
    await mkdir(appBin, { recursive: true });
    await writeFile(join(appBin, 'agy'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, 'utf8');
    await chmod(join(appBin, 'agy'), 0o755);
    await symlink(join(appBin, 'agy'), join(dir, 'agy'));
    await assert.rejects(antigravityAcpModelCatalog(join(dir, 'agy')), /editor launcher, not Antigravity CLI/);
    await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('antigravity-cli puts the system prompt in the session, selects model and thinking, and appends follow-ups', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-runtime-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const launchPath = join(stateDir, 'launch.json');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Start Antigravity.', '1786000000.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'Steer Antigravity.', '1786000000.000002');
      runtime = createAgentRuntime(
        {
          env: agyEnv(stateDir, { appendSystemPrompt: true, richTurn: true }, { LAUNCH_PATH: launchPath }),
          kind: 'antigravity-cli',
          model: 'claude-sonnet-4-6',
          reasoningEffort: 'low',
        },
        { args: ['--disable-telemetry'] },
      );

      const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      assert.deepEqual(
        await runtime.appendToActiveRun(
          await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState()),
        ),
        { accepted: true, text: 'Antigravity follow-up applied (interrupts active prompt)' },
      );
      assert.equal((await withTimeout(runPromise, 3_000)).text, 'handled first + appended');

      const launch = JSON.parse(await readFile(launchPath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(launch.argv, ['acp', '--disable-telemetry', '--dangerously-skip-permissions']);
      assert.equal(launch.home, process.env.HOME);
      assert.deepEqual(JSON.parse(await readFile(`${callsPath}.permission`, 'utf8')), {
        outcome: { optionId: 'allow-always', outcome: 'selected' },
      });
      assert.equal(runtime.health?.().child?.version, '1.5.3');

      const calls = await readJsonLines(callsPath);
      assert.deepEqual(methodsOf(calls).slice(0, 5), [
        'initialize',
        'session/new',
        'session/set_config_option',
        'session/set_config_option',
        'session/prompt',
      ]);
      const sessionNew = calls.find((call) => call.method === 'session/new')?.params as Record<string, unknown>;
      const meta = sessionNew._meta as { antigravity?: { systemPrompt?: { append?: string } } };
      assert.match(meta.antigravity?.systemPrompt?.append ?? '', /You are Anima/);
      assert.deepEqual(
        calls.filter((call) => call.method === 'session/set_config_option').map((call) => call.params),
        [
          { configId: 'model', sessionId: 'agy-session-new', value: 'claude-sonnet-4-6' },
          { configId: 'thought_level', sessionId: 'agy-session-new', value: 'low' },
        ],
      );
      const prompts = promptTexts(calls);
      assert.equal(prompts.length, 2);
      assert.doesNotMatch(prompts[0] ?? '', /You are Anima/);
      assert.match(prompts[0] ?? '', /Start Antigravity\./);
      assertFollowupPrompt(prompts[1] ?? '', 'Steer Antigravity.');
      assert.deepEqual(await providerSessionStartedPayload(firstCtx.item.id), {
        kind: 'antigravity-cli',
        resumed: false,
      });

      const state = await loadState();
      assert.equal(state.sessions.anima?.current?.id, 'agy-session-new');
      assert.equal(state.sessions.anima?.latestProviderStats?.currentContextTokens, 4096);
      assert.equal(state.sessions.anima?.latestProviderStats?.contextWindow, 1_048_576);
      const activities = allActivities(state);
      const shell = activities.find((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-tool-1');
      assert.equal(shell?.payload?.['tool'], 'antigravity.Shell');
      assert.equal(shell?.payload?.['command'], 'pwd');
      const read = activities.find((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-tool-2');
      assert.equal(read?.payload?.['tool'], 'antigravity.ReadFile');
      assert.equal(read?.payload?.['target'], '/work/notes.md');
      assert.ok(activities.some((activity) =>
        activity.type === 'tool.call.failed' && activity.payload?.['providerToolId'] === 'agy-tool-2'));
      assert.ok(activities.some((activity) =>
        activity.type === 'runtime.event'
          && activity.payload?.['eventType'] === 'antigravity.model.selected'
          && activity.payload?.['model'] === 'claude-sonnet-4-6'
          && activity.payload?.['reasoningEffort'] === 'low'));
      for (const hiddenEventType of [
        'antigravity.system.init',
        'antigravity.turn.started',
        'antigravity.thinking.delta',
        'provider.reasoning',
        'antigravity.tool_result',
        'antigravity.turn.completed',
      ]) {
        assert.equal(
          activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === hiddenEventType),
          false,
          hiddenEventType,
        );
      }
      const usage = await agentTokenUsageServiceForAgent('anima').summary({
        agentName: 'Anima',
        from: '2000-01-01',
        through: '2100-01-01',
        timezone: 'UTC',
      });
      assert.equal(usage.reportedRuns, 1);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli rejects the turn when the final transcript write fails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-finish-write-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Write fails.', '1786000015.000001');
      runtime = createAgentRuntime({ env: agyEnv(stateDir, {}), kind: 'antigravity-cli' });
      const input = await runtimeInput(runtime, ctx, await loadState());
      const failing = {
        ...input,
        effects: {
          ...input.effects,
          recordAgentText: async () => {
            throw new Error('transcript write failed');
          },
        },
      };
      await assert.rejects(withTimeout(runtime.run(failing), 3_000), /transcript write failed/);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli keeps the current model, skips an unavailable thinking level, and prepends the prompt when append is unsupported', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-defaults-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Use defaults.', '1786000010.000001');
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, {}),
        kind: 'antigravity-cli',
        model: 'gemini-3.8-flash',
        reasoningEffort: 'max',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(methodsOf(calls), ['initialize', 'session/new', 'session/prompt']);
      const sessionNew = calls.find((call) => call.method === 'session/new')?.params as Record<string, unknown>;
      assert.equal('_meta' in sessionNew, false);
      assert.match(promptTexts(calls)[0] ?? '', /You are Anima[\s\S]*---[\s\S]*Use defaults\./);
      assert.ok(allActivities(await loadState()).some((activity) =>
        activity.payload?.['eventType'] === 'antigravity.effort.unavailable'
          && activity.payload?.['reasoningEffort'] === 'max'));
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli fails clearly when the account does not offer the configured model', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-model-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Use Argon.', '1786000020.000001');
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, { appendSystemPrompt: true }),
        kind: 'antigravity-cli',
        model: 'gemini-4-argon',
      });

      await assert.rejects(
        runtime.run(await runtimeInput(runtime, ctx, await loadState())),
        /does not offer gemini-4-argon to the signed-in account \(available: gemini-3\.8-flash, claude-sonnet-4-6\)/,
      );
      assert.equal(methodsOf(await readJsonLines(callsPath)).includes('session/prompt'), false);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli resumes a persisted session without resending the system prompt', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-resume-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Resume Antigravity.', '1786000030.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('antigravity-cli', {
        id: 'agy-session-existing',
        updatedAt: '2026-11-08T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, { appendSystemPrompt: true, resume: 'ok' }),
        kind: 'antigravity-cli',
        model: 'gemini-3.8-flash',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(methodsOf(calls), ['initialize', 'session/resume', 'session/prompt']);
      assert.deepEqual(calls[1]?.params, { cwd: stateDir, mcpServers: [], sessionId: 'agy-session-existing' });
      assert.doesNotMatch(promptTexts(calls)[0] ?? '', /You are Anima/);
      assert.deepEqual(await providerSessionStartedPayload(ctx.item.id), {
        id: 'agy-session-existing',
        kind: 'antigravity-cli',
        resumed: true,
      });
      assert.equal((await loadState()).sessions.anima?.current?.id, 'agy-session-existing');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli creates a fresh session when the persisted one is gone', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-resume-missing-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Recover Antigravity.', '1786000040.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('antigravity-cli', {
        id: 'agy-session-missing',
        updatedAt: '2026-11-08T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, { appendSystemPrompt: true, resume: 'missing' }),
        kind: 'antigravity-cli',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(methodsOf(calls), ['initialize', 'session/resume', 'session/new', 'session/prompt']);
      const sessionNew = calls.find((call) => call.method === 'session/new')?.params as Record<string, unknown>;
      assert.ok(sessionNew._meta, 'a fresh session carries the system prompt');
      assert.equal((await loadState()).sessions.anima?.current?.id, 'agy-session-new');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli turns ACP authentication errors into sign-in guidance', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-auth-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Sign in please.', '1786000050.000001');
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, { newError: { code: -32000, message: 'Authentication required' } }),
        kind: 'antigravity-cli',
      });

      await assert.rejects(
        runtime.run(await runtimeInput(runtime, ctx, await loadState())),
        /Antigravity CLI is not signed in on this machine\. Run `agy` in a terminal once and sign in/,
      );
      assert.equal(runtime.health?.().child, undefined);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli sends ACP cancel before tearing down an aborted turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-cancel-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Cancel Antigravity.', '1786000060.000001');
      runtime = createAgentRuntime({ env: agyEnv(stateDir, { hang: true }), kind: 'antigravity-cli' });
      const abort = new AbortController();
      const run = runtime.run({
        ...(await runtimeInput(runtime, ctx, await loadState())),
        signal: abort.signal,
      });
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      abort.abort('operator_abort');
      await assert.rejects(run, /Antigravity turn cancelled/);
      const cancel = (await readJsonLines(callsPath)).find((call) => call.method === 'session/cancel');
      assert.deepEqual(cancel?.params, { sessionId: 'agy-session-new' });
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('an Antigravity process that exits cleanly mid-turn is retried as a crash', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-exit-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Exit mid-turn.', '1786000070.000001');
      runtime = createAgentRuntime({ env: agyEnv(stateDir, { exitOnPrompt: true }), kind: 'antigravity-cli' });
      const error = await runtime.run(await runtimeInput(runtime, ctx, await loadState())).then(
        () => assert.fail('the turn should fail'),
        (failure: unknown) => failure,
      );
      assert.equal(classifyProviderRetry(error), 'crash', String(error));
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

function agyEnv(
  stateDir: string,
  scenario: Record<string, unknown>,
  extra: Record<string, string> = {},
): Record<string, string> {
  return runtimeTestEnv(stateDir, {
    AGY_CONFIG_OPTIONS: JSON.stringify(CONFIG_OPTIONS),
    AGY_SCENARIO: JSON.stringify(scenario),
    CALLS_PATH: join(stateDir, 'calls.jsonl'),
    ...extra,
  });
}

async function installFakeAgy(stateDir: string): Promise<void> {
  const path = join(stateDir, 'agy');
  await writeFile(path, ['#!/usr/bin/env node', ...FAKE_AGY].join('\n'), 'utf8');
  await chmod(path, 0o755);
}

async function ingestAgyEvent(stateDir: string, text: string, ts: string) {
  return ingestEvent(
    makeSlackEvent({
      channelId: 'D-antigravity',
      teamId: 'T-demo',
      text,
      ts,
      userId: 'U1',
    }),
    { agentId: 'anima', stateDir },
  );
}

function methodsOf(calls: Array<Record<string, unknown>>): string[] {
  return calls.filter((call) => typeof call.method === 'string').map((call) => call.method as string);
}

function promptTexts(calls: Array<Record<string, unknown>>): string[] {
  return calls
    .filter((call) => call.method === 'session/prompt')
    .map((call) => ((call.params as Record<string, unknown>)?.prompt as Array<{ text?: string }>)[0]?.text ?? '');
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
