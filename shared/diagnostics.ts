import type { AgentPlatformLabel, AgentTransportKind } from './agent-transports.js';
import type { AgentSessionSummary, AgentStatusSummary } from './snapshot.js';

export interface AgentDiagnosticsBundle {
  agent: AgentDiagnosticsAgent;
  generatedAt: string;
  logs: AgentDiagnosticsLogs;
  recentActivity: AgentDiagnosticsActivity[];
  recovery: {
    actions: AgentDiagnosticsRecoveryAction[];
  };
  redaction: {
    excluded: string[];
    logPolicy: string;
    mode: 'allowlist';
  };
  server: AgentDiagnosticsServer;
  session?: AgentDiagnosticsSession;
  status: AgentStatusSummary;
  workspace: AgentDiagnosticsWorkspace;
}

export interface AgentDiagnosticsAgent {
  displayName: string;
  enabled: boolean;
  homePath: string;
  id: string;
  platform?: {
    kind: AgentTransportKind;
    label: AgentPlatformLabel;
  };
  provider: {
    idleTimeoutMs?: number;
    kind: string;
    model?: string;
    reasoningEffort?: string;
  };
  transports: {
    feishu: AgentDiagnosticsTransport;
    slack: AgentDiagnosticsTransport;
  };
}

export interface AgentDiagnosticsTransport {
  configured: boolean;
  connected: boolean;
}

export interface AgentDiagnosticsServer {
  animaHome: string;
  commit?: string;
  dashboardPort: number;
  lastServicesRestart?: {
    blockerCount?: number;
    completedAt: string;
    interruptedCount?: number;
    mode?: string;
    reason?: string;
    requestedCount?: number;
    resumedCount?: number;
    status: string;
  };
  startedAt: string;
  track: string;
  uptimeSeconds: number;
  version: string;
}

export interface AgentDiagnosticsWorkspace {
  agentCount: number;
  health: {
    healthy: number;
    degraded: number;
    notExpected: number;
    starting: number;
    unhealthy: number;
    unknown: number;
  };
  runningCount: number;
}

export interface AgentDiagnosticsRecoveryAction {
  available: boolean;
  blockedReason?: string;
  id:
    | 'check_provider_settings'
    | 'copy_diagnostics'
    | 'disable'
    | 'enable'
    | 'restart_agent'
    | 'stop';
  label: string;
}

export interface AgentDiagnosticsActivity {
  activeItemId?: string;
  activityId: string;
  archivedCount?: number;
  createdAt: string;
  eventType?: string;
  failureSource?: string;
  maxRetries?: number;
  providerReason?: string;
  reason?: string;
  retryable?: boolean;
  retryAttempts?: number;
  runtimeKind?: string;
  status?: string;
  timeoutMs?: number;
  type: string;
}

export interface AgentDiagnosticsLogs {
  cappedAt: number;
  lines: AgentDiagnosticsLogLine[];
}

export interface AgentDiagnosticsLogLine {
  message: string;
  source: 'agent.log' | 'runtime-upgrade.log' | 'services-restart.log' | 'web.log';
  timestamp: string;
}

export interface AgentDiagnosticsSession {
  archivedCount: number;
  createdAt?: string;
  current?: AgentSessionSummary['current'];
  currentStartedAt?: string;
  latestProviderStats?: AgentSessionSummary['latestProviderStats'];
  lifetimeTokens?: number;
  updatedAt?: string;
}
