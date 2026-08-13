import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentRuntimeInput, ClaudeCodeAgentProviderConfig } from './contract.js';

export const CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW = 272000;
export const CLAUDE_DISABLE_AUTO_MEMORY = '1';
export const CLAUDE_DISALLOWED_TOOLS = [
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
];

/** Extra native tools denied when ANIMA_MEMORY_COHERENCE_SEAL=1 (see memory-coherence-seal.ts). */
export const CLAUDE_MEMORY_COHERENCE_DISALLOWED_TOOLS = [
  'Bash',
  'Task',
  'Agent',
  'WebSearch',
  'WebFetch',
  'NotebookEdit',
  'BashOutput',
  'KillShell',
] as const;

export function claudeProviderEnv(config: ClaudeCodeAgentProviderConfig): Record<string, string> {
  return {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW),
    ...(config.env ?? {}),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: CLAUDE_DISABLE_AUTO_MEMORY,
  };
}

export function claudeDisallowedToolsForEnv(env?: Record<string, string>): string[] {
  const base = [...CLAUDE_DISALLOWED_TOOLS];
  if (env?.['ANIMA_MEMORY_COHERENCE_SEAL'] === '1') {
    for (const tool of CLAUDE_MEMORY_COHERENCE_DISALLOWED_TOOLS) {
      if (!base.includes(tool)) base.push(tool);
    }
  }
  return base;
}

export function claudeCommonArgs(
  config: ClaudeCodeAgentProviderConfig,
  systemPromptFilePath: string | undefined,
  runtimeEnv?: Record<string, string>,
): string[] {
  const disallowed = claudeDisallowedToolsForEnv(runtimeEnv ?? config.env);
  const args = [
    '--chrome',
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', disallowed.join(','),
  ];
  if (config.model) args.push('--model', config.model);
  if (config.reasoningEffort) args.push('--effort', config.reasoningEffort);
  if (systemPromptFilePath) args.push('--system-prompt-file', systemPromptFilePath);
  return args;
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
