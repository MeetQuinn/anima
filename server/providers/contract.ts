import type {
  AgentProviderConfig,
  ClaudeCodeAgentProviderConfig,
  CodexCliAgentProviderConfig,
  GrokCliAgentProviderConfig,
  KimiCliAgentProviderConfig,
} from '../../shared/agent-config.js';
import type { ProviderChildHealthSnapshot } from '../../shared/snapshot.js';

export type {
  AgentProviderConfig,
  ClaudeCodeAgentProviderConfig,
  CodexCliAgentProviderConfig,
  GrokCliAgentProviderConfig,
  KimiCliAgentProviderConfig,
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
  prompt: string;
  itemId: string;
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
}

export interface AgentRuntime {
  readonly env?: Record<string, string>;
  readonly kind: string;
  close?(options?: AgentRuntimeCloseOptions): Promise<void>;
  health?(): AgentRuntimeHealth;
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
  appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult>;
  requestDrain?(input: AgentRuntimeDrainInput): Promise<void>;
}
