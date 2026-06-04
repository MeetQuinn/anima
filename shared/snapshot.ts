// API contract types for the web snapshot and agent activity view. Consumed by server and web.

export interface ProviderSessionRecord {
  id: string;
  kind: string;
  updatedAt: string;
}

export interface ArchivedProviderSessionRecord extends ProviderSessionRecord {
  archivedAt: string;
  archivedBy: 'operator';
  kind: string;
  note?: string;
}

export interface AgentStatusSummary {
  agentId: string;
  currentItemStartedAt?: string;
  currentItemId?: string;
  health?: AgentRuntimeHealthSummary;
  queueDepth: number;
  itemCount: number;
}

export type AgentHealthState = 'degraded' | 'healthy' | 'starting' | 'unhealthy' | 'unknown';

export type AgentHealthReason =
  | 'provider_child_missing'
  | 'provider_child_exited'
  | 'provider_auth_failed'
  | 'provider_quota_exhausted'
  | 'provider_error'
  | 'provider_rate_limited'
  | 'stale_running_item'
  | 'restart_pending'
  | 'restart_failed'
  | 'start_failed';

export type AgentRestartOutcome = 'pending' | 'recovered' | 'failed';

export interface ProviderChildHealthSnapshot {
  alive: boolean;
  command: string;
  exited: boolean;
  exitedAt?: string;
  exitCode?: number | null;
  label: string;
  lastStderrAt?: string;
  lastStdoutAt?: string;
  pid?: number;
  signal?: string | null;
  startedAt: string;
  stdinWritable: boolean;
}

export interface AgentRuntimeHandleSnapshot {
  activeItemId?: string;
  activeItemStartedAt?: string;
  processId?: number;
  providerChild?: ProviderChildHealthSnapshot;
  providerChildExpected: boolean;
  workerId?: string;
}

export interface AgentRestartStatusSummary {
  completedAt?: string;
  outcome: AgentRestartOutcome;
  providerChildPid?: number;
  reason?: AgentHealthReason;
  requestId: string;
  requestedAt: string;
  workerPid?: number;
}

export interface AgentRuntimeHealthSummary {
  reason?: AgentHealthReason;
  restart?: AgentRestartStatusSummary;
  runtime?: AgentRuntimeHandleSnapshot;
  state: AgentHealthState;
  updatedAt: string;
}

export interface AgentSessionSummary {
  archived?: ArchivedProviderSessionRecord[];
  createdAt: string;
  currentStartedAt?: string;
  latestProviderStats?: ProviderSessionStatsSummary;
  lifetimeTokens?: number;
  current?: ProviderSessionRecord;
  updatedAt: string;
}

export interface ProviderSessionStatsSummary {
  activityId: string;
  autoCompactWindow?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  contextWindow?: number;
  createdAt: string;
  currentContextTokens?: number;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  runtimeKind?: string;
  serviceTier?: string;
  sessionCompactionCount?: number;
  sessionTokenUsage?: number;
  terminalReason?: string;
  totalTokens?: number;
  usedTokens?: number;
}
