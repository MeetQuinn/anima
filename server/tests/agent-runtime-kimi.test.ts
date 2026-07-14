import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { sleep, waitFor, withTimeout } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../providers/factory.js';
import type { AgentRuntime } from '../providers/contract.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { allActivities, loadState } from './helpers/state.js';
import { withAnimaHome } from './anima-home.js';
import { runtimeInput, runtimeFollowupInput, assertFollowupPrompt, providerSessionStartedPayload, runtimeTestEnv } from './helpers/agent-runtime.js';

test('kimi-cli ACP transport starts a turn and appends subscription follow-up input', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'kimi-acp-calls.jsonl');
      const fakeKimi = join(stateDir, 'kimi');
      await writeFile(
        fakeKimi,
        [
          '#!/usr/bin/env node',
          "const fs = require('fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');`,
          "process.stdin.setEncoding('utf8');",
          "let buffer = '';",
          "let promptCount = 0;",
          'function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }',
          'function update(update) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "kimi-session-1", update } }); }',
          'function content(text) { return [{ type: "content", content: { type: "text", text } }]; }',
          'process.stdin.on("data", (chunk) => {',
          '  buffer += chunk;',
          '  const lines = buffer.split(/\\r?\\n/);',
          '  buffer = lines.pop() || "";',
          '  for (const line of lines) {',
          '    if (!line.trim()) continue;',
          '    const msg = JSON.parse(line);',
          '    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + "\\n");',
          '    if (msg.method === "initialize") {',
          '      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, serverInfo: { name: "Kimi Code CLI", version: "0.9.0" }, agentCapabilities: { loadSession: true } } });',
          '    }',
          '    if (msg.method === "session/new") {',
          '      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "kimi-session-1" } });',
          '    }',
          '    if (msg.method === "session/set_model") {',
          '      if (msg.params.modelId !== "kimi-code/kimi-for-coding") process.exit(42);',
          '      send({ jsonrpc: "2.0", id: msg.id, result: {} });',
          '    }',
          '    if (msg.method === "session/prompt") {',
          '      promptCount += 1;',
          '      if (msg.params.sessionId !== "kimi-session-1") process.exit(43);',
          '      if (promptCount === 1) {',
          '        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking chunk" } });',
          '        update({ sessionUpdate: "usage_update", usage: { inputTokens: 100, outputTokens: 24, cachedReadTokens: 1024, contextTokens: 13131, contextWindow: 262144 } });',
          '        update({ sessionUpdate: "tool_call", toolCallId: "kimi-tool-1", title: "Run command: pwd", kind: "execute" });',
          '        update({ sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-1", status: "in_progress", content: content("{\\"command\\":\\"pw") });',
          '        update({ sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-1", status: "completed", content: content("{\\"command\\":\\"pwd\\"}") });',
          '        update({ sessionUpdate: "tool_call", toolCallId: "kimi-tool-real-shell", title: "Bash", kind: "execute", status: "pending", content: content("") });',
          '        update({ sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-real-shell", status: "in_progress", content: content("{\\"command\\": \\"pw") });',
          '        update({ sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-real-shell", title: "Running: pwd", kind: "execute", status: "in_progress", rawInput: { command: "pwd" }, content: content("{\\"command\\":\\"pwd\\"}") });',
          '        update({ sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-real-shell", status: "completed", rawOutput: "/tmp\\n", content: content("/tmp\\n") });',
          '        update({ sessionUpdate: "tool_call", toolCallId: "kimi-tool-read", title: "Read file: notes.md", kind: "read", rawInput: { path: "notes.md" } });',
          '        update({ sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-read", status: "completed", rawOutput: "old" });',
          '        update({ sessionUpdate: "tool_call", toolCallId: "kimi-tool-2", title: "Patch: notes.md", kind: "edit" });',
          '        update({ sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-2", status: "completed", content: content("{\\"path\\":\\"notes.md\\",\\"edit\\":{\\"old\\":\\"old\\",\\"new\\":\\"new\\"}}") });',
          '        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "handled first" } });',
          '        setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 24, cachedReadTokens: 1024 } } }), 50);',
          '      } else {',
          '        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " + appended" } });',
          '        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } });',
          '      }',
          '    }',
          '  }',
          '});',
        ].join('\n'),
        'utf8',
      );
      await chmod(fakeKimi, 0o755);

      const firstCtx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-kimi',
          teamId: 'T-demo',
          text: 'Start Kimi.',
          ts: '1770000600.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      const secondCtx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-kimi',
          teamId: 'T-demo',
          text: 'Steer Kimi.',
          ts: '1770000600.000002',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );

      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'kimi-cli',
        model: 'kimi-code/kimi-for-coding',
      });
      const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      assert.deepEqual(
        await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState())),
        { accepted: true, text: 'queued for Kimi ACP session' },
      );
      assert.equal((await withTimeout(runPromise, 1_000)).text, 'handled first + appended');
      assert.equal(runtime.health?.().child?.version, '0.9.0');

      const state = await loadState();
      const sessionId = state.sessions.anima?.current?.id;
      assert.equal(sessionId, 'kimi-session-1');
      const args = JSON.parse((await readFile(callsPath, 'utf8')).split('\n')[0] ?? '{}') as { argv: string[] };
      assert.deepEqual(args.argv, ['--yolo', 'acp']);
      const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: Array<{ text?: string }> } });
      const sessionPrompts = calls.filter((call) => call.method === 'session/prompt');
      assert.equal(sessionPrompts.length, 2);
      const firstPrompt = sessionPrompts[0]?.params?.prompt?.[0]?.text ?? '';
      assert.ok(firstPrompt.includes('You are Anima'));
      assertFollowupPrompt(sessionPrompts[1]?.params?.prompt?.[0]?.text ?? '', 'Steer Kimi.');
      assert.deepEqual(await providerSessionStartedPayload(firstCtx.item.id), { kind: 'kimi-cli', resumed: false });
      const kimiTool = allActivities(state).find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'kimi-tool-1');
      assert.equal(kimiTool?.payload?.['tool'], 'kimi.Shell');
      assert.equal(kimiTool?.payload?.['providerToolName'], 'Shell');
      assert.equal(kimiTool?.payload?.['command'], 'pwd');
      assert.equal(kimiTool?.payload?.['target'], 'pwd');
      const kimiRealShell = allActivities(state).find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'kimi-tool-real-shell');
      assert.equal(kimiRealShell?.payload?.['tool'], 'kimi.Shell');
      assert.equal(kimiRealShell?.payload?.['command'], 'pwd');
      assert.equal(kimiRealShell?.payload?.['target'], 'pwd');
      const kimiEdit = allActivities(state).find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'kimi-tool-2');
      assert.equal(kimiEdit?.payload?.['tool'], 'kimi.StrReplaceFile');
      assert.equal(kimiEdit?.payload?.['target'], 'notes.md');
      assert.equal(kimiEdit?.payload?.['diff'], '--- old\nold\n+++ new\nnew');
      const kimiRead = allActivities(state).find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'kimi-tool-read');
      assert.equal(kimiRead?.payload?.['tool'], 'kimi.ReadFile');
      assert.equal(kimiRead?.payload?.['target'], 'notes.md');
      const activities = allActivities(state);
      assert.ok(activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'kimi.context.stats' && activity.payload?.['currentContextTokens'] === 13131 && activity.payload?.['contextWindow'] === 262144));
      for (const hiddenEventType of [
        'kimi.system.init',
        'kimi.turn.started',
        'kimi.thinking.delta',
        'provider.reasoning',
        'kimi.tool_result',
        'kimi.turn.completed',
      ]) {
        assert.equal(
          activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === hiddenEventType),
          false,
        );
      }
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('kimi-cli ACP permission requests select the Kimi-provided allow option', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'kimi-acp-permission-calls.jsonl');
      const permissionResultPath = join(stateDir, 'kimi-acp-permission-result.json');
      const fakeKimi = join(stateDir, 'kimi');
      await writeFile(
        fakeKimi,
        [
          '#!/usr/bin/env node',
          "const fs = require('fs');",
          "process.stdin.setEncoding('utf8');",
          "let buffer = '';",
          "let promptRequestId = null;",
          'function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }',
          'function update(update) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "kimi-session-permission", update } }); }',
          'process.stdin.on("data", (chunk) => {',
          '  buffer += chunk;',
          '  const lines = buffer.split(/\\r?\\n/);',
          '  buffer = lines.pop() || "";',
          '  for (const line of lines) {',
          '    if (!line.trim()) continue;',
          '    const msg = JSON.parse(line);',
          '    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + "\\n");',
          '    if (msg.id === "permission-1" && msg.result) {',
          '      fs.writeFileSync(process.env.PERMISSION_RESULT_PATH, JSON.stringify(msg.result));',
          '      if (msg.result.outcome?.outcome !== "selected") process.exit(45);',
          '      if (msg.result.outcome?.optionId !== "allow_always_option") process.exit(46);',
          '      update({ sessionUpdate: "tool_call", toolCallId: "kimi-tool-approved", title: "Bash", kind: "execute", rawInput: { command: "pwd" } });',
          '      update({ sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-approved", status: "completed", rawOutput: "/tmp\\n" });',
          '      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission approved" } });',
          '      send({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } });',
          '      return;',
          '    }',
          '    if (msg.method === "initialize") {',
          '      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, serverInfo: { name: "Kimi Code CLI", version: "0.11.0" }, agentCapabilities: { loadSession: true } } });',
          '      return;',
          '    }',
          '    if (msg.method === "session/new") {',
          '      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "kimi-session-permission" } });',
          '      return;',
          '    }',
          '    if (msg.method === "session/prompt") {',
          '      promptRequestId = msg.id;',
          '      send({',
          '        jsonrpc: "2.0",',
          '        id: "permission-1",',
          '        method: "session/request_permission",',
          '        params: {',
          '          sessionId: "kimi-session-permission",',
          '          options: [',
          '            { optionId: "reject_once_option", kind: "reject_once", name: "Reject once" },',
          '            { optionId: "allow_once_option", kind: "allow_once", name: "Allow once" },',
          '            { optionId: "allow_always_option", kind: "allow_always", name: "Allow always" }',
          '          ]',
          '        }',
          '      });',
          '      return;',
          '    }',
          '  }',
          '});',
        ].join('\n'),
        'utf8',
      );
      await chmod(fakeKimi, 0o755);

      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-kimi-permission',
          teamId: 'T-demo',
          text: 'Run a Kimi shell command.',
          ts: '1770000650.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );

      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath, PERMISSION_RESULT_PATH: permissionResultPath }),
        kind: 'kimi-cli',
      });
      const result = await runtime.run(await runtimeInput(runtime, ctx, await loadState()));
      assert.equal(result.text, 'permission approved');
      const permissionResult = JSON.parse(await readFile(permissionResultPath, 'utf8')) as {
        outcome?: { optionId?: string; outcome?: string };
      };
      assert.deepEqual(permissionResult.outcome, {
        optionId: 'allow_always_option',
        outcome: 'selected',
      });
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('kimi-cli ACP falls back to a new session when resume session is missing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'kimi-acp-resume-missing-calls.jsonl');
      const fakeKimi = join(stateDir, 'kimi');
      await writeFile(
        fakeKimi,
        [
          '#!/usr/bin/env node',
          "const fs = require('fs');",
          "process.stdin.setEncoding('utf8');",
          "let buffer = '';",
          'function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }',
          'function update(update) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "kimi-session-fresh", update } }); }',
          'process.stdin.on("data", (chunk) => {',
          '  buffer += chunk;',
          '  const lines = buffer.split(/\\r?\\n/);',
          '  buffer = lines.pop() || "";',
          '  for (const line of lines) {',
          '    if (!line.trim()) continue;',
          '    const msg = JSON.parse(line);',
          '    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + "\\n");',
          '    if (msg.method === "initialize") {',
          '      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, serverInfo: { name: "Kimi Code CLI", version: "0.12.0" }, agentCapabilities: { loadSession: true } } });',
          '      return;',
          '    }',
          '    if (msg.method === "session/resume") {',
          '      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params: Unknown sessionId: kimi-session-stale", data: { sessionId: msg.params.sessionId } } });',
          '      return;',
          '    }',
          '    if (msg.method === "session/new") {',
          '      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "kimi-session-fresh" } });',
          '      return;',
          '    }',
          '    if (msg.method === "session/set_model") {',
          '      if (msg.params.sessionId !== "kimi-session-fresh") process.exit(43);',
          '      send({ jsonrpc: "2.0", id: msg.id, result: {} });',
          '      return;',
          '    }',
          '    if (msg.method === "session/prompt") {',
          '      if (msg.params.sessionId !== "kimi-session-fresh") process.exit(44);',
          '      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fresh session reply" } });',
          '      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });',
          '      return;',
          '    }',
          '  }',
          '});',
        ].join('\n'),
        'utf8',
      );
      await chmod(fakeKimi, 0o755);

      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-kimi-resume-missing',
          teamId: 'T-demo',
          text: 'Start Kimi from a stale session.',
          ts: '1770000660.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      const sessionPath = join(stateDir, 'agents/anima/sessions.json');
      const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
      await writeFile(
        sessionPath,
        `${JSON.stringify({
          ...session,
          current: {
            id: 'kimi-session-stale',
            kind: 'kimi-cli',
            updatedAt: '2026-06-10T04:00:00.000Z',
          },
        }, null, 2)}\n`,
        'utf8',
      );

      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'kimi-cli',
        model: 'kimi-code/kimi-for-coding',
      });
      const result = await runtime.run(await runtimeInput(runtime, ctx, await loadState()));
      assert.equal(result.text, 'fresh session reply');

      const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
      assert.deepEqual(
        calls.filter((call) => call.method?.startsWith('session/')).map((call) => call.method),
        ['session/resume', 'session/new', 'session/set_model', 'session/prompt'],
      );
      const state = await loadState();
      assert.equal(state.sessions.anima?.current?.id, 'kimi-session-fresh');
      assert.ok(allActivities(state).some((activity) =>
        activity.type === 'runtime.event'
        && activity.payload?.['eventType'] === 'kimi.session.resume_missing'
        && (activity.payload?.['providerSession'] as { id?: string } | undefined)?.id === 'kimi-session-stale'
      ));
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('kimi-cli closed stdin startup failure stays on provider promise', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const fakeKimi = join(stateDir, 'kimi');
      await writeFile(
        fakeKimi,
        [
          '#!/usr/bin/env node',
          "process.stdin.setEncoding('utf8');",
          "let buffer = '';",
          'process.stdin.on("data", (chunk) => {',
          '  buffer += chunk;',
          '  const lines = buffer.split(/\\r?\\n/);',
          '  buffer = lines.pop() || "";',
          '  for (const line of lines) {',
          '    if (!line.trim()) continue;',
          '    const msg = JSON.parse(line);',
          '    if (msg.method === "initialize") {',
          '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocol_version: "1.10", server: { name: "Kimi Code CLI", version: "1.44.0" }, capabilities: {} } }) + "\\n");',
          '      process.exit(0);',
          '    }',
          '  }',
          '});',
        ].join('\n'),
        'utf8',
      );
      await chmod(fakeKimi, 0o755);

      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-kimi-closed',
          teamId: 'T-demo',
          text: 'Start Kimi.',
          ts: '1770000700.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );

      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir),
        kind: 'kimi-cli',
      });
      await assert.rejects(
        runtime.run(await runtimeInput(runtime, ctx, await loadState())),
        /Kimi ACP runtime (exited|stdin is closed)/,
      );
      // yield to pending microtasks/IO.
      await sleep(0);
      assert.deepEqual(unhandledRejections, []);
    });
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});
