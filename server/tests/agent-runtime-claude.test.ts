import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { sleep, waitFor, withTimeout } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../providers/factory.js';
import { CLAUDE_DISALLOWED_TOOLS } from '../providers/claude-launch.js';
import type { AgentRuntime } from '../providers/contract.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent, makeReminderInboxItem } from './helpers/inbox.js';
import { allActivities, loadState } from './helpers/state.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { withAnimaHome } from './anima-home.js';
import { runtimeInput, runtimeFollowupInput, seedReminder, assertFollowupPrompt, providerSessionStartedPayload, runtimeTestEnv, countTmuxCalls } from './helpers/agent-runtime.js';

test('claude-code runtime streams activity, persists Claude session metadata, and resumes it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  const previousClaudeProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
  let runtime: AgentRuntime | undefined;
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
        'if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== "272000") process.exit(59);',
        'if (!systemPrompt.includes("You are Anima, general-purpose Anima agent.")) process.exit(53);',
        'if (!systemPrompt.includes("anima message send <target flags>")) process.exit(54);',
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
        '  console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_skill_1", name: "Skill", input: { skill: "deep-research", args: "research usage telemetry and summarize with citations" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_anima_1", name: "Bash", input: { command: "ANIMA_HOME=/tmp/anima anima file send --channel C1 /tmp/image.png", description: "Upload file" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_anima_1", content: "uploaded successfully", is_error: false }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_parent_task", name: "Task", input: { description: "Research child" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_parent_task", agentId: "claude-child-1", attributionAgent: "researcher", slug: "child-researcher", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_child_read", name: "Read", input: { file_path: "/tmp/child.md" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_parent_task", agentId: "claude-child-1", attributionAgent: "researcher", slug: "child-researcher", message: { usage: { input_tokens: 12, cache_read_input_tokens: 220, cache_creation_input_tokens: 8 }, content: [{ type: "text", text: "child draft summary" }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", agentId: "claude-child-meta", attributionAgent: "general-purpose", message: { usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 6 }, content: [{ type: "tool_use", id: "toolu_child_meta_read", name: "Read", input: { file_path: "/tmp/child-meta.md" } }] } }));',
        '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash_1", content: "", is_error: false, tool_use_result: { stdout: "command output", stderr: "", interrupted: false, isImage: false, noOutputExpected: false } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_result_task", name: "Agent", input: { description: "Result child", prompt: "Read the child file." } }] }, session_id: "claude-session-1" }));',
        '  writeFileSync(process.env.CLAUDE_RESULT_SUBAGENT_LOG, [',
        '    JSON.stringify({ agentId: "claude-child-result", type: "user", message: { role: "user", content: "Read the child file." }, cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1" }),',
        '    JSON.stringify({ agentId: "claude-child-result", attributionAgent: "general-purpose", type: "assistant", message: { model: "claude-haiku-4-5-test", content: [{ type: "tool_use", id: "toolu_child_result_read", name: "Read", input: { file_path: "/tmp/child-result.md" } }] }, cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1" }),',
        '    JSON.stringify({ agentId: "claude-child-result", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_child_result_read", content: "child result contents", is_error: false }] }, cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1" }),',
        '    JSON.stringify({ agentId: "claude-child-result", attributionAgent: "general-purpose", type: "assistant", message: { content: [{ type: "text", text: "child result summary" }] }, cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1" }),',
        '  ].join("\\n") + "\\n", "utf8");',
        '  writeFileSync(process.env.CLAUDE_PARENT_TRANSCRIPT_LOG, JSON.stringify({ type: "user", cwd: process.env.CLAUDE_SUBAGENT_CWD, sessionId: "claude-session-1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_result_task", content: "child result done", is_error: false, tool_use_result: { stdout: "child result done" } }] }, toolUseResult: { status: "completed", agentId: "claude-child-result", agentType: "general-purpose" } }) + "\\n", "utf8");',
        '  console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 12, cache_read_input_tokens: 220, cache_creation_input_tokens: 8 }, content: [{ type: "text", text: "checking via Claude" }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "system", subtype: "status", status: "compacting", session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "system", subtype: "compact_boundary", session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "result", subtype: "success", result: "first run", session_id: "claude-session-1", duration_ms: 1200, duration_api_ms: 900, ttft_ms: 42, num_turns: 1, usage: { cache_read_input_tokens: 1000, output_tokens: 10, server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 } }, modelUsage: { "claude-opus-test": { contextWindow: 200000, maxOutputTokens: 32000, costUSD: 0.05 } }, permission_denials: [{ tool_name: "Bash" }], terminal_reason: "completed", fast_mode_state: "disabled" }));',
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

    runtime = createAgentRuntime({
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
    const skillToolActivity = firstActivities.find((activity) => activity.payload?.['providerToolId'] === 'toolu_skill_1');
    assert.equal(skillToolActivity?.type, 'tool.call.started');
    assert.equal(skillToolActivity?.payload?.['providerToolName'], 'Skill');
    assert.equal(skillToolActivity?.payload?.['skill'], 'deep-research');
    assert.equal(skillToolActivity?.payload?.['args'], 'research usage telemetry and summarize with citations');
    assert.equal(skillToolActivity?.payload?.['target'], 'deep-research');
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
    // Subagent model is read from the transcript assistant line and stamped onto
    // every child activity so the dashboard can show what the parent delegated to.
    assert.equal(resultChildTools[0]?.payload?.['model'], 'claude-haiku-4-5-test');
    const resultChildText = firstActivities.find((activity) => activity.type === 'agent.text' && activity.payload?.['subRunId'] === 'claude-child-result');
    assert.equal(resultChildText?.payload?.['text'], 'child result summary');
    assert.equal(resultChildText?.payload?.['model'], 'claude-haiku-4-5-test');
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
    runtime = undefined;
    });
  } finally {
    await runtime?.close?.();
    if (previousClaudeProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = previousClaudeProjectsDir;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code tmux transport reuses a session and accepts steering follow-ups', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'tmux-calls.jsonl');
    const tmuxStatePath = join(stateDir, 'tmux-state.json');
    const fakeTmux = join(stateDir, 'tmux');
    await writeFile(
      fakeTmux,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "const callsPath = process.env.TMUX_CALLS_PATH;",
        "const statePath = process.env.TMUX_STATE_PATH;",
        "if (!callsPath || !statePath) process.exit(90);",
        "const args = process.argv.slice(2);",
        "appendFileSync(callsPath, JSON.stringify({ args }) + '\\n');",
        "const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { buffers: {}, prompts: [], sends: 0, sessions: {} };",
        "const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));",
        "const valueAfter = (flag) => args[args.indexOf(flag) + 1];",
        "const state = load();",
        "if (args[0] === '-V') { console.log('tmux 3.4-test'); process.exit(0); }",
        "if (args[0] === 'has-session') process.exit(state.sessions[valueAfter('-t')] ? 0 : 1);",
        "if (args[0] === 'new-session') {",
        "  const session = valueAfter('-s');",
        "  const command = args.at(-1);",
        "  state.sessions[session] = { command, capture: 'bypass permissions on' };",
        "  const match = command.match(/'--mcp-config'\\s+'([^']+)'/);",
        "  if (!match) process.exit(91);",
        "  const systemPromptMatch = command.match(/'--system-prompt-file'\\s+'([^']+)'/);",
        "  if (!systemPromptMatch) process.exit(93);",
        "  state.mcpConfig = match[1];",
        "  state.systemPromptFile = systemPromptMatch[1];",
        "  state.systemPrompt = readFileSync(systemPromptMatch[1], 'utf8');",
        "  save(state);",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'pipe-pane') { save(state); process.exit(0); }",
        "if (args[0] === 'capture-pane') { console.log(state.sessions[valueAfter('-t')]?.capture || 'bypass permissions on'); process.exit(0); }",
        "if (args[0] === 'load-buffer') { state.buffers[valueAfter('-b')] = args.at(-1); save(state); process.exit(0); }",
        "if (args[0] === 'paste-buffer') {",
        "  const buffer = valueAfter('-b');",
        "  const prompt = readFileSync(state.buffers[buffer], 'utf8');",
        "  state.prompts.push(prompt);",
        "  save(state);",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'delete-buffer') { delete state.buffers[valueAfter('-b')]; save(state); process.exit(0); }",
        "if (args[0] === 'send-keys') {",
        "  if (args.includes('C-m')) {",
        "    state.sends += 1;",
        "    const session = valueAfter('-t');",
        "    const command = state.sessions[session]?.command || '';",
        "    const mcpMatch = command.match(/'--mcp-config'\\s+'([^']+)'/);",
        "    if (state.sends >= 2 && mcpMatch) {",
        "      const mcp = JSON.parse(readFileSync(mcpMatch[1], 'utf8'));",
        "      const mcpArgs = mcp.mcpServers.anima.args;",
        "      const targetFile = mcpArgs[mcpArgs.indexOf('--target-file') + 1];",
        "      const target = JSON.parse(readFileSync(targetFile, 'utf8'));",
        "      if (target.active !== true) process.exit(94);",
        "      const isReminder = String(target.itemId || '').startsWith('reminder:');",
        "      const promptCount = state.prompts.length;",
        "      const shouldComplete = !isReminder || promptCount >= 5;",
        "      if (shouldComplete) {",
        "        const payload = isReminder ? { text: 'tmux targetless reminder completed' } : { status: 'completed' };",
        "        writeFileSync(target.completionFile, JSON.stringify(payload) + '\\n', 'utf8');",
        "      }",
        "      state.target = target;",
        "      state.targetFile = targetFile;",
        "    }",
        "  }",
        "  save(state);",
        "  process.exit(0);",
        "}",
        "process.exit(92);",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeTmux, 0o755);

    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'What did I ask over tmux?',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );

    runtime = createAgentRuntime(
      {
        env: runtimeTestEnv(stateDir, { TMUX_CALLS_PATH: callsPath, TMUX_STATE_PATH: tmuxStatePath }),
        kind: 'claude-code',
        model: 'opus',
        reasoningEffort: 'high',
        transport: 'tmux',
      },
    );

    const run = runtime.run(await runtimeInput(runtime, ctx, await loadState()));
    await waitFor(async () => {
      const state = JSON.parse(await readFile(tmuxStatePath, 'utf8')) as { sends?: number };
      return state.sends === 1;
    }, { timeoutMs: 5_000 });

    const followupCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'Steer the tmux turn.',
        ts: '1770000800.000002',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    const followup = await runtime.appendToActiveRun(await runtimeFollowupInput(runtime, ctx, followupCtx));
    assert.equal(followup.accepted, true);

    const result = await run;
    assert.equal(result.text, undefined);

    const state = JSON.parse(await readFile(tmuxStatePath, 'utf8')) as {
      mcpConfig: string;
      prompts: string[];
      systemPrompt: string;
      sessions: Record<string, { command: string }>;
      target: { active?: boolean; completionFile?: string; itemId?: string };
      targetFile: string;
    };
    const command = Object.values(state.sessions)[0]?.command ?? '';
    assert.match(command, /'claude'/);
    assert.match(command, /'--mcp-config'/);
    assert.match(command, /'--strict-mcp-config'/);
    assert.match(command, /'--system-prompt-file'/);
    assert.doesNotMatch(command, /--output-format/);
    assert.doesNotMatch(command, /--input-format/);
    assert.doesNotMatch(command, /'\-p'/);
    assert.match(state.systemPrompt, /You are Anima, general-purpose Anima agent\./);
    assert.match(state.systemPrompt, /anima message send <target flags>/);
    assert.equal(state.target.active, true);
    assert.equal(state.target.itemId, ctx.item.id);
    assert.ok(state.target.completionFile?.endsWith('.json'));
    assert.equal(state.prompts.some((prompt) => prompt.includes('What did I ask over tmux?')), true);
    const steeringPrompt = state.prompts.find((prompt) =>
      prompt.includes('Steering update from Anima') && prompt.includes('Steer the tmux turn.'));
    assert.ok(steeringPrompt);
    assertFollowupPrompt(steeringPrompt, 'Steer the tmux turn.');
    assert.equal(state.prompts.some((prompt) => prompt.includes('mcp__anima__reply')), false);
    assert.equal(state.prompts.some((prompt) => prompt.includes('mcp__anima__complete')), true);

    const mcpConfig = JSON.parse(await readFile(state.mcpConfig, 'utf8')) as {
      mcpServers?: { anima?: { args?: string[] } };
    };
    const mcpArgs = mcpConfig.mcpServers?.anima?.args ?? [];
    assert.equal(mcpArgs.includes('--target-file'), true);
    assert.equal(mcpArgs.includes('--item-id'), false);
    const clearedTarget = JSON.parse(await readFile(state.targetFile, 'utf8')) as { active?: boolean };
    assert.equal(clearedTarget.active, false);

    const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
    const started = activities.find((activity) => activity.type === 'runtime.started');
    assert.equal(started?.payload?.['inputFormat'], 'tmux');
    assert.equal(started?.payload?.['transport'], 'tmux');
    assert.equal(activities.some((activity) => activity.type === 'agent.text'), false);
    assert.equal(activities.some((activity) => activity.type === 'runtime.output'), false);
    await runtime.close?.();
    runtime = undefined;

    const secondHome = join(stateDir, 'second-home');
    await mkdir(secondHome, { recursive: true });
    const secondCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'Second home over tmux.',
        ts: '1770000900.000001',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir: secondHome },
    );
    runtime = createAgentRuntime(
      {
        env: runtimeTestEnv(stateDir, { TMUX_CALLS_PATH: callsPath, TMUX_STATE_PATH: tmuxStatePath }),
        kind: 'claude-code',
        model: 'opus',
        reasoningEffort: 'high',
        transport: 'tmux',
      },
    );
    const secondResult = await runtime.run(await runtimeInput(runtime, secondCtx, await loadState()));
    assert.equal(secondResult.text, undefined);

    await runtime.close?.();
    runtime = createAgentRuntime(
      {
        env: runtimeTestEnv(stateDir, { TMUX_CALLS_PATH: callsPath, TMUX_STATE_PATH: tmuxStatePath }),
        kind: 'claude-code',
        model: 'opus',
        reasoningEffort: 'high',
        transport: 'tmux',
      },
    );
    await seedReminder('anima', {
      instructions: 'Post a daily stand-up to #team.',
      reminderId: 'daily-standup',
      title: 'Daily stand-up',
    });
    const reminderCtx = await ingestEvent(
      makeReminderInboxItem({
        eventId: 'reminder:daily-standup:fire:1',
        reminderId: 'daily-standup',
        timestamp: '2026-05-18T17:00:00.000Z',
      }),
      { agentId: 'anima', stateDir },
    );
    const reminderRun = runtime.run(await runtimeInput(runtime, reminderCtx, await loadState()));
    await waitFor(async () => {
      const currentState = JSON.parse(await readFile(tmuxStatePath, 'utf8')) as { prompts?: string[] };
      return currentState.prompts?.some((prompt) => prompt.includes('Post a daily stand-up to #team.')) === true;
    }, { timeoutMs: 5_000 });

    const reminderFollowupCtx = await ingestEvent(
      makeReminderInboxItem({
        eventId: 'reminder:daily-standup:fire:2',
        reminderId: 'daily-standup',
        timestamp: '2026-05-18T17:00:01.000Z',
      }),
      { agentId: 'anima', stateDir },
    );
    const reminderFollowup = await runtime.appendToActiveRun(
      await runtimeFollowupInput(runtime, reminderCtx, reminderFollowupCtx),
    );
    assert.equal(reminderFollowup.accepted, true);

    const reminderResult = await reminderRun;
    assert.equal(reminderResult.text, 'tmux targetless reminder completed');

    const finalState = JSON.parse(await readFile(tmuxStatePath, 'utf8')) as {
      prompts: string[];
      target: { active?: boolean; completionFile?: string; itemId?: string };
      sessions: Record<string, { command: string }>;
    };
    const sessionNames = Object.keys(finalState.sessions);
    assert.equal(sessionNames.length, 2);
    assert.notEqual(sessionNames[0], sessionNames[1]);
    assert.equal(finalState.target.active, true);
    assert.equal(finalState.target.itemId, reminderCtx.item.id);
    const reminderPrompt = finalState.prompts.find((prompt) => prompt.includes('Post a daily stand-up to #team.'));
    assert.ok(reminderPrompt);
    assert.match(reminderPrompt, /mcp__anima__complete/);
    assert.doesNotMatch(reminderPrompt, /mcp__anima__reply/);
    const reminderSteeringPrompt = finalState.prompts.find((prompt) => prompt.includes('Steering update from Anima') && prompt.includes('Scheduled reminder:'));
    assert.ok(reminderSteeringPrompt);
    assertFollowupPrompt(reminderSteeringPrompt, 'Post a daily stand-up to #team.');
    assert.match(reminderSteeringPrompt, /mcp__anima__complete/);
    assert.doesNotMatch(reminderSteeringPrompt, /mcp__anima__reply/);

    const reminderActivities = await activitiesForInboxItemWindow('anima', reminderCtx.item.id);
    assert.ok(reminderActivities.some((activity) => activity.type === 'runtime.completed'));
    assert.equal(reminderActivities.some((activity) => activity.type === 'runtime.failed'), false);
    await runtime.close?.();
    runtime = undefined;
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code tmux transport memoizes liveness and health does not spawn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'tmux-liveness-calls.jsonl');
    const tmuxStatePath = join(stateDir, 'tmux-liveness-state.json');
    const fakeTmux = join(stateDir, 'tmux');
    await writeFile(
      fakeTmux,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "const callsPath = process.env.TMUX_CALLS_PATH;",
        "const statePath = process.env.TMUX_STATE_PATH;",
        "if (!callsPath || !statePath) process.exit(90);",
        "const args = process.argv.slice(2);",
        "appendFileSync(callsPath, JSON.stringify({ args }) + '\\n');",
        "const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { buffers: {}, sessions: {} };",
        "const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));",
        "const valueAfter = (flag) => args[args.indexOf(flag) + 1];",
        "const state = load();",
        "if (args[0] === '-V') { console.log('tmux 3.4-test'); process.exit(0); }",
        "if (args[0] === 'has-session') process.exit(state.sessions[valueAfter('-t')] ? 0 : 1);",
        "if (args[0] === 'new-session') {",
        "  const session = valueAfter('-s');",
        "  state.sessions[session] = { command: args.at(-1), capture: 'bypass permissions on' };",
        "  save(state);",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'pipe-pane') { save(state); process.exit(0); }",
        "if (args[0] === 'capture-pane') { console.log(state.sessions[valueAfter('-t')]?.capture || 'bypass permissions on'); process.exit(0); }",
        "if (args[0] === 'load-buffer') { state.buffers[valueAfter('-b')] = args.at(-1); save(state); process.exit(0); }",
        "if (args[0] === 'paste-buffer') { save(state); process.exit(0); }",
        "if (args[0] === 'delete-buffer') { delete state.buffers[valueAfter('-b')]; save(state); process.exit(0); }",
        "if (args[0] === 'send-keys') {",
        "  if (args.includes('C-m')) {",
        "    const session = valueAfter('-t');",
        "    const command = state.sessions[session]?.command || '';",
        "    const mcpMatch = command.match(/'--mcp-config'\\s+'([^']+)'/);",
        "    if (!mcpMatch) process.exit(91);",
        "    const mcp = JSON.parse(readFileSync(mcpMatch[1], 'utf8'));",
        "    const mcpArgs = mcp.mcpServers.anima.args;",
        "    const targetFile = mcpArgs[mcpArgs.indexOf('--target-file') + 1];",
        "    const target = JSON.parse(readFileSync(targetFile, 'utf8'));",
        "    writeFileSync(target.completionFile, JSON.stringify({ status: 'completed' }) + '\\n', 'utf8');",
        "  }",
        "  save(state);",
        "  process.exit(0);",
        "}",
        "process.exit(92);",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeTmux, 0o755);

    runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { TMUX_CALLS_PATH: callsPath, TMUX_STATE_PATH: tmuxStatePath }),
      kind: 'claude-code',
      transport: 'tmux',
    });

    const firstCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'First tmux liveness turn.',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    await runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
    const afterCreateChecks = await countTmuxCalls(callsPath, 'has-session');

    runtime.health?.();
    runtime.health?.();
    assert.equal(await countTmuxCalls(callsPath, 'has-session'), afterCreateChecks);

    const secondCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'Second tmux liveness turn.',
        ts: '1770001000.000001',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    await runtime.run(await runtimeInput(runtime, secondCtx, await loadState()));
    const afterFreshCheck = await countTmuxCalls(callsPath, 'has-session');
    assert.equal(afterFreshCheck, afterCreateChecks + 1);

    const thirdCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'Third tmux liveness turn.',
        ts: '1770001000.000002',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    await runtime.run(await runtimeInput(runtime, thirdCtx, await loadState()));
    assert.equal(await countTmuxCalls(callsPath, 'has-session'), afterFreshCheck);

    await sleep(3_100);
    const fourthCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'Fourth tmux liveness turn.',
        ts: '1770001000.000003',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    await runtime.run(await runtimeInput(runtime, fourthCtx, await loadState()));
    assert.equal(await countTmuxCalls(callsPath, 'has-session'), afterFreshCheck + 1);

    const killedState = JSON.parse(await readFile(tmuxStatePath, 'utf8')) as { sessions?: Record<string, unknown> };
    killedState.sessions = {};
    await writeFile(tmuxStatePath, `${JSON.stringify(killedState, null, 2)}\n`, 'utf8');
    const beforeHealthRefresh = await countTmuxCalls(callsPath, 'has-session');
    await sleep(3_100);
    assert.equal(runtime.health?.().child?.alive, true);
    await waitFor(async () =>
      await countTmuxCalls(callsPath, 'has-session') === beforeHealthRefresh + 1,
    );
    assert.equal(runtime.health?.().child?.alive, false);

    await runtime.close?.();
    runtime = undefined;
    });
  } finally {
    await runtime?.close?.();
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
    assert.equal(failed?.payload?.['providerReason'], 'provider_auth_failed');
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
    assertFollowupPrompt(calls[1]?.message.content[0]?.text ?? '', 'second message');
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
    let appendSettled = false;
    const appendPromise = runtime.appendToActiveRun(
      await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState()),
    ).finally(() => {
      appendSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(appendSettled, false);
    assert.equal((await readFile(callsPath, 'utf8')).trim().split('\n').length, 1);
    await writeFile(releasePath, '1', 'utf8');
    assert.deepEqual(
      await withTimeout(appendPromise, 2_000),
      { accepted: true, text: 'appended to Claude stream-json stdin' },
    );
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
