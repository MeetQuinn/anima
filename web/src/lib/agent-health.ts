import type {
  AgentHealthReason,
  AgentRuntimeHealthSummary,
} from '@shared/snapshot';

// How the web words an agent's runtime health (Activity banner, agent actions).

const RECOVERED_ACK_MS = 2_500;

export function agentHealthReasonText(reason: AgentHealthReason | undefined): string {
  switch (reason) {
    case 'provider_child_missing':
      return "This agent couldn't reconnect to its provider. Restart the agent.";
    case 'provider_child_exited':
      return "This agent's provider stopped unexpectedly. Restart the agent.";
    case 'provider_auth_failed':
      return "This agent can't authenticate with its provider. Check sign-in in Settings → Providers or your CLI credentials.";
    case 'provider_quota_exhausted':
      return 'Provider quota reached. Work will resume once your plan resets or you add capacity.';
    case 'provider_error':
      return "This agent hit a provider error and couldn't finish its last turn.";
    case 'provider_rate_limited':
      return 'Rate-limited by the provider. It will recover once the limit clears; if this persists, check your plan limits.';
    case 'restart_failed':
      return 'Restart failed. Try again or check the logs.';
    case 'restart_pending':
      return 'Restart pending.';
    case 'stale_running_item':
      return "This agent's current work has stalled. Restart the agent.";
    case 'start_failed':
      return "This agent couldn't start. Check its runtime settings or restart the agent.";
    default:
      return 'Health unavailable.';
  }
}

export function agentHealthDegradedText(reason: AgentHealthReason | undefined): string {
  switch (reason) {
    case 'provider_child_missing':
    case 'provider_child_exited':
      return 'This agent lost connection to its provider and is reconnecting.';
    case 'provider_rate_limited':
      return "This agent hit the provider's rate limit and is retrying automatically.";
    default:
      return 'This agent is retrying automatically.';
  }
}

export function agentHealthProviderAction(health: AgentRuntimeHealthSummary | undefined): {
  description: string;
  kind: 'settings';
  label: string;
} | null {
  switch (activeHealthReason(health)) {
    case 'provider_auth_failed':
      return {
        description: 'Provider sign-in failed or credentials expired.',
        kind: 'settings',
        label: 'Open Providers',
      };
    default:
      return null;
  }
}

export function agentHealthBlocksRestart(health: AgentRuntimeHealthSummary | undefined): boolean {
  if (health?.state === 'degraded') return true;
  const reason = activeHealthReason(health);
  return reason === 'provider_auth_failed'
    || reason === 'provider_quota_exhausted'
    || reason === 'provider_rate_limited';
}

export function agentHealthSummaryText(health: AgentRuntimeHealthSummary | undefined): string | null {
  if (!health) return null;
  if (agentHealthRecoveredFresh(health, Date.now())) return 'Recovered';
  if (health.state !== 'healthy' && health.restart?.outcome === 'failed') {
    return agentHealthReasonText(health.restart.reason ?? health.reason);
  }
  if (health.state === 'starting') return health.reason === 'restart_pending' ? 'Restart pending' : 'Starting';
  if (health.state === 'degraded') return agentHealthDegradedText(health.reason);
  if (health.state === 'unhealthy') return agentHealthReasonText(health.reason);
  if (health.state === 'unknown') return 'Health unavailable';
  return null;
}

function activeHealthReason(health: AgentRuntimeHealthSummary | undefined): AgentHealthReason | undefined {
  if (!health) return undefined;
  if (health.state !== 'healthy' && health.restart?.outcome === 'failed') {
    return health.restart.reason ?? health.reason;
  }
  if (health.state === 'unhealthy') return health.reason;
  return undefined;
}

export function agentHealthRecoveredFresh(health: AgentRuntimeHealthSummary, now: number): boolean {
  if (health.state !== 'healthy') return false;
  if (health.restart?.outcome !== 'recovered' || !health.restart.completedAt) return false;
  const completedAt = Date.parse(health.restart.completedAt);
  return Number.isFinite(completedAt) && now - completedAt < RECOVERED_ACK_MS;
}
