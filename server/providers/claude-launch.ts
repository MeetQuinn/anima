import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentRuntimeInput, ClaudeCodeAgentProviderConfig } from './contract.js';

export const CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW = 272000;
export const CLAUDE_DISABLE_AUTO_MEMORY = '1';
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
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW),
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
