import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { sleep, waitFor, withTimeout } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../providers/factory.js';
import {
  CLAUDE_DISABLE_AUTO_MEMORY,
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_FAST_MODE_SETTINGS,
} from '../providers/claude-launch.js';
import type { AgentRuntime } from '../providers/contract.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { allActivities, loadState } from './helpers/state.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { withAnimaHome } from './anima-home.js';
import { agentTokenUsageServiceForAgent } from '../usage/agent-token-usage.service.js';
import { runtimeInput, runtimeFollowupInput, assertFollowupPrompt, providerSessionStartedPayload, runtimeTestEnv } from './helpers/agent-runtime.js';

test('claude-code runtime launches an agent fast-mode opt-in before raw argv overrides', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-claude-provider-args-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const argvPath = join(stateDir, 'argv.json');
      const fakeClaude = join(stateDir, 'claude');
      await writeFile(
        fakeClaude,
        [
          '#!/usr/bin/env node',
          "import { writeFileSync } from 'node:fs';",
          "import readline from 'node:readline';",
          "writeFileSync(process.env.ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
          "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
          "send({ type: 'system', subtype: 'init', session_id: 'claude-args-session', cwd: process.cwd(), claude_code_version: 'test' });",
          "readline.createInterface({ input: process.stdin }).once('line', () => {",
          "  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'args ok' }] }, session_id: 'claude-args-session' });",
          "  send({ type: 'result', subtype: 'success', result: 'args ok', session_id: 'claude-args-session' });",
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
          text: 'check provider args',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      runtime = createAgentRuntime(
        {
          env: runtimeTestEnv(stateDir, { ARGV_PATH: argvPath }),
          fastMode: true,
          kind: 'claude-code',
        },
        {
          args: [
            '--settings',
            '{"fastMode":false,"outputStyle":"Explanatory"}',
            '--chrome',
            '--profile',
            'team one',
          ],
          command: fakeClaude,
        },
      );

      assert.equal(
        (await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text,
        'args ok',
      );
      const argv = JSON.parse(await readFile(argvPath, 'utf8')) as string[];
      assert.deepEqual(argv.slice(0, 7), [
        '--settings',
        CLAUDE_FAST_MODE_SETTINGS,
        '--settings',
        '{"fastMode":false,"outputStyle":"Explanatory"}',
        '--chrome',
        '--profile',
        'team one',
      ]);
      assert.equal(argv.includes('--output-format'), true);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code runtime streams activity, persists Claude session metadata, and resumes it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  const previousClaudeProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'claude-calls.jsonl');
    const claudeConfigDir = join(stateDir, 'claude-config');
    const claudeMdSentinel = 'VISIBLE_CLAUDE_MD_SENTINEL';
    const existingNativeMemoryPath = join(
      claudeConfigDir,
      'projects',
      'existing-project',
      'memory',
      'MEMORY.md',
    );
    const claudeProjectsDir = join(stateDir, 'claude-projects');
    const claudeSubagentCwd = '/tmp/anima-claude-subagent-cwd';
    const claudeProjectRoot = join(claudeProjectsDir, claudeSubagentCwd.replace(/\/+$/, '').replaceAll('/', '-'));
    const claudeProjectDir = join(claudeProjectRoot, 'claude-session-1', 'subagents');
    const claudeParentTranscriptLog = join(claudeProjectRoot, 'claude-session-1.jsonl');
    const claudeResultSubagentLog = join(claudeProjectDir, 'agent-claude-child-result.jsonl');
    process.env.CLAUDE_PROJECTS_DIR = claudeProjectsDir;
    await mkdir(claudeProjectDir, { recursive: true });
    await mkdir(dirname(existingNativeMemoryPath), { recursive: true });
    await writeFile(join(stateDir, 'CLAUDE.md'), `${claudeMdSentinel}\n`, 'utf8');
    await writeFile(existingNativeMemoryPath, 'existing native auto-memory\n', 'utf8');
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
        'if (argv.includes("--chrome")) process.exit(63);',
        'if (!argv.includes("--verbose")) process.exit(42);',
        'if (!argv.includes("--include-partial-messages")) process.exit(60);',
        'if (!argv.includes("--include-hook-events")) process.exit(61);',
        `if (argv[argv.indexOf("--disallowedTools") + 1] !== ${JSON.stringify(CLAUDE_DISALLOWED_TOOLS.join(','))}) process.exit(62);`,
        'if (argv[argv.indexOf("--output-format") + 1] !== "stream-json") process.exit(43);',
        'if (argv[argv.indexOf("--permission-mode") + 1] !== "bypassPermissions") process.exit(44);',
        'if (argv[argv.indexOf("--model") + 1] !== "opus") process.exit(56);',
        'if (argv[argv.indexOf("--effort") + 1] !== "max") process.exit(57);',
        'if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== "272000") process.exit(59);',
        `if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== ${JSON.stringify(CLAUDE_DISABLE_AUTO_MEMORY)}) process.exit(64);`,
        `if (!readFileSync('CLAUDE.md', 'utf8').includes(${JSON.stringify(claudeMdSentinel)})) process.exit(65);`,
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
        '  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_task_create_1", name: "TaskCreate", input: { subject: "Trace task activity", activeForm: "Tracing task activity", description: "long internal task description must not enter activity" } }] }, session_id: "claude-session-1" }));',
        '  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_task_update_1", name: "TaskUpdate", input: { taskId: "7", status: "completed", activeForm: "Tracing task activity", description: "updated internal task description must not enter activity" } }] }, session_id: "claude-session-1" }));',
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
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        ...runtimeTestEnv(stateDir, {
          CLAUDE_RESULT_SUBAGENT_LOG: claudeResultSubagentLog,
          CLAUDE_PARENT_TRANSCRIPT_LOG: claudeParentTranscriptLog,
          CLAUDE_SUBAGENT_CWD: claudeSubagentCwd,
        }),
      },
      kind: 'claude-code',
      model: 'opus',
      reasoningEffort: 'max',
    });

    assert.equal(
      (await runtime.run(await runtimeInput(runtime, firstCtx, await loadState()))).text,
      'first run',
    );
    assert.equal(runtime.health?.().child?.version, 'test');
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
    const taskCreated = firstActivities.find((activity) => activity.payload?.['providerToolId'] === 'toolu_task_create_1');
    assert.equal(taskCreated?.payload?.['taskSubject'], 'Trace task activity');
    assert.equal(taskCreated?.payload?.['taskActiveForm'], 'Tracing task activity');
    assert.equal(taskCreated?.payload?.['target'], 'Trace task activity');
    assert.equal(taskCreated?.payload?.['description'], undefined);
    const taskUpdated = firstActivities.find((activity) => activity.payload?.['providerToolId'] === 'toolu_task_update_1');
    assert.equal(taskUpdated?.payload?.['taskId'], '7');
    assert.equal(taskUpdated?.payload?.['taskStatus'], 'completed');
    assert.equal(taskUpdated?.payload?.['taskActiveForm'], 'Tracing task activity');
    assert.equal(taskUpdated?.payload?.['target'], 'Tracing task activity');
    assert.equal(taskUpdated?.payload?.['description'], undefined);
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
    const usage = await agentTokenUsageServiceForAgent('anima').summary({
      agentName: 'Anima',
      from: '2000-01-01',
      through: '2100-01-01',
      timezone: 'UTC',
    });
    assert.equal(usage.totalTokens, 2256);
    assert.equal(usage.reportedRuns, 2);
    assert.equal(usage.unknownRuns, 0);
    assert.equal(await readFile(existingNativeMemoryPath, 'utf8'), 'existing native auto-memory\n');
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

