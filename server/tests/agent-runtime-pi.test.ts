import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentRuntime } from '../providers/factory.js';
import type { AgentRuntime } from '../providers/contract.js';
import { piBashToolTimeoutMs, piLaunchArgs, piLaunchEnvironment } from '../providers/pi.js';
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

const FAKE_PI_PRELUDE = [
  "const fs = require('fs');",
  'const argv = process.argv.slice(2);',
  "const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };",
  "const sessionId = flag('--session-id');",
  "if (process.env.LAUNCH_PATH) fs.writeFileSync(process.env.LAUNCH_PATH, JSON.stringify({ argv, geminiKey: process.env.GEMINI_API_KEY, agentDir: process.env.PI_CODING_AGENT_DIR, skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK, telemetry: process.env.PI_TELEMETRY, systemPrompt: flag('--system-prompt') ? fs.readFileSync(flag('--system-prompt'), 'utf8') : undefined }));",
  "if (process.env.STDERR_WARNING) process.stderr.write(process.env.STDERR_WARNING + '\\n');",
  "process.stdin.setEncoding('utf8');",
  "let buffer = '';",
  "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
  "function respond(msg, data) { send({ id: msg.id, type: 'response', command: msg.type, success: true, ...(data === undefined ? {} : { data }) }); }",
  "function assistant(text, usage, stopReason, errorMessage) { return { role: 'assistant', content: text ? [{ type: 'text', text }] : [], provider: 'google', model: 'gemini-2.5-pro', usage, stopReason, ...(errorMessage ? { errorMessage } : {}) }; }",
  "function state() { return { sessionId, sessionFile: '/tmp/fake-pi-session.jsonl', model: { id: 'gemini-2.5-pro', provider: 'google', contextWindow: 1048576 }, thinkingLevel: 'high', isStreaming: false }; }",
  "process.stdin.on('data', (chunk) => {",
  '  buffer += chunk;',
  '  const lines = buffer.split(/\\r?\\n/);',
  "  buffer = lines.pop() || '';",
  '  for (const line of lines) {',
  '    if (!line.trim()) continue;',
  '    const msg = JSON.parse(line);',
  "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
  '    handle(msg);',
  '  }',
  '});',
];

test('pi launch args and environment pin machine-level identity and strip per-agent API keys', () => {
  assert.deepEqual(
    piLaunchArgs(['--profile', 'team one'], {
      model: 'google/gemini-2.5-pro',
      reasoningEffort: 'high',
      sessionId: 'session-1',
      systemPromptFilePath: '/tmp/prompt.md',
    }),
    [
      '--profile', 'team one',
      '--mode', 'rpc',
      '--no-extensions',
      '--session-id', 'session-1',
      '--model', 'google/gemini-2.5-pro',
      '--thinking', 'high',
      '--system-prompt', '/tmp/prompt.md',
    ],
  );

  const env = piLaunchEnvironment(
    {
      ANTHROPIC_API_KEY: 'agent-anthropic',
      DEEPSEEK_API_KEY: 'agent-deepseek',
      GEMINI_API_KEY: 'agent-gemini',
      HOME: '/agent/home',
      PATH: '/agent/bin',
      PI_CODING_AGENT_DIR: '/agent/.pi',
    },
    {
      GEMINI_API_KEY: 'machine-gemini',
      HOME: '/machine/home',
      PATH: '/machine/bin',
    },
  );
  assert.equal(env.HOME, '/machine/home');
  assert.equal(env.PI_CODING_AGENT_DIR, undefined);
  assert.equal(env.GEMINI_API_KEY, 'machine-gemini');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, '/agent/bin');
  assert.equal(env.PI_SKIP_VERSION_CHECK, '1');
  assert.equal(env.PI_TELEMETRY, '0');
});

