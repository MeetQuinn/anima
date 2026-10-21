import type {
  AgentHealthReason,
  AgentRuntimeHealthSummary,
} from '@shared/snapshot';

// How the web words an agent's runtime health (Activity banner, agent actions).

const RECOVERED_ACK_MS = 2_500;

export function agentHealthReasonText(reason: AgentHealthReason | undefined): string {
  switch (reason) {
    case 'provider_child_missing':
      return "This agent couldn't reconnect to its model. Restart the agent.";
    case 'provider_child_exited':
      return "This agent's model stopped unexpectedly. Restart the agent.";
    case 'provider_auth_failed':
      return "This agent can't reach its model. Check the model sign-in or API key in its provider settings.";
    case 'provider_quota_exhausted':
      return "This agent's model plan is out of capacity. Check your plan or quota with the model provider, and it should pick back up.";
    case 'provider_error':
      return "This agent ran into a problem with its model and couldn't complete its last turn.";
    case 'provider_rate_limited':
      return "This agent is being rate-limited by its model provider and can't complete work right now. It should recover on its own; if it keeps happening, check your plan's rate limits.";
    case 'restart_failed':
      return 'Restart failed. Try again or check the logs.';
    case 'restart_pending':
      return 'Restart pending.';
    case 'stale_running_item':
      return "The agent's current work has stalled. Restart the agent.";
    case 'start_failed':
      return "The agent couldn't start. Check its settings, or restart the agent.";
    default:
      return 'Health unavailable.';
  }
}

export function agentHealthDegradedText(reason: AgentHealthReason | undefined): string {
  switch (reason) {
    case 'provider_child_missing':
    case 'provider_child_exited':
      return 'This agent lost its connection to its model and is reconnecting.';
    case 'provider_rate_limited':
      return "This agent hit its model provider's rate limit and is retrying automatically.";
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
        description: "The model sign-in or API key isn't working.",
        kind: 'settings',
        label: 'Check provider settings',
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