test('claude-code keeps the provider child until background work finishes plus the idle window', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const releasePath = join(stateDir, 'claude-background-release');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { existsSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "send({ type: 'system', subtype: 'init', session_id: 'claude-background-session', cwd: process.cwd(), claude_code_version: 'test' });",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.once('line', () => {",
        "  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'background-agent-1', task_type: 'local_agent', description: 'Background agent' }], session_id: 'claude-background-session' });",
        "  send({ type: 'result', subtype: 'success', result: 'main turn done', session_id: 'claude-background-session' });",
        "  const release = setInterval(() => {",
        "    if (!existsSync(process.env.RELEASE_PATH)) return;",
        "    clearInterval(release);",
        "    send({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: 'claude-background-session' });",
        "    send({ type: 'system', subtype: 'task_notification', task_id: 'background-agent-1', status: 'stopped', output_file: '', summary: 'Stopped', session_id: 'claude-background-session' });",
        "  }, 5);",
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
        text: 'Run work in the background.',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { RELEASE_PATH: releasePath }),
      kind: 'claude-code',
      providerChildIdleTimeoutMs: 50,
    });

    assert.equal(
      (await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text,
      'main turn done',
    );
    assert.deepEqual(runtime.health?.().providerWork, {
      backgroundTaskCount: 1,
      state: 'background',
    });
    const backgroundStartedAt = runtime.health?.().child?.lastStdoutAt;
    await sleep(100);
    assert.ok(runtime.health?.().child?.alive);

    await writeFile(releasePath, '1', 'utf8');
    await waitFor(
      () => runtime?.health?.().child?.lastStdoutAt !== backgroundStartedAt,
      { description: 'Claude background completion event', timeoutMs: 1_000 },
    );
    await waitFor(
      () => runtime?.health?.().providerWork === undefined,
      { description: 'Claude background status clear', timeoutMs: 1_000 },
    );
    await sleep(20);
    assert.ok(runtime.health?.().child?.alive);
    await waitFor(
      () => runtime?.health?.().child === undefined,
      { description: 'Claude provider child idle reset after background completion', timeoutMs: 1_000 },
    );
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code bridges an async hook native rewake into the original turn lifecycle', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const hookReleasePath = join(stateDir, 'claude-hook-release');
    const resultReleasePath = join(stateDir, 'claude-rewake-result-release');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { existsSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "send({ type: 'system', subtype: 'init', session_id: 'claude-rewake-session', cwd: process.cwd(), claude_code_version: 'test' });",
        "readline.createInterface({ input: process.stdin }).once('line', () => {",
        "  send({ type: 'system', subtype: 'hook_started', hook_id: 'hook-async-rewake', hook_name: 'background-check', hook_event: 'Stop', session_id: 'claude-rewake-session' });",
        "  send({ type: 'result', subtype: 'success', result: 'main turn done', session_id: 'claude-rewake-session' });",
        "  const hookRelease = setInterval(() => {",
        "    if (!existsSync(process.env.HOOK_RELEASE_PATH)) return;",
        "    clearInterval(hookRelease);",
        "    send({ type: 'system', subtype: 'hook_response', hook_id: 'hook-async-rewake', hook_name: 'background-check', hook_event: 'Stop', output: 'retry with feedback', stdout: '', stderr: 'retry with feedback', exit_code: 2, outcome: 'error', session_id: 'claude-rewake-session' });",
        "    send({ type: 'system', subtype: 'turn_starting', mode: 'task-notification', task_id: null, session_id: 'claude-rewake-session' });",
        "    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'native rewake follow-up' }] }, session_id: 'claude-rewake-session' });",
        "    const resultRelease = setInterval(() => {",
        "      if (!existsSync(process.env.RESULT_RELEASE_PATH)) return;",
        "      clearInterval(resultRelease);",
        "      send({ type: 'result', subtype: 'success', result: 'native rewake follow-up', session_id: 'claude-rewake-session' });",
        "    }, 5);",
        "  }, 5);",
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
        text: 'Run a background hook and react to its result.',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, {
        HOOK_RELEASE_PATH: hookReleasePath,
        RESULT_RELEASE_PATH: resultReleasePath,
      }),
      kind: 'claude-code',
      providerChildIdleTimeoutMs: 50,
    });

    assert.equal(
      (await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text,
      'main turn done',
    );
    assert.deepEqual(runtime.health?.().providerWork, {
      backgroundTaskCount: 1,
      state: 'background',
    });

    await writeFile(hookReleasePath, '1', 'utf8');
    await waitFor(
      () => runtime?.health?.().providerWork?.state === 'working',
      { description: 'Claude native rewake working state', timeoutMs: 1_000 },
    );
    await waitFor(async () => {
      const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
      return activities.some((activity) => (
        activity.type === 'agent.text'
        && activity.payload?.['text'] === 'native rewake follow-up'
      ));
    }, { description: 'Claude native rewake activity on original item', timeoutMs: 1_000 });

    await writeFile(resultReleasePath, '1', 'utf8');
    await waitFor(
      () => runtime?.health?.().providerWork === undefined,
      { description: 'Claude native rewake completion', timeoutMs: 1_000 },
    );
    const activities = await activitiesForInboxItemWindow('anima', ctx.item.id);
    assert.equal(
      activities.filter((activity) => activity.type === 'runtime.started').length,
      1,
    );
    assert.equal(
      activities.filter((activity) => activity.type === 'runtime.completed').length,
      1,
    );
    await waitFor(
      () => runtime?.health?.().child === undefined,
      { description: 'Claude provider child idle reset after native rewake', timeoutMs: 1_000 },
    );
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude-code keeps native rewake output on its original item while a new wake is queued', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const nativeReleasePath = join(stateDir, 'claude-native-release');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { existsSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "send({ type: 'system', subtype: 'init', session_id: 'claude-concurrent-rewake-session', cwd: process.cwd(), claude_code_version: 'test' });",
        "const rl = readline.createInterface({ input: process.stdin });",
        "let promptCount = 0;",
        "rl.on('line', () => {",
        "  promptCount += 1;",
        "  if (promptCount === 1) {",
        "    send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'background-agent-1', task_type: 'local_agent', description: 'Background agent' }], session_id: 'claude-concurrent-rewake-session' });",
        "    send({ type: 'result', subtype: 'success', result: 'first main turn done', session_id: 'claude-concurrent-rewake-session' });",
        "    return;",
        "  }",
        "  const nativeRelease = setInterval(() => {",
        "    if (!existsSync(process.env.NATIVE_RELEASE_PATH)) return;",
        "    clearInterval(nativeRelease);",
        "    send({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: 'claude-concurrent-rewake-session' });",
        "    send({ type: 'system', subtype: 'task_notification', task_id: 'background-agent-1', status: 'completed', output_file: '', summary: 'Done', session_id: 'claude-concurrent-rewake-session' });",
        "    send({ type: 'system', subtype: 'turn_starting', mode: 'task-notification', task_id: 'background-agent-1', session_id: 'claude-concurrent-rewake-session' });",
        "    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'first item native follow-up' }] }, session_id: 'claude-concurrent-rewake-session' });",
        "    send({ type: 'result', subtype: 'success', result: 'first item native follow-up', session_id: 'claude-concurrent-rewake-session' });",
        "    send({ type: 'system', subtype: 'turn_starting', mode: 'prompt', session_id: 'claude-concurrent-rewake-session' });",
        "    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'second item response' }] }, session_id: 'claude-concurrent-rewake-session' });",
        "    send({ type: 'result', subtype: 'success', session_id: 'claude-concurrent-rewake-session' });",
        "  }, 5);",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const firstCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'Start the background work.',
        ts: '1770000000.000021',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    const secondCtx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-anima',
        teamId: 'T-demo',
        text: 'Handle this next message too.',
        ts: '1770000000.000022',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { NATIVE_RELEASE_PATH: nativeReleasePath }),
      kind: 'claude-code',
    });

    assert.equal(
      (await runtime.run(await runtimeInput(runtime, firstCtx, await loadState()))).text,
      'first main turn done',
    );
    const secondRun = runtime.run(await runtimeInput(runtime, secondCtx, await loadState()));
    await writeFile(nativeReleasePath, '1', 'utf8');
    assert.equal((await secondRun).text, 'second item response');

    const firstActivities = await activitiesForInboxItemWindow('anima', firstCtx.item.id);
    const secondActivities = await activitiesForInboxItemWindow('anima', secondCtx.item.id);
    assert.equal(
      firstActivities.some((activity) => (
        activity.type === 'agent.text'
        && activity.payload?.['text'] === 'first item native follow-up'
      )),
      true,
    );
    assert.equal(
      secondActivities.some((activity) => (
        activity.type === 'agent.text'
        && activity.payload?.['text'] === 'first item native follow-up'
      )),
      false,
    );
    assert.equal(
      secondActivities.some((activity) => (
        activity.type === 'agent.text'
        && activity.payload?.['text'] === 'second item response'
      )),
      true,
    );
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
    const usage = await agentTokenUsageServiceForAgent('anima').summary({
      agentName: 'Anima',
      from: '2000-01-01',
      through: '2100-01-01',
      timezone: 'UTC',
    });
    assert.equal(usage.reportedRuns, 1);
    assert.equal(usage.unknownRuns, 1);
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