test('pi RPC runs a turn with the Anima system prompt, maps tools and usage, and steers follow-ups', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-pi-runtime-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const launchPath = join(stateDir, 'launch.json');
      await installFakePi(stateDir, [
        ...FAKE_PI_PRELUDE,
        'function handle(msg) {',
        "  if (msg.type === 'get_state') return respond(msg, state());",
        "  if (msg.type === 'prompt') {",
        '    respond(msg);',
        "    send({ type: 'agent_start' });",
        "    send({ type: 'turn_start' });",
        "    send({ type: 'message_update', message: assistant('', {}, 'pending'), assistantMessageEvent: { type: 'thinking_delta', delta: 'considering' } });",
        "    send({ type: 'message_update', message: assistant('', {}, 'pending'), assistantMessageEvent: { type: 'text_delta', delta: 'handled ' } });",
        "    send({ type: 'message_update', message: assistant('', {}, 'pending'), assistantMessageEvent: { type: 'text_delta', delta: 'first' } });",
        "    send({ type: 'message_end', message: assistant('handled first', { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.012 } }, 'toolUse') });",
        "    send({ type: 'tool_execution_start', toolCallId: 'pi-tool-1', toolName: 'bash', args: { command: 'pwd' } });",
        "    send({ type: 'tool_execution_end', toolCallId: 'pi-tool-1', toolName: 'bash', result: { content: [{ type: 'text', text: '/tmp\\n' }] }, isError: false });",
        '    return;',
        '  }',
        "  if (msg.type === 'steer') {",
        '    respond(msg);',
        "    send({ type: 'message_update', message: assistant('', {}, 'pending'), assistantMessageEvent: { type: 'text_delta', delta: 'and appended' } });",
        "    send({ type: 'message_end', message: assistant('and appended', { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.001 } }, 'stop') });",
        "    send({ type: 'turn_end' });",
        "    send({ type: 'agent_end', messages: [] });",
        "    send({ type: 'agent_settled' });",
        '    return;',
        '  }',
        "  respond(msg);",
        '}',
      ]);

      const firstCtx = await ingestPiEvent(stateDir, 'Start pi.', '1786000000.000001');
      const secondCtx = await ingestPiEvent(stateDir, 'Steer pi.', '1786000000.000002');
      runtime = createAgentRuntime(
        {
          env: runtimeTestEnv(stateDir, {
            CALLS_PATH: callsPath,
            GEMINI_API_KEY: 'per-agent-secret-must-be-removed',
            LAUNCH_PATH: launchPath,
            STDERR_WARNING: "Warning: No project session found with id 'fresh'; creating a new session with that id.",
          }),
          kind: 'pi',
          model: 'google/gemini-2.5-pro',
          reasoningEffort: 'high',
        },
        { args: ['--profile', 'team one'] },
      );

      const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"type":"prompt"')).catch(() => false));
      assert.deepEqual(
        await runtime.appendToActiveRun(
          await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState()),
        ),
        { accepted: true, text: 'pi follow-up applied (steered into active turn)' },
      );
      assert.equal((await withTimeout(runPromise, 5_000)).text, 'handled first\n\nand appended');

      const launch = JSON.parse(await readFile(launchPath, 'utf8')) as Record<string, unknown>;
      const argv = launch.argv as string[];
      const sessionId = argv[argv.indexOf('--session-id') + 1] ?? '';
      assert.ok(sessionId.length > 0);
      assert.deepEqual(argv, [
        '--profile', 'team one',
        '--mode', 'rpc',
        '--no-extensions',
        '--session-id', sessionId,
        '--model', 'google/gemini-2.5-pro',
        '--thinking', 'high',
        '--system-prompt', argv[argv.length - 1],
      ]);
      assert.match(String(launch.systemPrompt), /You are Anima/);
      assert.equal(launch.geminiKey, process.env.GEMINI_API_KEY?.trim() || undefined);
      assert.equal(launch.skipVersionCheck, '1');
      assert.equal(launch.telemetry, '0');

      const calls = await readJsonLines(callsPath);
      assert.deepEqual(calls.map((call) => call.type), ['get_state', 'prompt', 'steer']);
      assert.match(String(calls[1]?.message), /Start pi\./);
      assert.doesNotMatch(String(calls[1]?.message), /You are Anima/);
      assertFollowupPrompt(String(calls[2]?.message), 'Steer pi.');
      assert.deepEqual(await providerSessionStartedPayload(firstCtx.item.id), {
        kind: 'pi',
        resumed: false,
      });

      const state = await loadState();
      assert.equal(state.sessions.anima?.current?.id, sessionId);
      assert.equal(state.sessions.anima?.latestProviderStats?.currentContextTokens, 12);
      assert.equal(state.sessions.anima?.latestProviderStats?.contextWindow, 1_048_576);
      const activities = allActivities(state);
      const shell = activities.find((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'pi-tool-1');
      assert.equal(shell?.payload?.['tool'], 'pi.bash');
      assert.equal(shell?.payload?.['command'], 'pwd');
      assert.ok(activities.some((activity) =>
        activity.type === 'runtime.event'
          && activity.payload?.['eventType'] === 'pi.session.stats'
          && activity.payload?.['model'] === 'google/gemini-2.5-pro'
          && activity.payload?.['totalTokens'] === 120
          && activity.payload?.['costUsd'] === 0.012
          && activity.payload?.['terminalReason'] === 'toolUse'));
      assert.ok(activities.some((activity) =>
        activity.type === 'agent.text' && activity.payload?.['eventType'] === 'pi.assistant'));
      // A fresh --session-id always triggers pi's "no project session" warning; it is not a resume miss.
      assert.equal(activities.some((activity) =>
        activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'pi.session.resume_missing'), false);
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

test('pi resumes a persisted session id and records when pi had to recreate it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-pi-resume-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakePi(stateDir, [
        ...FAKE_PI_PRELUDE,
        'function handle(msg) {',
        "  if (msg.type === 'get_state') return respond(msg, state());",
        "  if (msg.type === 'prompt') {",
        '    respond(msg);',
        "    send({ type: 'message_update', message: assistant('', {}, 'pending'), assistantMessageEvent: { type: 'text_delta', delta: 'resumed reply' } });",
        "    send({ type: 'message_end', message: assistant('resumed reply', { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0 } }, 'stop') });",
        "    send({ type: 'agent_settled' });",
        '    return;',
        '  }',
        '  respond(msg);',
        '}',
      ]);
      const ctx = await ingestPiEvent(stateDir, 'Resume pi.', '1786000010.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('pi', {
        id: '0f6c3a4e-4b5e-4d7a-9a41-2c6b3f0a9d11',
        updatedAt: '2026-08-01T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, {
          CALLS_PATH: callsPath,
          STDERR_WARNING: "Warning: No project session found with id '0f6c3a4e-4b5e-4d7a-9a41-2c6b3f0a9d11'; creating a new session with that id.",
        }),
        kind: 'pi',
        model: 'deepseek/deepseek-v4-flash',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'resumed reply');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(calls.map((call) => call.type), ['get_state', 'prompt']);
      assert.deepEqual(await providerSessionStartedPayload(ctx.item.id), {
        id: '0f6c3a4e-4b5e-4d7a-9a41-2c6b3f0a9d11',
        kind: 'pi',
        resumed: true,
      });
      const state = await loadState();
      assert.equal(state.sessions.anima?.current?.id, '0f6c3a4e-4b5e-4d7a-9a41-2c6b3f0a9d11');
      assert.ok(allActivities(state).some((activity) =>
        activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'pi.session.resume_missing'));
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('pi turns a provider auth error into machine-level credential guidance', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-pi-auth-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakePi(stateDir, [
        ...FAKE_PI_PRELUDE,
        'function handle(msg) {',
        "  if (msg.type === 'get_state') return respond(msg, state());",
        "  if (msg.type === 'prompt') {",
        '    respond(msg);',
        "    send({ type: 'message_end', message: assistant('', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, 'error', '401 {\"error\":{\"message\":\"API key not valid\"}}') });",
        "    send({ type: 'agent_end', messages: [] });",
        "    send({ type: 'agent_settled' });",
        '    return;',
        '  }',
        '  respond(msg);',
        '}',
      ]);
      const ctx = await ingestPiEvent(stateDir, 'Use Gemini.', '1786000015.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'pi',
        model: 'google/gemini-2.5-pro',
      });

      await assert.rejects(
        runtime.run(await runtimeInput(runtime, ctx, await loadState())),
        (error: unknown) => {
          assert.match(String((error as Error).message), /pi could not use google\/gemini-2.5-pro/);
          assert.match(String((error as Error).message), /machine-level pi credential/);
          assert.equal((error as { reason?: string }).reason, 'provider_auth_failed');
          assert.equal((error as { status?: number }).status, 401);
          return true;
        },
      );
      assert.equal(runtime.health?.().child, undefined);
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

