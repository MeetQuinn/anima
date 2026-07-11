import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { waitFor, withTimeout } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../providers/factory.js';
import {
  CODEX_AUTO_COMPACT_TOKEN_LIMIT_ENV,
  CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
  CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
  codexAppServerArgs,
  codexAutoCompactTokenLimitFor,
  codexToolEnvIncludeList,
} from '../providers/codex.js';
import type { AgentRuntime } from '../providers/contract.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { allActivities, loadState } from './helpers/state.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { withAnimaHome } from './anima-home.js';
import { runtimeInput, runtimeFollowupInput, assertFollowupPrompt, providerSessionStartedPayload, runtimeTestEnv } from './helpers/agent-runtime.js';

test('codex-cli app-server launch allows managed provider env into tool shells', () => {
  const include = codexToolEnvIncludeList({
    ANIMA_HOME: '/tmp/anima-home',
    ANIMA_SLACK_BOT_TOKEN: 'xoxb-agent',
    FEISHU_APP_SECRET: 'feishu-secret',
    SERVICE_TOKEN: 'custom-provider-token',
    SLACK_BOT_TOKEN: 'xoxb-agent',
  });

  assert.ok(include.includes('SLACK_BOT_TOKEN'));
  assert.ok(include.includes('ANIMA_SLACK_BOT_TOKEN'));
  assert.ok(include.includes('FEISHU_APP_SECRET'));
  assert.ok(include.includes('SERVICE_TOKEN'));
  assert.ok(include.includes('PATH'));
  assert.equal(include.includes('ANIMA_*'), false);
  assert.equal(include.includes('CODEX_*'), false);
  assert.equal(include.includes('CODEX_THREAD_ID'), false);

  const args = codexAppServerArgs({ SLACK_BOT_TOKEN: 'xoxb-agent' });
  assert.deepEqual(args.slice(0, 6), [
    'app-server',
    '-c',
    'shell_environment_policy.inherit=all',
    '-c',
    'shell_environment_policy.ignore_default_excludes=true',
    '-c',
  ]);
  const includeArg = args.find((arg) => arg.startsWith('shell_environment_policy.include_only='));
  assert.ok(includeArg);
  assert.match(includeArg, /SLACK_BOT_TOKEN/);
  assert.equal(args.at(-2), '--listen');
  assert.equal(args.at(-1), 'stdio://');
});

