import type { AgentStatusSummary, LinearConnectionSummary } from '@shared/snapshot';
import { formatRelativeShort } from './format';
import { slackConnectionDisplay } from './slack-connection';

export interface ConnectionDisplay {
  label: string;
  detail: string;
  severity: 'normal' | 'warning' | 'error';
}

// Linear has no connection of its own: it posts webhooks. What can stop an agent hearing
// it is the installation (revoked, credentials rejected) or the machine's listener, the
// same states the Linear row in Profile calls out.
export function linearConnectionDisplay(
  linear: LinearConnectionSummary | undefined,
  now = Date.now(),
): ConnectionDisplay | undefined {
  if (!linear) return undefined;
  if (linear.state === 'revoked') {
    return {
      label: 'Linear access revoked',
      detail: 'Linear access was revoked. Authorize again from Linear in Profile.',
      severity: 'error',
    };
  }
  if (linear.clientRejected) {
    return {
      label: 'Linear credentials not accepted',
      detail: 'Linear didn’t accept this app’s credentials when renewing access. Check them under Linear in Profile.',
      severity: 'error',
    };
  }
  if (linear.listener === 'failed') {
    return {
      label: 'Linear not receiving',
      detail: 'Anima can’t receive Linear events: the local listener failed. See Linear in Profile.',
      severity: 'error',
    };
  }
  return {
    label: 'Linear connected',
    detail: linear.lastSignedWebhookAt
      ? `Last event ${formatRelativeShort(linear.lastSignedWebhookAt, new Date(now))}.`
      : 'No Linear events received yet.',
    severity: 'normal',
  };
}

const RANK = { normal: 0, warning: 1, error: 2 } as const;

/**
 * The agent's connection line across platforms. When something needs attention, it names
 * every platform with a problem, the most severe first, and the severity is the worst one.
 * Otherwise it is the first platform's normal line, so callers can keep hiding "normal".
 */
export function agentConnectionDisplay(
  status: Pick<AgentStatusSummary, 'health' | 'linear'> | undefined,
  now = Date.now(),
  revalidatingCachedAt?: number,
): ConnectionDisplay | undefined {
  const all = [
    slackConnectionDisplay(status?.health, now, revalidatingCachedAt),
    linearConnectionDisplay(status?.linear, now),
  ].filter((display): display is ConnectionDisplay => display !== undefined);
  const problems = all
    .filter((display) => display.severity !== 'normal')
    .sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  if (problems.length === 0) return all[0];
  if (problems.length === 1) return problems[0];
  return {
    label: problems.map((display) => display.label).join(' · '),
    detail: problems.map((display) => display.detail).join(' '),
    severity: problems[0]!.severity,
  };
}