test('pi with no credential at all reports the placeholder model as an auth failure', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-pi-nocred-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakePi(stateDir, [
        ...FAKE_PI_PRELUDE,
        'function handle(msg) {',
        "  if (msg.type === 'get_state') return respond(msg, { ...state(), model: { id: 'unknown', provider: 'unknown', contextWindow: 0 } });",
        '  respond(msg);',
        '}',
      ]);
      const ctx = await ingestPiEvent(stateDir, 'Use Gemini.', '1786000016.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'pi',
        model: 'google/gemini-2.5-pro',
      });

      await assert.rejects(
        runtime.run(await runtimeInput(runtime, ctx, await loadState())),
        (error: unknown) => {
          assert.match(String((error as Error).message), /pi could not use google\/gemini-2.5-pro/);
          assert.equal((error as { reason?: string }).reason, 'provider_auth_failed');
          return true;
        },
      );
      assert.equal(runtime.health?.().child, undefined);
      const calls = (await readFile(callsPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string });
      assert.deepEqual(calls.map((call) => call.type), ['get_state']);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('piBashToolTimeoutMs defaults to 120s and honors ANIMA_PI_BASH_TOOL_TIMEOUT_MS', () => {
  const previous = process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
  try {
    delete process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
    assert.equal(piBashToolTimeoutMs(), 120_000);
    process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = '1500';
    assert.equal(piBashToolTimeoutMs(), 1_500);
    process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = 'nope';
    assert.equal(piBashToolTimeoutMs(), 120_000);
  } finally {
    if (previous === undefined) delete process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
    else process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = previous;
  }
});

