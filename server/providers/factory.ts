import { ClaudeCodeAgentRuntime } from './claude.js';
import { ClaudeCodeChannelAgentRuntime } from './claude-channel.js';
import { ClaudeCodeTmuxAgentRuntime } from './claude-tmux.js';
import { CodexCliAgentRuntime } from './codex.js';
import { KimiCliAgentRuntime } from './kimi.js';
import type { AgentRuntime, AgentProviderConfig } from './contract.js';

export function createAgentRuntime(
  config: AgentProviderConfig,
): AgentRuntime {
  if (config.kind === 'codex-cli') return new CodexCliAgentRuntime(config);
  if (config.kind === 'claude-code' && config.transport === 'channel') {
    return new ClaudeCodeChannelAgentRuntime(config);
  }
  if (config.kind === 'claude-code' && config.transport === 'tmux') {
    return new ClaudeCodeTmuxAgentRuntime(config);
  }
  if (config.kind === 'claude-code') return new ClaudeCodeAgentRuntime(config);
  if (config.kind === 'kimi-cli') return new KimiCliAgentRuntime(config);
  throw new Error(`Unsupported agent provider kind: ${(config as { kind?: string }).kind ?? 'missing'}`);
}
