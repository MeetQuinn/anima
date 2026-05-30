import { ClaudeCodeAgentRuntime } from './claude.js';
import { CodexCliAgentRuntime } from './codex.js';
import { KimiCliAgentRuntime } from './kimi.js';
import type { AgentRuntime, AgentProviderConfig } from './contract.js';

export function createAgentRuntime(config: AgentProviderConfig): AgentRuntime {
  if (config.kind === 'codex-cli') return new CodexCliAgentRuntime(config);
  if (config.kind === 'claude-code') return new ClaudeCodeAgentRuntime(config);
  if (config.kind === 'kimi-cli') return new KimiCliAgentRuntime(config);
  throw new Error(`Unsupported agent provider kind: ${(config as { kind?: string }).kind ?? 'missing'}`);
}