const CLAUDE_STALLED_STREAM_ERRORS = [
  'API Error: Response stalled mid-stream. The response above may be incomplete.',
  'API Error: The response stopped arriving. The response above may be incomplete.',
];

for (const providerErrorText of CLAUDE_STALLED_STREAM_ERRORS) {
  test(`claude-code runtime resumes after "${providerErrorText}" when tool use already started`, async () => {
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
          "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: process.env.PROVIDER_ERROR_TEXT, session_id: 'claude-error-session', usage: { input_tokens: 0, output_tokens: 0 }, terminal_reason: 'api_error' }));",
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
        env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath, PROVIDER_ERROR_TEXT: providerErrorText }),
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
}

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
    const boundaryPath = join(stateDir, 'claude-gated-boundary');
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
        "    const boundary = setInterval(() => {",
        "      if (!existsSync(process.env.BOUNDARY_PATH)) return;",
        "      clearInterval(boundary);",
        "      send({ type: 'system', subtype: 'compact_boundary', session_id: 'claude-gated-session' });",
        "    }, 10);",
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
      env: runtimeTestEnv(stateDir, {
        BOUNDARY_PATH: boundaryPath,
        CALLS_PATH: callsPath,
        RELEASE_PATH: releasePath,
      }),
      kind: 'claude-code',
    });
    const firstInput = await runtimeInput(runtime, firstCtx, await loadState());
    const gatePersistenceReached = deferredSignal();
    const releaseGatePersistence = deferredSignal();
    const originalEffects = firstInput.effects;
    firstInput.effects = {
      ...originalEffects,
      async recordEvent(payload) {
        await originalEffects.recordEvent(payload);
        if (payload['eventType'] !== 'claude.compact.started') return;
        gatePersistenceReached.resolve();
        await releaseGatePersistence.promise;
      },
    };
    const runPromise = runtime.run(firstInput);
    await waitFor(async () => (await readFile(callsPath, 'utf8')).includes('first message'));
    await withTimeout(gatePersistenceReached.promise, 1_000);
    const activitiesAtBarrier = await activitiesForInboxItemWindow('anima', firstCtx.item.id);
    assert.ok(activitiesAtBarrier.some(
      (activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.compact.started',
    ));
    let appendSettled = false;
    const appendPromise = runtime.appendToActiveRun(
      await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState()),
    ).finally(() => {
      appendSettled = true;
    });

    try {
      await nextImmediate();
      assert.equal(appendSettled, false);
      assert.equal((await readFile(callsPath, 'utf8')).trim().split('\n').length, 1);

      releaseGatePersistence.resolve();
      await writeFile(boundaryPath, '1', 'utf8');
      await waitFor(async () => {
        const activities = await activitiesForInboxItemWindow('anima', firstCtx.item.id);
        return activities.some(
          (activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'claude.compact.completed',
        );
      });
      await nextImmediate();
      assert.equal(appendSettled, false);
      assert.equal((await readFile(callsPath, 'utf8')).trim().split('\n').length, 1);

      await writeFile(releasePath, '1', 'utf8');
      assert.deepEqual(
        await withTimeout(appendPromise, 2_000),
        { accepted: true, text: 'appended to Claude stream-json stdin' },
      );
      assert.equal((await withTimeout(runPromise, 2_000)).text, 'gated done');
    } finally {
      releaseGatePersistence.resolve();
      await writeFile(boundaryPath, '1', 'utf8');
      await writeFile(releasePath, '1', 'utf8');
      await Promise.allSettled([
        withTimeout(appendPromise, 2_000),
        withTimeout(runPromise, 2_000),
      ]);
    }

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

test('claude-code closes the tool gate before tool.call.started persists', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-test-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    const callsPath = join(stateDir, 'claude-toolgate-input.jsonl');
    const releasePath = join(stateDir, 'claude-toolgate-release');
    const fakeClaude = join(stateDir, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, existsSync } from 'node:fs';",
        "import readline from 'node:readline';",
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "let count = 0;",
        "send({ type: 'system', subtype: 'init', session_id: 'claude-toolgate-session', cwd: process.cwd(), claude_code_version: 'test' });",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  const msg = JSON.parse(line);",
        "  appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
        "  const text = msg.message.content[0].text;",
        "  count += 1;",
        "  if (count === 1) {",
        "    if (!text.includes('first message')) process.exit(52);",
        "    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_only_1', name: 'Read', input: { file_path: '/tmp/gated.md' } }] }, session_id: 'claude-toolgate-session' });",
        "    const release = setInterval(() => {",
        "      if (!existsSync(process.env.RELEASE_PATH)) return;",
        "      clearInterval(release);",
        "      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_only_1', content: 'done', is_error: false }] }, session_id: 'claude-toolgate-session' });",
        "    }, 10);",
        "    return;",
        "  }",
        "  if (count === 2) {",
        "    if (!text.includes('second message')) process.exit(53);",
        "    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'handled tool-gated follow-up' }] }, session_id: 'claude-toolgate-session' });",
        "    send({ type: 'result', subtype: 'success', result: 'tool gated done', session_id: 'claude-toolgate-session' });",
        "  }",
        "});",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeClaude, 0o755);

    const config = { agentId: 'anima', stateDir };
    const firstCtx = await ingestEvent(
      makeSlackEvent({ channelId: 'D-anima', teamId: 'T-demo', text: 'first message', userId: 'U1' }),
      config,
    );
    const secondCtx = await ingestEvent(
      makeSlackEvent({ channelId: 'D-anima', teamId: 'T-demo', text: 'second message', userId: 'U1' }),
      config,
    );

    runtime = createAgentRuntime({
      env: runtimeTestEnv(stateDir, { CALLS_PATH: callsPath, RELEASE_PATH: releasePath }),
      kind: 'claude-code',
    });
    const firstInput = await runtimeInput(runtime, firstCtx, await loadState());
    const toolPersistenceReached = deferredSignal();
    const releaseToolPersistence = deferredSignal();
    const originalEffects = firstInput.effects;
    firstInput.effects = {
      ...originalEffects,
      async recordToolStarted(payload) {
        await originalEffects.recordToolStarted(payload);
        if (payload['providerToolId'] !== 'toolu_only_1') return;
        toolPersistenceReached.resolve();
        await releaseToolPersistence.promise;
      },
    };
    const runPromise = runtime.run(firstInput);
    await waitFor(async () => (await readFile(callsPath, 'utf8')).includes('first message'));
    await withTimeout(toolPersistenceReached.promise, 2_000);

    let appendSettled = false;
    const appendPromise = runtime.appendToActiveRun(
      await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState()),
    ).finally(() => {
      appendSettled = true;
    });

    try {
      await nextImmediate();
      assert.equal(appendSettled, false);
      assert.equal((await readFile(callsPath, 'utf8')).trim().split('\n').length, 1);

      releaseToolPersistence.resolve();
      await nextImmediate();
      assert.equal(appendSettled, false);

      await writeFile(releasePath, '1', 'utf8');
      assert.deepEqual(
        await withTimeout(appendPromise, 2_000),
        { accepted: true, text: 'appended to Claude stream-json stdin' },
      );
      assert.equal((await withTimeout(runPromise, 2_000)).text, 'tool gated done');
    } finally {
      releaseToolPersistence.resolve();
      await writeFile(releasePath, '1', 'utf8');
      await Promise.allSettled([
        withTimeout(appendPromise, 2_000),
        withTimeout(runPromise, 2_000),
      ]);
    }

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

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