test('codex-cli auto-compact limit defaults safely and accepts an explicit provider env override', () => {
  assert.equal(codexAutoCompactTokenLimitFor(undefined), CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT);
  assert.equal(codexAutoCompactTokenLimitFor({}), CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT);
  assert.equal(
    codexAutoCompactTokenLimitFor({ [CODEX_AUTO_COMPACT_TOKEN_LIMIT_ENV]: '180000' }),
    180000,
  );
  assert.throws(
    () => codexAutoCompactTokenLimitFor({ [CODEX_AUTO_COMPACT_TOKEN_LIMIT_ENV]: '0' }),
    /must be a positive integer/,
  );
  assert.throws(
    () => codexAutoCompactTokenLimitFor({ [CODEX_AUTO_COMPACT_TOKEN_LIMIT_ENV]: 'invalid' }),
    /must be a positive integer/,
  );
});

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
        `    if (msg.params.config.model_auto_compact_token_limit !== ${CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT}) process.exit(320);`,
        `    if (msg.params.config.model_auto_compact_token_limit_scope !== '${CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE}') process.exit(321);`,
        "    if (msg.params.config.model_reasoning_effort !== 'xhigh') process.exit(33);",
        "    if (msg.params.config.model_reasoning_summary !== 'auto') process.exit(330);",
        "    if (!msg.params.developerInstructions.includes('You are Anima, general-purpose Anima agent.')) process.exit(34);",
        "    if (!msg.params.developerInstructions.includes('anima message send <target flags>')) process.exit(35);",
        "    send({ id: msg.id, result: { thread: { id: 'codex-thread-1', cwd: process.cwd(), cliVersion: 'test' } } });",
        "    return;",
        "  }",
        "  if (msg.method === 'thread/resume') {",
        "    if (msg.params.threadId !== 'codex-child-raw') process.exit(36);",
        "    send({ id: msg.id, result: { thread: { id: 'codex-child-raw', agentNickname: 'Rawson', agentRole: 'explorer' }, model: 'gpt-5.5', modelProvider: 'openai' } });",
        "    return;",
        "  }",
        "  if (msg.method === 'thread/unsubscribe') {",
        "    if (msg.params.threadId !== 'codex-child-raw') process.exit(360);",
        "    send({ id: msg.id, result: { status: 'ok' } });",
        "    return;",
        "  }",
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
        "      send({ method: 'rawResponseItem/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { type: 'function_call', namespace: 'multi_agent_v1', name: 'spawn_agent', call_id: 'call_spawn_raw', arguments: JSON.stringify({ agent_type: 'explorer', message: 'inspect a subtask' }) } } });",
        "      send({ method: 'rawResponseItem/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { type: 'function_call_output', call_id: 'call_spawn_raw', output: JSON.stringify({ agent_id: 'codex-child-raw', nickname: 'Rawson' }) } } });",
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
    await waitFor(async () =>
      (await activitiesForInboxItemWindow('anima', firstCtx.item.id))
        .some((activity) => activity.type === 'agent.text' && activity.payload?.['subRunId'] === 'codex-child-raw'),
    );

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      method?: string;
      params?: { input?: Array<{ text?: string }> };
    });
    const steerPrompt = calls.find((call) => call.method === 'turn/steer')?.params?.input?.[0]?.text;
    assert.ok(steerPrompt);
    assertFollowupPrompt(steerPrompt, 'second message');
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
    const rawSubagentParent = activities.find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'call_spawn_raw');
    assert.equal(rawSubagentParent?.payload?.['providerToolName'], 'Agent');
    assert.equal(rawSubagentParent?.payload?.['tool'], 'codex.agent');
    const rawSubagentChild = activities.find((activity) => activity.type === 'agent.text' && activity.payload?.['subRunId'] === 'codex-child-raw');
    assert.equal(rawSubagentChild?.payload?.['text'], 'Started subagent Rawson');
    assert.equal(rawSubagentChild?.payload?.['parentToolCallId'], 'call_spawn_raw');
    assert.equal(rawSubagentChild?.payload?.['name'], 'Rawson');
    assert.equal(rawSubagentChild?.payload?.['role'], 'explorer');
    assert.equal(rawSubagentChild?.payload?.['model'], 'gpt-5.5');
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
    assert.deepEqual(
      finalCalls.filter((call) => call.method === 'thread/resume').map((call) => (call as { params?: Record<string, unknown> }).params?.['threadId']),
      ['codex-child-raw'],
    );
    assert.deepEqual(
      finalCalls.filter((call) => call.method === 'thread/unsubscribe').map((call) => (call as { params?: Record<string, unknown> }).params?.['threadId']),
      ['codex-child-raw'],
    );

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
    assert.deepEqual(
      postRotateCalls.filter((call) => call.method === 'thread/resume').map((call) => (call as { params?: Record<string, unknown> }).params?.['threadId']),
      ['codex-child-raw'],
    );
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('codex-cli resets app-server when follow-up steer sees a different active turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'codex-steer-mismatch-calls.jsonl');
      const fakeCodex = join(stateDir, 'codex');
      await writeFile(
        fakeCodex,
        [
          '#!/usr/bin/env node',
          "import { appendFileSync } from 'node:fs';",
          "import readline from 'node:readline';",
          "const rl = readline.createInterface({ input: process.stdin });",
          "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
          "rl.on('line', (line) => {",
          "  const msg = JSON.parse(line);",
          "  appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
          "  if (msg.method === 'initialize') {",
          "    send({ id: msg.id, result: { userAgent: 'fake-codex' } });",
          "    return;",
          "  }",
          "  if (msg.method === 'initialized') return;",
          "  if (msg.method === 'thread/start') {",
          "    send({ id: msg.id, result: { thread: { id: 'codex-thread-mismatch', cwd: process.cwd(), cliVersion: 'test' } } });",
          "    return;",
          "  }",
          "  if (msg.method === 'turn/start') {",
          "    send({ id: msg.id, result: { turn: { id: 'turn-old', status: 'inProgress', items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: null, durationMs: null } } });",
          "    return;",
          "  }",
          "  if (msg.method === 'turn/steer') {",
          "    send({ id: msg.id, error: { code: -32600, message: 'expected active turn id `turn-old` but found `turn-new`' } });",
          "  }",
          "});",
        ].join('\n'),
        'utf8',
      );
      await chmod(fakeCodex, 0o755);

      const firstCtx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-codex-mismatch',
          teamId: 'T-demo',
          text: 'first message',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      const secondCtx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-codex-mismatch',
          teamId: 'T-demo',
          text: 'second message',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );

      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath }),
        kind: 'codex-cli',
      });
      const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
      await waitFor(async () => (await readFile(callsPath, 'utf8')).includes('"method":"turn/start"'));
      await assert.rejects(
        runtime.appendToActiveRun(await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState())),
        /expected active turn id `turn-old` but found `turn-new`/,
      );
      await assert.rejects(withTimeout(runPromise, 1_000), /Codex app-server runtime terminated by SIGTERM/);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('codex-cli records subagent delegation from session response items when app-server omits them', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const codexHome = join(stateDir, 'codex-home');
      const sessionDir = join(codexHome, 'sessions', '2026', '06', '03');
      const releaseTurnFile = join(stateDir, 'release-turn');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'rollout-2026-06-03T07-13-00-codex-parent-session.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-06-03T07:12:59.815Z',
            type: 'turn_context',
            payload: { model: 'gpt-5.5', turn_id: 'turn-session-file' },
          }),
          JSON.stringify({
            timestamp: '2026-06-03T07:13:05.000Z',
            type: 'event_msg',
            payload: {
              action: { type: 'open_page', url: 'https://docs.slack.dev/reference/methods/search.query/' },
              call_id: 'ws_from_session',
              query: 'https://docs.slack.dev/reference/methods/search.query/',
              type: 'web_search_end',
            },
          }),
          JSON.stringify({
            timestamp: '2026-06-03T07:13:19.582Z',
            type: 'response_item',
            payload: {
              arguments: JSON.stringify({ agent_type: 'explorer', message: 'inspect a delegated task' }),
              call_id: 'call_from_session',
              name: 'spawn_agent',
              namespace: 'multi_agent_v1',
              type: 'function_call',
            },
          }),
          JSON.stringify({
            timestamp: '2026-06-03T07:13:19.695Z',
            type: 'response_item',
            payload: {
              call_id: 'call_from_session',
              output: JSON.stringify({ agent_id: 'codex-child-from-session', nickname: 'Gauss' }),
              type: 'function_call_output',
            },
          }),
          JSON.stringify({
            timestamp: '2026-06-03T07:13:48.070Z',
            type: 'event_msg',
            payload: { completed_at: 1780470828, turn_id: 'turn-session-file', type: 'task_complete' },
          }),
          '',
        ].join('\n'),
        'utf8',
      );

      const fakeCodex = join(stateDir, 'codex');
      await writeFile(
        fakeCodex,
        [
          '#!/usr/bin/env node',
          "import { existsSync } from 'node:fs';",
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
          "    send({ id: msg.id, result: { thread: { id: 'codex-parent-session', cwd: process.cwd(), cliVersion: 'test' } } });",
          "    return;",
          "  }",
          "  if (msg.method === 'thread/resume') {",
          "    if (msg.params.threadId !== 'codex-child-from-session') process.exit(44);",
          "    send({ id: msg.id, result: { thread: { id: 'codex-child-from-session', agentNickname: 'Gauss', agentRole: 'explorer' }, model: 'gpt-5.5' } });",
          "    return;",
          "  }",
          "  if (msg.method === 'thread/unsubscribe') {",
          "    send({ id: msg.id, result: { status: 'ok' } });",
          "    return;",
          "  }",
          "  if (msg.method === 'turn/start') {",
          "    send({ id: msg.id, result: { turn: { id: 'turn-session-file', status: 'inProgress', items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: null, durationMs: null } } });",
          "    send({ method: 'item/started', params: { threadId: 'codex-parent-session', turnId: 'turn-session-file', item: { id: 'ws_from_session', type: 'webSearch' } } });",
          "    send({ method: 'item/completed', params: { threadId: 'codex-parent-session', turnId: 'turn-session-file', item: { id: 'ws_from_session', type: 'webSearch', status: 'completed' } } });",
          "    const finish = () => {",
          "      send({ method: 'item/agentMessage/delta', params: { threadId: 'codex-parent-session', turnId: 'turn-session-file', itemId: 'item-parent', delta: 'parent handled' } });",
          "      send({ method: 'turn/completed', params: { threadId: 'codex-parent-session', turn: { id: 'turn-session-file', status: 'completed', model: 'gpt-5.5', items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } } });",
          "    };",
          "    const wait = () => {",
          "      if (!process.env.RELEASE_TURN_FILE || existsSync(process.env.RELEASE_TURN_FILE)) { finish(); return; }",
          "      setTimeout(wait, 10);",
          "    };",
          "    wait();",
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
          text: 'spawn session-file subagent',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      runtime = createAgentRuntime({
        env: runtimeTestEnv(stateDir, { CODEX_HOME: codexHome, RELEASE_TURN_FILE: releaseTurnFile }),
        kind: 'codex-cli',
        model: 'gpt-test',
        reasoningEffort: 'xhigh',
      });

      const runPromise = runtime.run(await runtimeInput(runtime, ctx, await loadState()));
      await waitFor(async () => {
        const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
        return activities.some((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'ws_from_session' && activity.payload?.['target'] === 'https://docs.slack.dev/reference/methods/search.query/');
      });
      await writeFile(releaseTurnFile, 'done', 'utf8');
      assert.equal((await runPromise).text, 'parent handled');
      await waitFor(async () =>
        {
          const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
          return activities.some((activity) => activity.type === 'agent.text' && activity.payload?.['subRunId'] === 'codex-child-from-session') &&
            activities.some((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'ws_from_session' && activity.payload?.['target'] === 'https://docs.slack.dev/reference/methods/search.query/');
        },
      );
      const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
      const webSearches = activities.filter((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'ws_from_session');
      assert.equal(webSearches.length, 2);
      assert.ok(webSearches.some((activity) => activity.payload?.['target'] === 'https://docs.slack.dev/reference/methods/search.query/'));
      assert.ok(webSearches.some((activity) => activity.payload?.['query'] === 'https://docs.slack.dev/reference/methods/search.query/'));
      const parent = activities.find((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'call_from_session');
      assert.equal(parent?.payload?.['providerToolName'], 'Agent');
      assert.equal(parent?.payload?.['tool'], 'codex.agent');
      const child = activities.find((activity) => activity.type === 'agent.text' && activity.payload?.['subRunId'] === 'codex-child-from-session');
      assert.equal(child?.payload?.['text'], 'Started subagent Gauss');
      assert.equal(child?.payload?.['parentToolCallId'], 'call_from_session');
      assert.equal(child?.payload?.['name'], 'Gauss');
      assert.equal(child?.payload?.['role'], 'explorer');
      assert.equal(child?.payload?.['model'], 'gpt-5.5');
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
