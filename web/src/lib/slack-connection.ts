import type { AgentRuntimeHealthSummary } from '@shared/snapshot';

const ATTENTION_AFTER_MS = 5 * 60_000;
const SNAPSHOT_STALE_MS = 30_000;

export function slackConnectionDisplay(
  health: AgentRuntimeHealthSummary | undefined,
  now = Date.now(),
  revalidatingCachedAt?: number,
) {
  const connection = health?.runtime?.transports?.slack;
  if (!connection) return undefined;
  const stale = now - Date.parse(connection.observedAt) > SNAPSHOT_STALE_MS;
  if (
    health?.reason !== 'start_failed' &&
    stale &&
    connection.state === 'connected' &&
    revalidatingCachedAt !== undefined &&
    revalidatingCachedAt - Date.parse(connection.observedAt) <= SNAPSHOT_STALE_MS
  ) {
    return undefined;
  }
  if (health?.reason === 'start_failed' || stale) {
    return {
      label: 'Slack status unavailable',
      detail:
        health?.reason === 'start_failed'
          ? 'The agent failed to start, so Slack isn’t connected.'
          : 'Slack status hasn’t updated recently. Check that the agent is running.',
      severity: 'warning' as const,
    };
  }
  if (connection.state === 'connected') {
    return {
      label: 'Slack connected',
      detail: 'Slack is connected and listening for new messages.',
      severity: 'normal' as const,
    };
  }
  const duration = connection.disconnectedAt
    ? `Disconnected for ${elapsed(now - Date.parse(connection.disconnectedAt))}. `
    : '';
  const reason = connection.reason ? `Last error: ${connection.reason}. ` : '';
  if (connection.state === 'failed') {
    return {
      label: 'Slack disconnected',
      detail: `${duration}${reason}Automatic retries stopped. Check Slack in Profile.`,
      severity: 'error' as const,
    };
  }
  if (connection.state === 'stopped') {
    return {
      label: 'Slack stopped',
      detail: 'Not listening for Slack messages.',
      severity: 'warning' as const,
    };
  }
  const attention =
    connection.disconnectedAt && now - Date.parse(connection.disconnectedAt) >= ATTENTION_AFTER_MS;
  const attempts =
    connection.attempts > 0
      ? `${connection.attempts} connection ${connection.attempts === 1 ? 'attempt' : 'attempts'}. `
      : '';
  const retry =
    connection.retryAt && Date.parse(connection.retryAt) > now
      ? `Next retry in ${elapsed(Date.parse(connection.retryAt) - now)}.`
      : 'Connecting now.';
  return {
    label: attention
      ? 'Slack disconnected'
      : connection.state === 'connecting'
        ? 'Slack connecting'
        : 'Slack reconnecting',
    detail: `${duration}${reason}${attempts}${retry}`,
    severity: attention ? ('error' as const) : ('warning' as const),
  };
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}
