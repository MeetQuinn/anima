import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentRuntimeInput, ClaudeCodeAgentProviderConfig } from './contract.js';

export const CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW = 272000;
export const CLAUDE_DISABLE_AUTO_MEMORY = '1';
// Claude Code moves a subagent or MCP call that runs past about two minutes to
// the background only in interactive sessions unless this is set. Anima keeps
// the Claude process alive between items, so the result still arrives as a task
// notification and Claude starts a turn for it; the agent isn't blocked meanwhile.
export const CLAUDE_DEFAULT_AUTO_BACKGROUND_TASKS = '1';
// Claude Code's own MCP tool timeout is about 28 hours. A stdio server that
// stops answering is aborted only by its 30-minute idle check, and a call in the
// background keeps the agent's Claude process from going idle until it ends.
// Ten minutes leaves room for slow tools; a server's own `timeout` still wins.
export const CLAUDE_DEFAULT_MCP_TOOL_TIMEOUT_MS = 10 * 60 * 1000;
// Claude Code keeps every line of a session transcript, and an agent's session
// lives for weeks, so transcripts reach gigabytes. With this set, after each
// compaction Claude Code drops the pre-compaction history once the file passes
// 5 MB; resuming restores the same conversation. Only the launch environment can
// turn it on, not a settings `env` block.
export const CLAUDE_DEFAULT_TRANSCRIPT_LOCAL_GC = '1';
export const CLAUDE_FAST_MODE_SETTINGS = JSON.stringify({ fastMode: true });
export const CLAUDE_DISALLOWED_TOOLS = [
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
];

export function claudeProviderEnv(config: ClaudeCodeAgentProviderConfig): Record<string, string> {
  return {
    CLAUDE_AUTO_BACKGROUND_TASKS: CLAUDE_DEFAULT_AUTO_BACKGROUND_TASKS,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW),
    CLAUDE_CODE_TRANSCRIPT_LOCAL_GC: CLAUDE_DEFAULT_TRANSCRIPT_LOCAL_GC,
    MCP_TOOL_TIMEOUT: String(CLAUDE_DEFAULT_MCP_TOOL_TIMEOUT_MS),
    ...(config.env ?? {}),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: CLAUDE_DISABLE_AUTO_MEMORY,
  };
}

export function claudeCommonArgs(
  config: ClaudeCodeAgentProviderConfig,
  systemPromptFilePath: string | undefined,
): string[] {
  const args = [
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', CLAUDE_DISALLOWED_TOOLS.join(','),
  ];
  if (config.model) args.push('--model', config.model);
  if (config.reasoningEffort) args.push('--effort', config.reasoningEffort);
  if (systemPromptFilePath) args.push('--system-prompt-file', systemPromptFilePath);
  return args;
}

export function claudeFastModeArgs(config: ClaudeCodeAgentProviderConfig): string[] {
  return config.fastMode ? ['--settings', CLAUDE_FAST_MODE_SETTINGS] : [];
}

export function claudeAutoCompactWindowFor(
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
): number | undefined {
  if (runtimeKind !== 'claude-code') return undefined;
  const configured = runtimeEnv?.['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];
  if (configured !== undefined) {
    const value = Number(configured);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  return CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW;
}

export async function writeSystemPromptFile(
  input: Pick<AgentRuntimeInput, 'systemPrompt' | 'systemPromptFilePath'>,
): Promise<string | undefined> {
  if (!input.systemPrompt || !input.systemPromptFilePath) return undefined;
  await mkdir(dirname(input.systemPromptFilePath), { recursive: true });
  await writeFile(input.systemPromptFilePath, input.systemPrompt, 'utf8');
  return input.systemPromptFilePath;
}
