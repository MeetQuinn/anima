import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../providers/factory.js';
import { CLAUDE_DISALLOWED_TOOLS } from '../providers/claude.js';
import { AgentRuntimeBridge } from '../runtime/runtime-bridge.js';
import type { AgentRuntime } from '../runtime/provider-contract.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import type { RuntimeItemContext } from '../runtime/types.js';
import { allActivities, loadState } from './helpers/state.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { withAnimaHome } from './anima-home.js';
import type { TestState } from './helpers/state.js';

async function runtimeInput(runtime: AgentRuntime, context: RuntimeItemContext, state?: TestState) {
  return new AgentRuntimeBridge(runtime).runInput({
    context,
    profile: { displayName: 'Anima' },
    session: state?.sessions[context.agentId],
  });
}

async function runtimeFollowupInput(
  runtime: AgentRuntime,
  activeContext: RuntimeItemContext,
  context: RuntimeItemContext,
  _state?: unknown,
) {
  return new AgentRuntimeBridge(runtime).followupInput({ activeContext, context });
}

test('codex-cli app-server transport starts a turn and appends subscription follow-up input', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'codex-app-server-calls.jsonl');
    const fakeCodex = join(stateDir, 'codex');
    await writeFile(
      fakeCodex,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "let turnCount = 0;",
        "rl.on('line', (line) => {",
        "  const msg = JSON.parse(line);",
        "  appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "  if (msg.method === 'initialize') {",
        "    send({ id: msg.id, result: { userAgent: 'fake-codex' } });",
        "    return;",
        "  }",
        "  if (msg.method === 'initialized') return;",
        "  if (msg.method === 'thread/start') {",
        "    if (msg.params.approvalPolicy !== 'never') process.exit(30);",
        "    if (msg.params.sandbox !== 'danger-full-access') process.exit(31);",
        "    if (msg.params.model !== 'gpt-test') process.exit(32);",
        "    if (msg.params.config.model_reasoning_effort !== 'xhigh') process.exit(33);",
        "    if (msg.params.config.model_reasoning_summary !== 'auto') process.exit(330);",
        "    if (!msg.params.developerInstructions.includes('You are Anima, general-purpose Anima agent.')) process.exit(34);",
        "    if (!msg.params.developerInstructions.includes('anima message send --channel')) process.exit(35);",
        "    send({ id: msg.id, result: { thread: { id: 'codex-thread-1', cwd: process.cwd(), cliVersion: 'test' } } });",
        "    return;",
        "  }",
        "  if (msg.method === 'thread/resume') process.exit(36);",
        "  if (msg.method === 'turn/start') {",
        "    turnCount += 1;",
        "    const prompt = msg.params.input[0].text;",
        "    if (prompt.includes('You are Anima, general-purpose Anima agent.')) process.exit(37);",
        "    if (!prompt.includes('New Slack message:')) process.exit(38);",
        "    if ('cwd' in msg.params || 'model' in msg.params || 'effort' in msg.params) process.exit(39);",
        "    if (turnCount === 1) {",
        "      if (prompt.includes('fresh session after rotate')) {",
        "        send({ id: msg.id, result: { turn: { id: 'turn-fresh', status: 'inProgress', items: [], itemsView: 'full', error: null, startedAt: 5, completedAt: null, durationMs: null } } });",
        "        send({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread-1', turnId: 'turn-fresh', itemId: 'item-fresh', delta: 'handled fresh' } });",
        "        send({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-fresh', status: 'completed', items: [], itemsView: 'full', error: null, startedAt: 5, completedAt: 6, durationMs: 1000 } } });",
        "        return;",
        "      }",
        "      if (!prompt.includes('first message')) process.exit(40);",
        "      send({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: null, durationMs: null } } });",
        "      process.stdout.write('not-json from codex app-server\\n' + JSON.stringify({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: \"/bin/zsh -lc \\'sed -n 1,20p server/providers/codex.ts\\'\" } } }) + '\\n');",
        "      send({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: \"/bin/zsh -lc 'sed -n 1,20p server/providers/codex.ts'\", exitCode: 0, aggregatedOutput: 'ok' } } });",
        "      send({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'cmd-anima-1', type: 'commandExecution', command: \"/bin/zsh -lc 'anima message react --channel C1 --message-ts 1.2 --name white_check_mark'\" } } });",
        "      send({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'cmd-anima-1', type: 'commandExecution', command: \"/bin/zsh -lc 'anima message react --channel C1 --message-ts 1.2 --name white_check_mark'\", exitCode: 0, aggregatedOutput: 'reaction added successfully.' } } });",
        "      send({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'cmd-2', type: 'commandExecution', command: 'pnpm missing-script' } } });",
        "      send({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'cmd-2', type: 'commandExecution', command: 'pnpm missing-script', exitCode: 1, aggregatedOutput: 'ERR_PNPM_NO_SCRIPT Missing script' } } });",
        "      send({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'web-1', type: 'webSearch', action: { type: 'search', query: 'activity log display query' } } } });",
        "      send({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'web-1', type: 'webSearch', action: { type: 'search', query: 'activity log display query' }, status: 'completed' } } });",
        "      send({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'task-parent-1', type: 'mcpToolCall', server: 'codex', tool: 'Agent' } } });",
        "      send({ method: 'item/started', params: { threadId: 'codex-child-thread', turnId: 'turn-1', item: { id: 'cmd-sub-1', type: 'commandExecution', command: 'cat package.json', parentToolCallId: 'task-parent-1', subRunId: 'codex-child-1', agent_nickname: 'Pascal', agent_role: 'explorer', depth: 1 } } });",
        "      send({ method: 'item/agentMessage/delta', params: { threadId: 'codex-child-thread', turnId: 'turn-1', itemId: 'child-text-1', delta: 'child draft', parentToolCallId: 'task-parent-1', subRunId: 'codex-child-1', agent_nickname: 'Pascal', agent_role: 'explorer', depth: 1 } });",
        "      send({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'compact-1', type: 'contextCompaction' } } });",
        "      send({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'compact-1', type: 'contextCompaction', status: 'completed' } } });",
        "      send({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] } } });",
        "      send({ method: 'item/reasoning/summaryPartAdded', params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0 } });",
        "      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0, delta: 'Inspecting runtime events.' } });",
        "      send({ method: 'item/reasoning/textDelta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'reasoning-1', contentIndex: 0, delta: 'raw reasoning for open models' } });",
        "      send({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { id: 'reasoning-1', type: 'reasoning', summary: ['Inspecting runtime events.'], content: ['raw reasoning for open models'] } } });",
        "      send({ method: 'turn/plan/updated', params: { threadId: 'codex-thread-1', turnId: 'turn-1', explanation: 'Plan changed', plan: [{ step: 'Read provider', status: 'completed' }, { step: 'Record events', status: 'inProgress' }] } });",
        "      send({ method: 'turn/diff/updated', params: { threadId: 'codex-thread-1', turnId: 'turn-1', diff: 'diff --git a/server/providers/codex.ts b/server/providers/codex.ts' } });",
        "      send({ method: 'rawResponseItem/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { type: 'reasoning', summary: [{ text: 'summary' }], content: [{ type: 'reasoning_text', text: 'do not store raw' }], encrypted_content: 'secret-ciphertext' } } });",
        "      send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'primary', limitName: 'Primary', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1770000000 }, secondary: null, planType: 'pro', rateLimitReachedType: null } } });",
        "      send({ method: 'model/rerouted', params: { threadId: 'codex-thread-1', turnId: 'turn-1', fromModel: 'gpt-test', toModel: 'gpt-fallback', reason: 'unavailable' } });",
        "      send({ method: 'warning', params: { threadId: 'codex-thread-1', message: 'non-fatal warning' } });",
        "      send({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'handled first' } });",
        "      return;",
        "    }",
        "    if (!prompt.includes('third message')) process.exit(43);",
        "    send({ id: msg.id, result: { turn: { id: 'turn-2', status: 'inProgress', items: [], itemsView: 'full', error: null, startedAt: 3, completedAt: null, durationMs: null } } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread-1', turnId: 'turn-2', itemId: 'item-2', delta: 'handled third' } });",
        "    send({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-2', status: 'completed', items: [], itemsView: 'full', error: null, startedAt: 3, completedAt: 4, durationMs: 1000 } } });",
        "    return;",
        "  }",
        "  if (msg.method === 'turn/steer') {",
        "    if (msg.params.expectedTurnId !== 'turn-1') process.exit(41);",
        "    if (!msg.params.input[0].text.includes('second message')) process.exit(42);",
        "    send({ id: msg.id, result: { turnId: 'turn-1' } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'item-1', delta: ' + appended second' } });",
        "    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'codex-thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 1111, cachedInputTokens: 222, outputTokens: 33, reasoningOutputTokens: 44, totalTokens: 1366 }, total: { inputTokens: 2111, cachedInputTokens: 333, outputTokens: 55, reasoningOutputTokens: 66, totalTokens: 2166 }, modelContextWindow: 200000 } } });",
        "    send({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed', model: 'gpt-test', usage: { inputTokens: 1111, cachedInputTokens: 222, outputTokens: 33, totalTokens: 1366 }, items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } } });",
        "  }",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeCodex, 0o755);

    const config = { agentId: 'anima', stateDir };
    const firstCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'first message',
        userId: 'U1',
      }),
      config,
    );
    const secondCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'second message',
        userId: 'U1',
      }),
      config,
    );

    runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
      kind: 'codex-cli',
      model: 'gpt-test',
      reasoningEffort: 'xhigh',
    });
    const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
    await waitFor(async () => (await readFile(callsPath, 'utf8')).includes('"method":"turn/start"'));
    assert.deepEqual(
      await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState())),
      { accepted: true, text: 'appended to turn-1' },
    );
    assert.equal((await runPromise).text, 'handled first + appended second');

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string });
    assert.ok(calls.some((call) => call.method === 'turn/steer'));
    const stateAfterRun = await loadState();
    assert.equal(stateAfterRun.sessions.anima?.current?.id, 'codex-thread-1');
    const activities = await activitiesForInboxItemWindow('anima', firstCtx.item.id);
    const started = activities.find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'cmd-1');
    const failed = activities.find((activity) => activity.type === 'tool.call.failed' && activity.payload?.['providerToolId'] === 'cmd-2');
    assert.equal(started?.payload?.['tool'], 'codex.shell');
    assert.equal(started?.payload?.['command'], 'sed -n 1,20p server/providers/codex.ts');
    assert.ok(activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'codex.protocol.invalid_json'));
    assert.equal(failed?.payload?.['tool'], 'codex.shell');
    assert.equal(failed?.payload?.['command'], 'pnpm missing-script');
    assert.match(String(failed?.payload?.['error']), /ERR_PNPM_NO_SCRIPT/);
    const webSearch = activities.find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'web-1');
    assert.equal(webSearch?.payload?.['tool'], 'codex.webSearch');
    assert.equal(webSearch?.payload?.['query'], 'activity log display query');
    assert.equal(webSearch?.payload?.['target'], 'activity log display query');
    const subagentTool = activities.find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'cmd-sub-1');
    assert.equal(subagentTool?.payload?.['parentToolCallId'], 'task-parent-1');
    assert.equal(subagentTool?.payload?.['subRunId'], 'codex-child-1');
    assert.equal(subagentTool?.payload?.['name'], 'Pascal');
    assert.equal(subagentTool?.payload?.['role'], 'explorer');
    assert.equal(subagentTool?.payload?.['depth'], 1);
    const childText = activities.find((activity) => activity.type === 'agent.text' && activity.payload?.['subRunId'] === 'codex-child-1');
    assert.equal(childText?.payload?.['text'], 'child draft');
    assert.equal(childText?.payload?.['parentToolCallId'], 'task-parent-1');
    assert.equal(
      activities.some((activity) => activity.payload?.['providerToolId'] === 'cmd-anima-1'),
      false,
    );
    const allRunActivities = allActivities(stateAfterRun);
    const compactStarted = allRunActivities.find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'codex.compact.started');
    const compactCompleted = allRunActivities.find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'codex.compact.completed');
    const stats = allRunActivities.find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'codex.session.stats');
    assert.ok(compactStarted);
    assert.ok(compactCompleted);
    assert.equal(stats?.payload?.['model'], 'gpt-test');
    assert.equal(stats?.payload?.['inputTokens'], 1111);
    assert.equal(stats?.payload?.['cacheReadInputTokens'], 222);
    assert.equal(stats?.payload?.['outputTokens'], 33);
    assert.equal(stats?.payload?.['totalTokens'], 1366);
    assert.equal(stats?.payload?.['terminalReason'], 'completed');
    for (const hiddenEventType of [
      'codex.context.stats',
      'codex.reasoning.started',
      'codex.reasoning.summary_delta',
      'provider.reasoning',
      'codex.reasoning.completed',
      'codex.plan.updated',
      'codex.diff.updated',
      'codex.raw_response_item.completed',
      'codex.item.commandExecution.outputDelta',
    ]) {
      assert.equal(
        activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === hiddenEventType),
        false,
      );
    }
    const rateLimits = activities.find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'codex.rate_limits.updated');
    assert.deepEqual(rateLimits?.payload?.['primary'], { usedPercent: 42, windowDurationMins: 300, resetsAt: 1770000000 });
    const rerouted = activities.find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'codex.model.rerouted');
    assert.equal(rerouted?.payload?.['toModel'], 'gpt-fallback');
    const warning = activities.find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'codex.warning');
    assert.equal(warning?.payload?.['message'], 'non-fatal warning');

    const thirdCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'third message',
        userId: 'U1',
      }),
      config,
    );
    assert.equal((await runtime.run(await runtimeInput(runtime, thirdCtx, await loadState()))).text, 'handled third');
    const finalCalls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string });
    assert.equal(finalCalls.filter((call) => call.method === 'initialize').length, 1);
    assert.equal(finalCalls.filter((call) => call.method === 'thread/start').length, 1);
    assert.equal(finalCalls.some((call) => call.method === 'thread/resume'), false);

    const fourthCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'fresh session after rotate',
        userId: 'U1',
      }),
      config,
    );
    await defaultAgentRegistryService.serviceFor('anima').rotateSession();
    assert.equal((await runtime.run(await runtimeInput(runtime, fourthCtx, await loadState()))).text, 'handled fresh');
    const postRotateState = await loadState();
    assert.deepEqual(await providerSessionStartedPayload(fourthCtx.item.id), { kind: 'codex-cli', resumed: false });
    assert.ok(postRotateState.sessions.anima?.archived?.some((session) => session.kind === 'codex-cli' && session.id === 'codex-thread-1'));
    const postRotateCalls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string });
    assert.equal(postRotateCalls.filter((call) => call.method === 'initialize').length, 2);
    assert.equal(postRotateCalls.filter((call) => call.method === 'thread/start').length, 2);
    assert.equal(postRotateCalls.some((call) => call.method === 'thread/resume'), false);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('codex-cli app-server transport fails when process exits before turn completion', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
    const fakeCodex = join(stateDir, 'codex');
    await writeFile(
      fakeCodex,
      [
        '#!/usr/bin/env node',
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "rl.on('line', (line) => {",
        "  const msg = JSON.parse(line);",
        "  if (msg.method === 'initialize') {",
        "    send({ id: msg.id, result: { userAgent: 'fake-codex' } });",
        "    return;",
        "  }",
        "  if (msg.method === 'initialized') return;",
        "  if (msg.method === 'thread/start') {",
        "    send({ id: msg.id, result: { thread: { id: 'codex-thread-1', cwd: process.cwd(), cliVersion: 'test' } } });",
        "    return;",
        "  }",
        "  if (msg.method === 'turn/start') {",
        "    send({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: null, durationMs: null } } });",
        "    setTimeout(() => process.exit(0), 10);",
        "  }",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeCodex, 0o755);

    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'first message',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );

    const runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir),
      kind: 'codex-cli',
    });
    await assert.rejects(
      withTimeout(runtime.run(await runtimeInput(runtime, ctx, await loadState())), 1_000),
      /exited before completing active requests/,
    );

    const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
    assert.ok(activities.some((activity) => activity.type === 'runtime.failed'));
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code runtime streams activity, persists Claude session metadata, and resumes it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  const previousClaudeProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'claude-calls.jsonl');
    const claudeProjectsDir = join(stateDir, 'claude-projects');
    const claudeSubagentCwd = '/tmp/anima-claude-subagent-cwd';
    const claudeProjectRoot = join(claudeProjectsDir, claudeSubagentCwd.replace(/\/+$/, '').replaceAll('/', '-'));
    const claudeProjectDir = join(claudeProjectRoot, 'claude-session-1', 'subagents');
    const claudeParentTranscriptLog = join(claudeProjectRoot, 'claude-session-1.jsonl');
    const claudeResultSubagentLog = join(claudeProjectDir, 'agent-claude-child-result.jsonl');
    process.env.CLAUDE_PROJECTS_DIR = claudeProjectsDir;
    await mkdir(claudeProjectDir, { recursive: true });
    await writeFile(
      join(claudeProjectDir, 'agent-claude-child-meta.meta.json'),
      `${JSON.stringify({ agentType: 'general-purpose', description: 'metadata child', toolUseId: 'toolu_parent_task' })}\n`,
      'utf8',
    );
    await writeFile(
      join(claudeProjectDir, 'agent-claude-child-meta.jsonl'),
      `${JSON.stringify({ agentId: 'claude-child-meta', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_child_meta_read', name: 'Read' }] } })}\n`,
      'utf8',
    );
    await writeFile(
      join(claudeProjectDir, 'agent-claude-child-result.meta.json'),
      `${JSON.stringify({ agentType: 'general-purpose', description: 'result child', toolUseId: 'toolu_result_task' })}\n`,
      'utf8',
    );
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const argv = process.argv.slice(2);",
        "const resumeIndex = argv.indexOf('--resume');",
        "const systemPromptFileIndex = argv.indexOf('--system-prompt-file');",
        "const systemPromptFile = systemPromptFileIndex === -1 ? '' : argv[systemPromptFileIndex + 1];",
        "const systemPrompt = systemPromptFile ? readFileSync(systemPromptFile, 'utf8') : '';",
        'if (argv.includes("-p")) process.exit(41);',
        'if (argv.includes("--append-system-prompt")) process.exit(58);',
        'if (!argv.includes("--verbose")) process.exit(42);',
        'if (!argv.includes("--include-partial-messages")) process.exit(60);',
        'if (!argv.includes("--include-hook-events")) process.exit(61);',
        `if (argv[argv.indexOf("--disallowedTools") + 1] !== ${JSON.stringify(CLAUDE_DISALLOWED_TOOLS.join(','))}) process.exit(62);`,
        'if (argv[argv.indexOf("--output-format") + 1] !== "stream-json") process.exit(43);',
        'if (argv[argv.indexOf("--permission-mode") + 1] !== "bypassPermissions") process.exit(44);',
        'if (argv[argv.indexOf("--model") + 1] !== "opus") process.exit(56);',
        'if (argv[argv.indexOf("--effort") + 1] !== "xhigh") process.exit(57);',
        'if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== "200000") process.exit(59);',
        'if (!systemPrompt.includes("You are Anima, general-purpose Anima agent.")) process.exit(53);',
        'if (!systemPrompt.includes("anima message send --channel")) process.exit(54);',
        'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", cwd: process.env.CLAUDE_SUBAGENT_CWD, claude_code_version: "test", model: "opus", permissionMode: "bypassPermissions", tools: ["Read", "Bash"], mcp_servers: ["filesystem"], agents: ["Explore"], skills: ["frontend"], plugins: ["Browser"], memory_paths: ["/tmp/MEMORY.md"] }));',
        'const rl = readline.createInterface({ input: process.stdin });',
        'let count = 0;',
        "rl.on('line', (line) => {",
        '  count += 1;',
        '  const msg = JSON.parse(line);',
        '  const prompt = msg.message.content[0].text;',
        '  appendFileSync(process.env.CALLS_PATH, JSON.stringify({ argv, count, prompt }) + "\\n");',
        '  if (!prompt.includes("What did I ask?")) process.exit(45);',
        '  if (!prompt.includes("New Slack message:")) process.exit(46);',
        '  if (prompt.includes("\\\"currentEvent\\\"")) process.exit(47);',
        '  if (prompt.includes("You are Anima, general-purpose Anima agent.")) process.exit(51);',
        '  if (prompt.includes("Reply command")) process.exit(52);',
        '  if (count === 2) {',
        '    if (prompt.includes("Recovery context:")) process.exit(49);',
        '    console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 30, cache_read_input_tokens: 300, cache_creation_input_tokens: 7 }, content: [{ type: "text", text: "checking resumed Claude context" }] }, session_id: "claude-session-1" }));',
        '    console.log(JSON.stringify({ type: "result", subtype: "success", result: "second run", session_id: "claude-session-1", duration_ms: 1200, duration_api_ms: 900, ttft_ms: 42, num_turns: 1, usage: { cache_read_input_tokens: 1234, output_tokens: 12, server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 } }, modelUsage: { "claude-opus-test": { contextWindow: 200000, maxOutputTokens: 32000, costUSD: 0.05 } }, permission_denials: [{ tool_name: "Bash" }], terminal_reason: "completed", fast_mode_state: "disabled" }));',
        '    return;',
        '  }',
        '  if (resumeIndex !== -1) process.exit(48);',
        '  if (prompt.includes("Recovery context:")) process.exit(50);',
        '  console.log(JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1", model: "claude-opus-test", usage: { input_tokens: 9, cache_read_input_tokens: 90 } } }, ttft_ms: 42, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_read_1", name: "Read", input: {}, caller: { type: "model" } } }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "checking the file first" } }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use", context_management: { applied_edits: [{ type: "clear_tool_uses_20250919" }] } }, usage: { output_tokens: 3 } }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", resetsAt: "2026-05-21T00:00:00Z", utilization: 0.26, isUsingOverage: false }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, content: [{ type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "/tmp/context.md" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_read_1", content: "file contents should stay out of agent text", is_error: false }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_anima_1", name: "Bash", input: { command: "ANIMA_HOME=/tmp/anima anima file send --channel C1 /tmp/image.png", description: "Upload file" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_anima_1", content: "uploaded successfully", is_error: false }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_parent_task", name: "Task", input: { description: "Research child" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_parent_task", agentId: "claude-child-1", attributionAgent: "researcher", slug: "child-researcher", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_child_read", name: "Read", input: { file_path: "/tmp/child.md" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_parent_task", agentId: "claude-child-1", attributionAgent: "researcher", slug: "child-researcher", message: { usage: { input_tokens: 12, cache_read_input_tokens: 220, cache_creation_input_tokens: 8 }, content: [{ type: "text", text: "child draft summary" }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", agentId: "claude-child-meta", attributionAgent: "general-purpose", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_child_meta_read", name: "Read", input: { file_path: "/tmp/child-meta.md" } }] } }));',
        '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash_1", content: "", is_error: false, tool_use_result: { stdout: "command output", stderr: "", interrupted: false, isImage: false, noOutputExpected: false } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_result_task", name: "Agent", input: { description: "Result child", prompt: "Read the child file." } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_child_result_read", name: "Read", input: { file_path: "/tmp/child-result.md" } }] }, session_id: "claude-session-1" }));',
        '  setTimeout(() => {',
        '    writeFileSync(process.env.CLAUDE_RESULT_SUBAGENT_LOG, [',
        '      JSON.stringify({ agentId: "claude-child-result", type: "user", message: { role: "user", content: "Read the child file." }, cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1" }),',
        '      JSON.stringify({ agentId: "claude-child-result", attributionAgent: "general-purpose", type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_child_result_read", name: "Read", input: { file_path: "/tmp/child-result.md" } }] }, cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1" }),',
        '      JSON.stringify({ agentId: "claude-child-result", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_child_result_read", content: "child result contents", is_error: false }] }, cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1" }),',
        '      JSON.stringify({ agentId: "claude-child-result", attributionAgent: "general-purpose", type: "assistant", message: { content: [{ type: "text", text: "child result summary" }] }, cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1" }),',
        '    ].join("\\n") + "\\n", "utf8");',
        '    writeFileSync(process.env.CLAUDE_PARENT_TRANSCRIPT_LOG, JSON.stringify({ type: "user", cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_result_task", content: "child result done", is_error: false, tool_use_result: { stdout: "child result done" } }] }, toolUseResult: { status: "completed", agentId: "claude-child-result", agentType: "general-purpose" } }) + "\\n", "utf8");',
        '    console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 12, cache_read_input_tokens: 220, cache_creation_input_tokens: 8 }, content: [{ type: "text", text: "checking via Claude" }] }, session_id: "claude-session-1" }));',
        '    console.log(JSON.stringify({ type: "system", subtype: "status", status: "compacting", session_id: "claude-session-1" }));',
        '    console.log(JSON.stringify({ type: "system", subtype: "compact_boundary", session_id: "claude-session-1" }));',
        '    console.log(JSON.stringify({ type: "result", subtype: "success", result: "first run", session_id: "claude-session-1", duration_ms: 1200, duration_api_ms: 900, ttft_ms: 42, num_turns: 1, usage: { cache_read_input_tokens: 1000, output_tokens: 10, server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 } }, modelUsage: { "claude-opus-test": { contextWindow: 200000, maxOutputTokens: 32000, costUSD: 0.05 } }, permission_denials: [{ tool_name: "Bash" }], terminal_reason: "completed", fast_mode_state: "disabled" }));',
        '  }, 20);',
        '  return;',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const config = { agentId: 'anima', stateDir };
    await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'previous context',
        userId: 'U1',
      }),
      config,
    );
    const firstCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'What did I ask?',
        userId: 'U1',
      }),
      config,
    );

    const runtime = createAgentRuntime({
      env: {
        CALLS_PATH: callsPath,
        ...runtimeTestEnv(stateDir, {
          CLAUDE_RESULT_SUBAGENT_LOG: claudeResultSubagentLog,
          CLAUDE_PARENT_TRANSCRIPT_LOG: claudeParentTranscriptLog,
          CLAUDE_SUBAGENT_CWD: claudeSubagentCwd,
        }),
      },
      kind: 'claude-code',
      model: 'opus',
      reasoningEffort: 'xhigh',
    });

    assert.equal(
      (await runtime.run(await runtimeInput(runtime, firstCtx, await loadState()))).text,
      'first run',
    );
    const stateAfterFirst = await loadState();
    assert.equal(stateAfterFirst.sessions.anima?.current?.id, 'claude-session-1');
    const firstActivities = await activitiesForInboxItemWindow('anima', firstCtx.item.id);
    assert.deepEqual(await providerSessionStartedPayload(firstCtx.item.id), { kind: 'claude-code', resumed: false });
    assert.equal(
      firstActivities.find((activity) => activity.type === 'agent.text' && !activity.payload?.['subRunId'])?.payload?.['text'],
      'checking via Claude',
    );
    const providerToolActivity = firstActivities.find((activity) => activity.payload?.['tool'] === 'claude.Read');
    assert.equal(providerToolActivity?.type, 'tool.call.started');
    assert.equal(providerToolActivity?.payload?.['target'], '/tmp/context.md');
    assert.equal(providerToolActivity?.payload?.['providerToolId'], 'toolu_read_1');
    const childToolActivity = firstActivities.find((activity) => activity.payload?.['providerToolId'] === 'toolu_child_read');
    assert.equal(childToolActivity?.type, 'tool.call.started');
    assert.equal(childToolActivity?.payload?.['parentToolCallId'], 'toolu_parent_task');
    assert.equal(childToolActivity?.payload?.['subRunId'], 'claude-child-1');
    assert.equal(childToolActivity?.payload?.['role'], 'researcher');
    assert.equal(childToolActivity?.payload?.['name'], 'child-researcher');
    assert.equal(childToolActivity?.payload?.['depth'], 1);
    const childAgentText = firstActivities.find((activity) => activity.type === 'agent.text' && activity.payload?.['subRunId'] === 'claude-child-1');
    assert.equal(childAgentText?.payload?.['text'], 'child draft summary');
    assert.equal(childAgentText?.payload?.['parentToolCallId'], 'toolu_parent_task');
    const metaChildToolActivity = firstActivities.find((activity) => activity.payload?.['providerToolId'] === 'toolu_child_meta_read');
    assert.equal(metaChildToolActivity?.type, 'tool.call.started');
    assert.equal(metaChildToolActivity?.payload?.['parentToolCallId'], 'toolu_parent_task');
    assert.equal(metaChildToolActivity?.payload?.['subRunId'], 'claude-child-meta');
    assert.equal(metaChildToolActivity?.payload?.['role'], 'general-purpose');
    assert.equal(metaChildToolActivity?.payload?.['name'], 'metadata child');
    const resultChildTools = firstActivities.filter((activity) => activity.payload?.['providerToolId'] === 'toolu_child_result_read');
    assert.equal(resultChildTools.length, 1);
    assert.equal(resultChildTools[0]?.type, 'tool.call.started');
    assert.equal(resultChildTools[0]?.payload?.['parentToolCallId'], 'toolu_result_task');
    assert.equal(resultChildTools[0]?.payload?.['subRunId'], 'claude-child-result');
    assert.equal(resultChildTools[0]?.payload?.['role'], 'general-purpose');
    assert.equal(resultChildTools[0]?.payload?.['name'], 'result child');
    const resultChildText = firstActivities.find((activity) => activity.type === 'agent.text' && activity.payload?.['subRunId'] === 'claude-child-result');
    assert.equal(resultChildText?.payload?.['text'], 'child result summary');
    assert.equal(resultChildText?.payload?.['parentToolCallId'], 'toolu_result_task');
    assert.equal(
      allActivities(stateAfterFirst).some((activity) => activity.payload?.['providerToolId'] === 'toolu_anima_1'),
      false,
    );
    assert.equal(
      allActivities(stateAfterFirst).some((activity) => JSON.stringify(activity.payload ?? {}).includes('file contents should stay out of agent text')),
      false,
    );
    assert.equal(
      firstActivities.some((activity) => activity.type === 'tool.call.failed'),
      false,
    );

    const secondCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'What did I ask?',
        userId: 'U1',
      }),
      config,
    );
    assert.equal(
      (await runtime.run(await runtimeInput(runtime, secondCtx, await loadState()))).text,
      'second run',
    );

    const stateAfterSecond = await loadState();
    const resumedProviderSession = await providerSessionStartedPayload(secondCtx.item.id);
    assert.equal(resumedProviderSession?.['id'], 'claude-session-1');
    assert.equal(resumedProviderSession?.['kind'], 'claude-code');
    assert.equal(resumedProviderSession?.['resumed'], true);
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.argv.includes('-p'), false);
    assert.equal(calls[0]?.argv.includes('--append-system-prompt'), false);
    assert.equal(calls[0]?.argv.includes('--system-prompt-file'), true);
    assert.equal(calls[0]?.argv.includes('--resume'), false);
    const compactStarted = allActivities(stateAfterSecond).find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.compact.started');
    const compactCompleted = allActivities(stateAfterSecond).find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.compact.completed');
    const stats = allActivities(stateAfterSecond).filter((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.session.stats').at(-1);
    const rateLimit = allActivities(stateAfterSecond).find((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.rate_limit');
    assert.ok(compactStarted);
    assert.ok(compactCompleted);
    for (const hiddenEventType of [
      'claude.context.stats',
      'claude.system.init',
      'claude.stream.message_start',
      'claude.stream.message_delta',
      'claude.thinking.delta',
      'provider.reasoning',
      'claude.tool_result',
    ]) {
      assert.equal(
        allActivities(stateAfterSecond).some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === hiddenEventType),
        false,
      );
    }
    assert.equal(rateLimit?.payload?.['rateLimitType'], 'seven_day');
    assert.equal(rateLimit?.payload?.['utilization'], 0.26);
    assert.equal(stats?.payload?.['model'], 'claude-opus-test');
    assert.equal(stats?.payload?.['contextWindow'], 200000);
    assert.equal(stats?.payload?.['durationMs'], 1200);
    assert.equal(stats?.payload?.['durationApiMs'], 900);
    assert.equal(stats?.payload?.['numTurns'], 1);
    assert.equal(stats?.payload?.['webSearchRequests'], 1);
    assert.equal(stats?.payload?.['webFetchRequests'], 2);
    assert.equal(stats?.payload?.['maxOutputTokens'], 32000);
    assert.equal(stats?.payload?.['permissionDenialCount'], 1);
    await runtime.close?.();
    });
  } finally {
    if (previousClaudeProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = previousClaudeProjectsDir;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code runtime retries fresh when persisted session is missing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'claude-stale-session-calls.jsonl');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const argv = process.argv.slice(2);",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.once('line', (line) => {",
        "  const prompt = JSON.parse(line).message.content[0].text;",
        "  appendFileSync(process.env.CALLS_PATH, JSON.stringify({ argv, prompt }) + '\\n');",
        "  if (argv.includes('--resume')) {",
        "    console.error('No conversation found with session ID: stale-claude-session');",
        "    process.exit(0);",
        "  }",
        "  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fresh-claude-session', cwd: process.cwd(), claude_code_version: 'test' }));",
        "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fresh reply' }] }, session_id: 'fresh-claude-session' }));",
        "  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'fresh run', session_id: 'fresh-claude-session' }));",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'recover after migration',
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
          id: 'stale-claude-session',
          kind: 'claude-code',
          updatedAt: '2026-05-19T00:00:00.000Z',
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const runtime = createAgentRuntime({
      env: {
        CALLS_PATH: callsPath,
        ...runtimeTestEnv(stateDir),
      },
      kind: 'claude-code',
    });
    assert.equal(
      (await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text,
      'fresh run',
    );

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.argv.slice(calls[0].argv.indexOf('--resume'), calls[0].argv.indexOf('--resume') + 2), ['--resume', 'stale-claude-session']);
    assert.equal(calls[1]?.argv.includes('--resume'), false);

    const state = await loadState();
    assert.equal(state.sessions.anima?.current?.id, 'fresh-claude-session');
    const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
    assert.ok(activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.session.resume_missing'));
    assert.ok(activities.some((activity) => activity.type === 'runtime.completed'));
    assert.equal(activities.some((activity) => activity.type === 'runtime.failed'), false);
    await runtime.close?.();
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code runtime retries transient provider protocol errors before tool use', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'claude-provider-retry-calls.jsonl');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin });",
        "let count = 0;",
        "rl.on('line', (line) => {",
        "  count += 1;",
        "  appendFileSync(process.env.CALLS_PATH, line + '\\n');",
        "  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-error-session', cwd: process.cwd(), claude_code_version: 'test' }));",
        "  if (count === 1) {",
        "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: The socket connection was closed unexpectedly' }] }, session_id: 'claude-error-session', error: 'socket_closed', request_id: 'req-test' }));",
        "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 503, result: 'API Error: The socket connection was closed unexpectedly', session_id: 'claude-error-session', usage: { input_tokens: 0, output_tokens: 0 }, terminal_reason: 'completed' }));",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'recovered after retry' }] }, session_id: 'claude-error-session' }));",
        "  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'recovered after retry', session_id: 'claude-error-session' }));",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const config = { agentId: 'anima', stateDir };
    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'trigger provider error',
        userId: 'U1',
      }),
      config,
    );
    const runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
      kind: 'claude-code',
    });

    assert.equal(
      (await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text,
      'recovered after retry',
    );

    const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
    assert.equal(
      activities.some((activity) => activity.type === 'agent.text' && activity.payload?.['text'] === 'API Error: The socket connection was closed unexpectedly'),
      false,
    );
    assert.ok(activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.provider.retry'));
    assert.ok(activities.some((activity) => activity.type === 'runtime.completed'));
    assert.equal(activities.some((activity) => activity.type === 'runtime.failed'), false);
    assert.equal((await readFile(callsPath, 'utf8')).trim().split('\n').length, 2);
    await runtime.close?.();
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code runtime does not retry non-transient provider protocol errors', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.once('line', () => {",
        "  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-error-session', cwd: process.cwd(), claude_code_version: 'test' }));",
        "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Invalid API key' }] }, session_id: 'claude-error-session', error: 'authentication_failed', request_id: 'req-test' }));",
        "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key', session_id: 'claude-error-session', usage: { input_tokens: 0, output_tokens: 0 }, terminal_reason: 'completed' }));",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const config = { agentId: 'anima', stateDir };
    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'trigger provider error',
        userId: 'U1',
      }),
      config,
    );
    const runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir),
      kind: 'claude-code',
    });

    await assert.rejects(
      runtime.run(await runtimeInput(runtime, ctx, await loadState())),
      /Invalid API key \(api status 401\)/,
    );

    const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
    assert.equal(activities.some((activity) => activity.type === 'agent.text'), false);
    const failed = activities.find((activity) => activity.type === 'runtime.failed');
    assert.equal(failed?.payload?.['failureSource'], 'provider');
    assert.equal(failed?.payload?.['providerReason'], 'api_status_401');
    assert.equal(failed?.payload?.['retryable'], false);
    assert.ok(activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'assistant'));
    await runtime.close?.();
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code runtime resumes after transient provider errors when tool use already started', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'claude-provider-tool-error-calls.jsonl');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin });",
        "let count = 0;",
        "rl.on('line', (line) => {",
        "  count += 1;",
        "  appendFileSync(process.env.CALLS_PATH, line + '\\n');",
        "  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-error-session', cwd: process.cwd(), claude_code_version: 'test' }));",
        "  if (count === 1) {",
        "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_side_effect', name: 'Bash', input: { command: 'touch /tmp/anima-side-effect' } }] }, session_id: 'claude-error-session' }));",
        "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 503, result: 'API Error: The socket connection was closed unexpectedly', session_id: 'claude-error-session', usage: { input_tokens: 0, output_tokens: 0 }, terminal_reason: 'completed' }));",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'continued safely after provider error' }] }, session_id: 'claude-error-session' }));",
        "  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'continued safely after provider error', session_id: 'claude-error-session' }));",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const config = { agentId: 'anima', stateDir };
    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'trigger provider error',
        userId: 'U1',
      }),
      config,
    );
    const runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
      kind: 'claude-code',
    });

    assert.equal(
      (await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text,
      'continued safely after provider error',
    );

    const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
    assert.ok(activities.some((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'toolu_side_effect'));
    assert.ok(activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.provider.resume_retry'));
    assert.ok(activities.some((activity) => activity.type === 'runtime.completed'));
    assert.equal(activities.some((activity) => activity.type === 'runtime.failed'), false);
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { message: { content: Array<{ text: string }> } });
    assert.equal(calls.length, 2);
    assert.match(calls[1]?.message.content[0]?.text ?? '', /transient API or transport error/);
    assert.doesNotMatch(calls[1]?.message.content[0]?.text ?? '', /trigger provider error/);
    await runtime.close?.();
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code stream-json input keeps stdin open for active-run follow-up', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'claude-stream-input.jsonl');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const argv = process.argv.slice(2);",
        "if (argv[argv.indexOf('--input-format') + 1] !== 'stream-json') process.exit(50);",
        "if (argv[argv.indexOf('--output-format') + 1] !== 'stream-json') process.exit(51);",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "let count = 0;",
        "send({ type: 'system', subtype: 'init', session_id: 'claude-stream-session', cwd: process.cwd(), claude_code_version: 'test' });",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  const msg = JSON.parse(line);",
        "  appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "  const text = msg.message.content[0].text;",
        "  count += 1;",
        "  if (count === 1 && !text.includes('first message')) process.exit(52);",
        "  if (count === 2) {",
        "    if (!text.includes('second message')) process.exit(53);",
        "    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'handled both messages' }] }, session_id: 'claude-stream-session' });",
        "    send({ type: 'result', subtype: 'success', result: 'stream-json done', session_id: 'claude-stream-session' });",
        "  }",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const config = { agentId: 'anima', stateDir };
    const firstCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'first message',
        userId: 'U1',
      }),
      config,
    );
    const secondCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'second message',
        userId: 'U1',
      }),
      config,
    );

    const runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
      kind: 'claude-code',
    });
    const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
    await waitFor(async () => (await readFile(callsPath, 'utf8')).includes('first message'));
    assert.deepEqual(
      await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState())),
      { accepted: true, text: 'appended to Claude stream-json stdin' },
    );
    assert.equal((await runPromise).text, 'stream-json done');

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { message: { content: Array<{ text: string }> } });
    assert.equal(calls.length, 2);
    assert.match(calls[1]?.message.content[0]?.text ?? '', /second message/);
    await runtime.close?.();
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code follow-up append waits for compact and tool gates before writing stdin', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'claude-gated-input.jsonl');
    const releasePath = join(stateDir, 'claude-gated-release');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, existsSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "let count = 0;",
        "send({ type: 'system', subtype: 'init', session_id: 'claude-gated-session', cwd: process.cwd(), claude_code_version: 'test' });",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  const msg = JSON.parse(line);",
        "  appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "  const text = msg.message.content[0].text;",
        "  count += 1;",
        "  if (count === 1) {",
        "    if (!text.includes('first message')) process.exit(52);",
        "    send({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'claude-gated-session' });",
        "    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_gate_1', name: 'Read', input: { file_path: '/tmp/gated.md' } }] }, session_id: 'claude-gated-session' });",
        "    setTimeout(() => send({ type: 'system', subtype: 'compact_boundary', session_id: 'claude-gated-session' }), 50);",
        "    const release = setInterval(() => {",
        "      if (!existsSync(process.env.RELEASE_PATH)) return;",
        "      clearInterval(release);",
        "      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_gate_1', content: 'done', is_error: false }] }, session_id: 'claude-gated-session' });",
        "    }, 10);",
        "    return;",
        "  }",
        "  if (count === 2) {",
        "    if (!text.includes('second message')) process.exit(53);",
        "    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'handled gated follow-up' }] }, session_id: 'claude-gated-session' });",
        "    send({ type: 'result', subtype: 'success', result: 'gated done', session_id: 'claude-gated-session' });",
        "  }",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const config = { agentId: 'anima', stateDir };
    const firstCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'first message',
        userId: 'U1',
      }),
      config,
    );
    const secondCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'second message',
        userId: 'U1',
      }),
      config,
    );

    runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath, RELEASE_PATH: releasePath }),
      kind: 'claude-code',
    });
    const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
    await waitFor(async () => (await readFile(callsPath, 'utf8')).includes('first message'));
    await waitFor(async () => {
      const activities = await activitiesForInboxItemWindow('anima', firstCtx.item.id);
      return activities.some((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'toolu_gate_1');
    });
    assert.deepEqual(
      await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState())),
      { accepted: true, text: 'appended to Claude stream-json stdin' },
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await readFile(callsPath, 'utf8')).trim().split('\n').length, 1);
    await writeFile(releasePath, '1', 'utf8');
    assert.equal((await withTimeout(runPromise, 2_000)).text, 'gated done');

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { message: { content: Array<{ text: string }> } });
    assert.equal(calls.length, 2);
    assert.match(calls[1]?.message.content[0]?.text ?? '', /second message/);
    await runtime.close?.();
    runtime = undefined;
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code stream-json input completes when process exits without a result event', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import readline from 'node:readline';",
        "const argv = process.argv.slice(2);",
        "if (argv[argv.indexOf('--input-format') + 1] !== 'stream-json') process.exit(50);",
        "if (argv[argv.indexOf('--output-format') + 1] !== 'stream-json') process.exit(51);",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.once('line', () => {",
        "  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'assistant fallback' }] }, session_id: 'claude-stream-session' });",
        "  process.exit(0);",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'first message',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );

    const runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir),
      kind: 'claude-code',
    });
    const result = await withTimeout(runtime.run(await runtimeInput(runtime, ctx, await loadState())), 1_000);

    assert.equal(result.text, 'assistant fallback');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code runtime records failed Bash command details', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import readline from 'node:readline';",
        'const rl = readline.createInterface({ input: process.stdin });',
        "rl.once('line', () => {",
        '  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-bash-session", cwd: process.cwd(), claude_code_version: "test" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bash_1", name: "Bash", input: { command: "pnpm missing-script", description: "Run missing script" } }] }, session_id: "claude-bash-session" }));',
        '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash_1", content: "ERR_PNPM_NO_SCRIPT Missing script: missing-script", is_error: true }] }, session_id: "claude-bash-session" }));',
        '  console.log(JSON.stringify({ type: "result", subtype: "success", result: "reported failure", session_id: "claude-bash-session" }));',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'Run the failing command.',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );

    const runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir),
      kind: 'claude-code',
    });
    const result = await runtime.run(await runtimeInput(runtime, ctx, await loadState()));

    assert.equal(result.text, 'reported failure');
    const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
    const started = activities.find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'toolu_bash_1');
    const failed = activities.find((activity) => activity.type === 'tool.call.failed' && activity.payload?.['providerToolId'] === 'toolu_bash_1');
    assert.equal(started?.payload?.['tool'], 'claude.Bash');
    assert.equal(started?.payload?.['command'], 'pnpm missing-script');
    assert.equal(started?.payload?.['target'], 'Run missing script');
    assert.equal(failed?.payload?.['tool'], 'claude.Bash');
    assert.equal(failed?.payload?.['command'], 'pnpm missing-script');
    assert.equal(failed?.payload?.['target'], 'Run missing script');
    assert.match(String(failed?.payload?.['error']), /ERR_PNPM_NO_SCRIPT/);
    await runtime.close?.();
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('kimi-cli wire transport starts a turn and appends subscription follow-up input', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'kimi-wire-calls.jsonl');
      const fakeKimi = join(stateDir, 'kimi');
      await writeFile(
        fakeKimi,
        [
          '#!/usr/bin/env node',
          "const fs = require('fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');`,
          "process.stdin.setEncoding('utf8');",
          "let buffer = '';",
          'function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }',
          'function event(type, payload = {}) { send({ jsonrpc: "2.0", method: "event", params: { type, payload } }); }',
          'process.stdin.on("data", (chunk) => {',
          '  buffer += chunk;',
          '  const lines = buffer.split(/\\r?\\n/);',
          '  buffer = lines.pop() || "";',
          '  for (const line of lines) {',
          '    if (!line.trim()) continue;',
          '    const msg = JSON.parse(line);',
          '    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + "\\n");',
          '    if (msg.method === "initialize") {',
          '      send({ jsonrpc: "2.0", id: msg.id, result: { protocol_version: "1.10", server: { name: "Kimi Code CLI", version: "1.44.0" }, slash_commands: [{ name: "init", description: "Init", aliases: [] }], capabilities: { supports_question: true }, hooks: { supported_events: ["PreToolUse", "Stop"], configured: { PreToolUse: 1 } } } });',
          '    }',
          '    if (msg.method === "prompt") {',
          '      event("TurnBegin", { user_input: "Start Kimi." });',
          '      event("StepBegin", { n: 1 });',
          '      event("ContentPart", { type: "think", think: "thinking chunk", encrypted: null });',
          '      event("StatusUpdate", { context_usage: 0.5, context_tokens: 13131, max_context_tokens: 262144, token_usage: { input_other: 100, output: 24, input_cache_read: 1024, input_cache_creation: 0 }, message_id: "chatcmpl-test", plan_mode: false });',
          '      event("ToolCall", { id: "kimi-tool-1", function: { name: "Shell", arguments: "" } });',
          '      event("ToolCallPart", { arguments_part: "{\\"command\\":\\"pw" });',
          '      event("ToolCallPart", { arguments_part: "d\\"}" });',
          '      event("ToolResult", { tool_call_id: "kimi-tool-1", return_value: { is_error: false, output: "/tmp", message: "ok" } });',
          '      event("ToolCall", { id: "kimi-tool-read", function: { name: "ReadFile", arguments: "" } });',
          '      event("ToolCallPart", { arguments_part: "{\\"path\\":\\"notes.md\\"}" });',
          '      event("ToolResult", { tool_call_id: "kimi-tool-read", return_value: { is_error: false, output: "old", message: "ok" } });',
          '      event("ToolCall", { id: "kimi-tool-2", function: { name: "StrReplaceFile", arguments: "" } });',
          '      event("ToolCallPart", { arguments_part: "{\\"path\\":\\"notes.md\\",\\"edit\\":{\\"old\\":\\"old" });',
          '      event("ToolCallPart", { arguments_part: "\\",\\"new\\":\\"new\\"}}" });',
          '      event("ToolResult", { tool_call_id: "kimi-tool-2", return_value: { is_error: false, output: "", message: "ok" } });',
          '      event("HookTriggered", { event: "PreToolUse", target: "Shell", hook_count: 1 });',
          '      event("HookResolved", { event: "PreToolUse", target: "Shell", action: "allow", reason: "", duration_ms: 12 });',
          '      event("PlanDisplay", { content: "plan text", file_path: "/tmp/plan.md" });',
          '      event("ContentPart", { type: "text", text: "handled first" });',
          '    }',
          '    if (msg.method === "steer") {',
          '      event("SteerInput", { user_input: "Steer Kimi." });',
          '      event("ContentPart", { type: "text", text: " + appended" });',
          '      event("TurnEnd");',
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
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"prompt"')));
      assert.deepEqual(
        await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState())),
        { accepted: true, text: 'appended to Kimi wire stdin' },
      );
      assert.equal((await withTimeout(runPromise, 1_000)).text, 'handled first + appended');

      const state = await loadState();
      const sessionId = state.sessions.anima?.current?.id;
      assert.ok(sessionId);
      const args = JSON.parse((await readFile(callsPath, 'utf8')).split('\n')[0] ?? '{}') as { argv: string[] };
      assert.ok(args.argv.includes('--wire'));
      assert.ok(args.argv.includes('--yolo'));
      assert.equal(args.argv[args.argv.indexOf('--model') + 1], 'kimi-code/kimi-for-coding');
      assert.equal(args.argv[args.argv.indexOf('--session') + 1], sessionId);
      assert.deepEqual(await providerSessionStartedPayload(firstCtx.item.id), { kind: 'kimi-cli', resumed: false });
      const kimiTool = allActivities(state).find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'kimi-tool-1');
      assert.equal(kimiTool?.payload?.['tool'], 'kimi.Shell');
      assert.equal(kimiTool?.payload?.['providerToolName'], 'Shell');
      assert.equal(kimiTool?.payload?.['command'], 'pwd');
      assert.equal(kimiTool?.payload?.['target'], 'pwd');
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
        'kimi.step.started',
        'kimi.thinking.delta',
        'provider.reasoning',
        'kimi.tool_result',
        'kimi.hook.resolved',
        'kimi.plan.display',
        'kimi.steer.consumed',
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!(await waitForPredicate(predicate))) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function providerSessionStartedPayload(turnId: string): Promise<Record<string, unknown> | undefined> {
  const payload = (await activitiesForInboxItemWindow('anima', turnId)).find((activity) => activity.type === 'runtime.started')
    ?.payload?.['providerSession'];
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
}

function runtimeTestEnv(binDir: string, env: Record<string, string> = {}): Record<string, string> {
  return {
    ...env,
    PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(':'),
  };
}

async function waitForPredicate(predicate: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await predicate();
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
