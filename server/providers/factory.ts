import { ClaudeCodeAgentRuntime } from './claude.js';
import { CodexCliAgentRuntime } from './codex.js';
import { GrokCliAgentRuntime } from './grok.js';
import { KimiCliAgentRuntime } from './kimi.js';
import { OpenCodeCliAgentRuntime } from './opencode.js';
import { PiAgentRuntime } from './pi.js';
import { effectiveProviderRuntimeCommand } from '../../shared/provider-runtime-commands.js';
import type { AgentRuntime, AgentProviderConfig } from './contract.js';

export function createAgentRuntime(
  config: AgentProviderConfig,
  options: { args?: readonly string[]; command?: string } = {},
): AgentRuntime {
  const command = options.command ?? effectiveProviderRuntimeCommand(config.kind, {});
  const args = [...(options.args ?? [])];
  if (config.kind === 'codex-cli') return new CodexCliAgentRuntime(config, command, args);
  if (config.kind === 'claude-code') return new ClaudeCodeAgentRuntime(config, command, args);
  if (config.kind === 'grok-cli') return new GrokCliAgentRuntime(config, command, args);
  if (config.kind === 'kimi-cli') return new KimiCliAgentRuntime(config, command, args);
  if (config.kind === 'opencode-cli') return new OpenCodeCliAgentRuntime(config, command, args);
  if (config.kind === 'pi') return new PiAgentRuntime(config, command, args);
  throw new Error(`Unsupported agent provider kind: ${(config as { kind?: string }).kind ?? 'missing'}`);
}