test('pi aborts a hung bash tool after the Anima default timeout', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-pi-bash-timeout-'));
  let runtime: AgentRuntime | undefined;
  const previous = process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
  process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = '200';
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakePi(stateDir, [
        ...FAKE_PI_PRELUDE,
        'function handle(msg) {',
        "  if (msg.type === 'get_state') return respond(msg, state());",
        "  if (msg.type === 'prompt') {",
        '    respond(msg);',
        "    send({ type: 'tool_execution_start', toolCallId: 'pi-bash-hang', toolName: 'bash', args: { command: 'sleep 999' } });",
        '    // Intentionally omit tool_execution_end — reproduces DeepSeek/Pi hangs.',
        '    return;',
        '  }',
        "  if (msg.type === 'abort') {",
        '    respond(msg);',
        '    // Late error end (after Anima already recorded timeout failure) must stay idempotent.',
        '    setTimeout(() => {',
        "      send({ type: 'tool_execution_end', toolCallId: 'pi-bash-hang', toolName: 'bash', result: { content: [{ type: 'text', text: 'Command aborted' }] }, isError: true });",
        "      send({ type: 'message_end', message: assistant('', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } }, 'aborted', 'This operation was aborted') });",
        "      send({ type: 'agent_settled' });",
        '    }, 30);',
        '    return;',
        '  }',
        '  respond(msg);',
        '}',
      ]);
      const ctx = await ingestPiEvent(stateDir, 'Hang on bash.', '1786000030.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'pi',
        model: 'deepseek/deepseek-v4-flash',
      });
      const runPromise = runtime.run(await runtimeInput(runtime, ctx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"type":"abort"')).catch(() => false));
      await assert.rejects(withTimeout(runPromise, 5_000));
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(calls.map((call) => call.type), ['get_state', 'prompt', 'abort']);
      const activities = allActivities(await loadState());
      const failedForHang = activities.filter((activity) =>
        activity.type === 'tool.call.failed'
          && activity.payload?.['providerToolId'] === 'pi-bash-hang');
      assert.equal(failedForHang.length, 1, 'timeout + abort end must not duplicate tool.call.failed');
      assert.ok(String(failedForHang[0]?.payload?.['error'] ?? '').includes('timed out'));
      assert.ok(activities.some((activity) =>
        activity.type === 'runtime.event'
          && activity.payload?.['eventType'] === 'pi.tool.timeout'
          && activity.payload?.['providerToolId'] === 'pi-bash-hang'));
    });
  } finally {
    if (previous === undefined) delete process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
    else process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = previous;
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('pi bash timeout does not abort when tool_execution_end wins the same-turn race', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-pi-bash-timeout-same-turn-'));
  let runtime: AgentRuntime | undefined;
  const previousTimeout = process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
  const previousYield = process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_YIELD_MS;
  process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = '200';
  // Widen the timeout callback gap so the fake's late end is processed before abort is considered.
  process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_YIELD_MS = '80';
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakePi(stateDir, [
        ...FAKE_PI_PRELUDE,
        'function handle(msg) {',
        "  if (msg.type === 'get_state') return respond(msg, state());",
        "  if (msg.type === 'prompt') {",
        '    respond(msg);',
        "    send({ type: 'tool_execution_start', toolCallId: 'pi-bash-race', toolName: 'bash', args: { command: 'sleep 999' } });",
        '    // Complete during the timeout callback await — must cancel the pending abort.',
        '    setTimeout(() => {',
        "      send({ type: 'tool_execution_end', toolCallId: 'pi-bash-race', toolName: 'bash', result: { content: [{ type: 'text', text: 'finished just in time' }] }, isError: false });",
        "      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } });",
        "      send({ type: 'message_end', message: assistant('recovered', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, 'stop') });",
        "      send({ type: 'agent_settled' });",
        '    }, 220);',
        '    return;',
        '  }',
        "  if (msg.type === 'abort') {",
        '    respond(msg);',
        "    send({ type: 'message_end', message: assistant('', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } }, 'aborted', 'stale abort') });",
        "    send({ type: 'agent_settled' });",
        '    return;',
        '  }',
        '  respond(msg);',
        '}',
      ]);
      const ctx = await ingestPiEvent(stateDir, 'Race the timeout.', '1786000032.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'pi',
        model: 'deepseek/deepseek-v4-flash',
      });
      const result = await withTimeout(
        runtime.run(await runtimeInput(runtime, ctx, await loadState())),
        5_000,
      );
      assert.equal(result.text, 'recovered');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(
        calls.map((call) => call.type),
        ['get_state', 'prompt'],
        'late tool_execution_end on the same turn must cancel the timeout abort',
      );
      const activities = allActivities(await loadState());
      assert.equal(
        activities.filter((activity) =>
          activity.type === 'tool.call.failed'
            && activity.payload?.['providerToolId'] === 'pi-bash-race').length,
        0,
      );
      assert.ok(!activities.some((activity) =>
        activity.type === 'runtime.event'
          && activity.payload?.['eventType'] === 'pi.tool.timeout'
          && activity.payload?.['providerToolId'] === 'pi-bash-race'));
    });
  } finally {
    if (previousTimeout === undefined) delete process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
    else process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = previousTimeout;
    if (previousYield === undefined) delete process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_YIELD_MS;
    else process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_YIELD_MS = previousYield;
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('pi bash timeout does not abort a later turn after the timed-out turn settles', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-pi-bash-timeout-next-turn-'));
  let runtime: AgentRuntime | undefined;
  const previous = process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
  process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = '200';
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakePi(stateDir, [
        ...FAKE_PI_PRELUDE,
        'let prompts = 0;',
        'function handle(msg) {',
        "  if (msg.type === 'get_state') return respond(msg, state());",
        "  if (msg.type === 'prompt') {",
        '    prompts += 1;',
        '    respond(msg);',
        '    if (prompts === 1) {',
        "      send({ type: 'tool_execution_start', toolCallId: 'pi-bash-hang', toolName: 'bash', args: { command: 'sleep 999' } });",
        '      return;',
        '    }',
        "    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second turn ok' } });",
        "    send({ type: 'message_end', message: assistant('second turn ok', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, 'stop') });",
        "    send({ type: 'agent_settled' });",
        '    return;',
        '  }',
        "  if (msg.type === 'abort') {",
        '    respond(msg);',
        "    send({ type: 'tool_execution_end', toolCallId: 'pi-bash-hang', toolName: 'bash', result: { content: [{ type: 'text', text: 'Command aborted' }] }, isError: true });",
        "    send({ type: 'message_end', message: assistant('', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } }, 'aborted', 'This operation was aborted') });",
        "    send({ type: 'agent_settled' });",
        '    return;',
        '  }',
        '  respond(msg);',
        '}',
      ]);
      const hangCtx = await ingestPiEvent(stateDir, 'Hang on bash.', '1786000031.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'pi',
        model: 'deepseek/deepseek-v4-flash',
      });
      const hangPromise = runtime.run(await runtimeInput(runtime, hangCtx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"type":"abort"')).catch(() => false));
      await assert.rejects(withTimeout(hangPromise, 5_000));

      const nextCtx = await ingestPiEvent(stateDir, 'Next turn.', '1786000031.000002');
      const nextResult = await withTimeout(
        runtime.run(await runtimeInput(runtime, nextCtx, await loadState())),
        5_000,
      );
      assert.equal(nextResult.text, 'second turn ok');

      const calls = await readJsonLines(callsPath);
      assert.deepEqual(
        calls.map((call) => call.type),
        ['get_state', 'prompt', 'abort', 'prompt'],
        'timed-out turn may abort once; the next turn must not receive a stale abort',
      );
      const failedForHang = allActivities(await loadState()).filter((activity) =>
        activity.type === 'tool.call.failed'
          && activity.payload?.['providerToolId'] === 'pi-bash-hang');
      assert.equal(failedForHang.length, 1);
    });
  } finally {
    if (previous === undefined) delete process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS;
    else process.env.ANIMA_PI_BASH_TOOL_TIMEOUT_MS = previous;
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('pi sends abort before tearing down a cancelled turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-pi-cancel-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakePi(stateDir, [
        ...FAKE_PI_PRELUDE,
        'function handle(msg) {',
        "  if (msg.type === 'get_state') return respond(msg, state());",
        "  if (msg.type === 'prompt') {",
        '    respond(msg);',
        "    send({ type: 'agent_start' });",
        '    return;',
        '  }',
        "  if (msg.type === 'abort') {",
        '    respond(msg);',
        "    send({ type: 'message_end', message: assistant('', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } }, 'aborted', 'Request was aborted') });",
        "    send({ type: 'agent_settled' });",
        '    return;',
        '  }',
        '  respond(msg);',
        '}',
      ]);
      const ctx = await ingestPiEvent(stateDir, 'Long pi task.', '1786000020.000001');
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'pi',
        model: 'google/gemini-2.5-flash',
      });
      const controller = new AbortController();
      const input = await runtimeInput(runtime, ctx, await loadState());
      const runPromise = runtime.run({ ...input, signal: controller.signal });
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"type":"prompt"')).catch(() => false));
      controller.abort(new Error('user_stop'));
      await assert.rejects(withTimeout(runPromise, 5_000));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"type":"abort"')).catch(() => false));
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(calls.map((call) => call.type), ['get_state', 'prompt', 'abort']);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function installFakePi(stateDir: string, bodyLines: string[]): Promise<void> {
  const path = join(stateDir, 'pi');
  await writeFile(path, ['#!/usr/bin/env node', ...bodyLines, ''].join('\n'), 'utf8');
  await chmod(path, 0o755);
}

async function ingestPiEvent(stateDir: string, text: string, ts: string) {
  return ingestEvent(
    makeSlackEvent({ channelId: 'C-pi', teamId: 'T-demo', text, ts, userId: 'U1' }),
    { agentId: 'anima', stateDir },
  );
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
