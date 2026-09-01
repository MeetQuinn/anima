import type {
  AgentProviderConfig,
  ClaudeCodeAgentProviderConfig,
  CodexCliAgentProviderConfig,
  GrokCliAgentProviderConfig,
  KimiCliAgentProviderConfig,
  OpenCodeCliAgentProviderConfig,
  PiAgentProviderConfig,
} from '../../shared/agent-config.js';
import type { ProviderChildHealthSnapshot, ProviderWorkSnapshot } from '../../shared/snapshot.js';
import type { ProviderUsageInput } from '../../shared/agent-token-usage.js';

export type {
  AgentProviderConfig,
  ClaudeCodeAgentProviderConfig,
  CodexCliAgentProviderConfig,
  GrokCliAgentProviderConfig,
  KimiCliAgentProviderConfig,
  OpenCodeCliAgentProviderConfig,
  PiAgentProviderConfig,
};

export interface ProviderSessionRecord {
  id: string;
  updatedAt: string;
}

export function providerSessionPayload(
  session: ProviderSessionRecord | undefined,
  kind: string,
): Record<string, unknown> {
  return session ? { id: session.id, kind, resumed: true } : { kind, resumed: false };
}

export interface AgentRuntimeEffects {
  persistProviderSession(session: ProviderSessionRecord): Promise<void>;
  recordAgentText(text: string | undefined, payload?: Record<string, unknown>): Promise<void>;
  recordEvent(payload: Record<string, unknown>): Promise<void>;
  recordOutput(stream: 'stderr' | 'stdout', text: string): Promise<void>;
  recordUsage(usage: ProviderUsageInput): Promise<void>;
  recordRuntime(
    type: 'runtime.started' | 'runtime.completed' | 'runtime.failed',
    payload?: Record<string, unknown>,
  ): Promise<void>;
  recordToolFailed(payload: Record<string, unknown>): Promise<void>;
  recordToolStarted(payload: Record<string, unknown>): Promise<void>;
}

export interface AgentRuntimeInput {
  cwd: string;
  effects: AgentRuntimeEffects;
  env: NodeJS.ProcessEnv;
  onActivity?: () => void;
  prompt: string;
  providerSession?: ProviderSessionRecord;
  itemId: string;
  signal?: AbortSignal;
  suppressFailureRecord?: boolean;
  systemPrompt?: string;
  systemPromptFilePath?: string;
}

export interface AgentRuntimeResult {
  text?: string;
}

export interface AgentRuntimeFollowupInput {
  activeItemId: string;
  itemIds: string[];
  prompt: string;
}

export interface AgentRuntimeFollowupResult {
  accepted: boolean;
  retryable?: boolean;
  text?: string;
}

export interface AgentRuntimeDrainInput {
  activeItemId: string;
  signal?: AbortSignal;
}

export interface AgentRuntimeCloseOptions {
  forceAfterMs?: number;
  signal?: NodeJS.Signals;
}

export interface AgentRuntimeHealth {
  child?: ProviderChildHealthSnapshot;
  childExpected: boolean;
  providerWork?: ProviderWorkSnapshot;
}

export interface AgentRuntime {
  readonly env?: Record<string, string>;
  readonly kind: string;
  close?(options?: AgentRuntimeCloseOptions): Promise<void>;
  health?(): AgentRuntimeHealth;
  /**
   * Provider-owned background work (e.g. Claude background Bash tasks).
   * `undefined` means this runtime does not expose quiescence beyond the active
   * Anima item — config reload keeps the previous active-item-only behavior.
   */
  isProviderQuiescent?(): boolean | undefined;
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
  appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult>;
  requestDrain?(input: AgentRuntimeDrainInput): Promise<void>;
  /** Resolves when `isProviderQuiescent()` is true (or immediately if unsupported). */
  waitForProviderQuiescent?(signal?: AbortSignal): Promise<void>;
}
