import type { AgentConfig } from '../../shared/agent-config.js';
import type {
  AgentHealthReason,
  AgentRuntimeHealthSummary,
  AgentStatusSummary,
} from '../../shared/snapshot.js';

type MrkdwnText = { type: 'mrkdwn'; text: string };
type PlainText = { type: 'plain_text'; text: string; emoji?: boolean };

type ShortcutModalBlock =
  | { type: 'section'; text: MrkdwnText }
  | { type: 'context'; elements: Array<MrkdwnText> }
  | { type: 'divider' };

export type ShortcutModalView = {
  blocks: ShortcutModalBlock[];
  callback_id?: string;
  close?: PlainText;
  private_metadata?: string;
  submit?: PlainText;
  title: PlainText;
  type: 'modal';
};

export interface ShortcutModalInput {
  callbackId?: string;
  close?: string;
  context?: string;
  lines: string[];
  privateMetadata?: string;
  submit?: string;
  title: string;
}

/** Slack caps a modal title at 24 characters. */
const MODAL_TITLE_LIMIT = 24;

/**
 * The Home shortcut: a read-only glance that anyone in the workspace can open.
 * It deliberately carries no controls (stopping an agent is the operator's
 * call, made from the dashboard) and no conversation detail (naming the
 * channel or DM the agent is working on would leak it to whoever opens this).
 */
export function homeView(
  agent: AgentConfig,
  status: AgentStatusSummary,
  now: Date,
): ShortcutModalView {
  const blocks: ShortcutModalBlock[] = [];

  const role = agent.profile.role.trim();
  const about = [
    ...(role ? [escapeMrkdwn(role)] : []),
    ...(agent.owner ? [`Owner: <@${agent.owner.slackUserId}>`] : []),
  ];
  if (about.length > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: about.join('  ·  ') }] });
    blocks.push({ type: 'divider' });
  }

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: homeStatusText(status, now) } });

  return {
    blocks,
    close: { text: 'Close', type: 'plain_text' },
    title: { text: modalTitle(agent.profile.displayName), type: 'plain_text' },
    type: 'modal',
  };
}

interface HealthIssue {
  detail?: string;
  emoji: string;
  label: string;
  rateLimited: boolean;
}

/**
 * One status line, plus a plain sentence when something needs explaining.
 * Health problems take the headline: without them an agent that cannot reach
 * its model reads as "Idle", as if it were simply ignoring people.
 */
function homeStatusText(status: AgentStatusSummary, now: Date): string {
  const busy = Boolean(status.currentItemId);
  const waiting = status.queueDepth;
  const issue = healthIssue(status.health);
  const retryAt = nextRetryAt(status, now);

  const headline: string[] = [];
  const details: string[] = [];
  if (issue) {
    headline.push(`${issue.emoji}  *${issue.label}*`);
    if (issue.detail) details.push(issue.detail);
  } else if (busy) {
    headline.push(':gear:  *Working*');
    if (status.currentItemStartedAt) headline.push(elapsedLabel(status.currentItemStartedAt, now));
  } else if (retryAt) {
    headline.push(':double_vertical_bar:  *Rate-limited*');
  } else if (waiting > 0) {
    headline.push(':hourglass_flowing_sand:  *Queued*');
  } else {
    headline.push(':white_check_mark:  *Idle*');
  }
  if (waiting > 0) headline.push(busy ? `${waiting} more waiting` : `${waiting} waiting`);

  // Deferred wakes are gated by a provider rate limit; say when they resume,
  // unless a different problem (a failed sign-in, say) would make that a promise.
  if (retryAt && (!issue || issue.rateLimited)) {
    details.push(`Picks back up ${slackLocalTime(retryAt)}.`);
  }

  return [headline.join('  ·  '), ...details].join('\n');
}

/** Mirrors the dashboard's health precedence (AgentHealthIndicator), worded for teammates. */
function healthIssue(health: AgentRuntimeHealthSummary | undefined): HealthIssue | undefined {
  if (!health) return undefined;
  if (health.state === 'starting') {
    return {
      emoji: ':arrows_counterclockwise:',
      label: health.reason === 'restart_pending' ? 'Restarting' : 'Starting',
      rateLimited: false,
    };
  }
  const restartFailed = health.state !== 'healthy' && health.restart?.outcome === 'failed';
  if (health.state === 'unhealthy' || restartFailed) {
    const reason = restartFailed ? health.restart?.reason ?? health.reason : health.reason;
    return {
      detail: needsAttentionText(reason),
      emoji: ':warning:',
      label: 'Needs attention',
      rateLimited: reason === 'provider_rate_limited',
    };
  }
  if (health.state === 'degraded') {
    return {
      detail: retryingText(health.reason),
      emoji: ':arrows_counterclockwise:',
      label: 'Retrying',
      rateLimited: health.reason === 'provider_rate_limited',
    };
  }
  return undefined;
}

function needsAttentionText(reason: AgentHealthReason | undefined): string {
  switch (reason) {
    case 'provider_auth_failed':
      return "It can't reach its model. Its owner needs to check the model sign-in.";
    case 'provider_quota_exhausted':
      return "Its model plan is out of capacity, so it can't work until the plan has room again.";
    case 'provider_rate_limited':
      return 'Its model provider is rate-limiting it. It should recover on its own.';
    case 'provider_error':
      return "It ran into a problem with its model and couldn't finish its last turn.";
    case 'provider_child_missing':
      return 'It lost its connection to its model. Its owner needs to restart it.';
    case 'provider_child_exited':
      return 'Its model stopped unexpectedly. Its owner needs to restart it.';
    case 'stale_running_item':
      return 'Its current work has stalled. Its owner needs to restart it.';
    case 'start_failed':
      return "It couldn't start. Its owner needs to check its settings.";
    case 'restart_failed':
      return 'Its restart failed. Its owner needs to try again or check the logs.';
    default:
      return 'Its owner needs to check it in the Anima dashboard.';
  }
}

function retryingText(reason: AgentHealthReason | undefined): string {
  switch (reason) {
    case 'provider_rate_limited':
      return "Its model provider is rate-limiting it. It's retrying automatically.";
    case 'provider_child_missing':
    case 'provider_child_exited':
      return 'It lost its connection to its model and is reconnecting.';
    default:
      return "It's retrying automatically.";
  }
}

function nextRetryAt(status: AgentStatusSummary, now: Date): number | undefined {
  const future = (status.deferredWakes ?? [])
    .map((wake) => Date.parse(wake.notBefore))
    .filter((ms) => Number.isFinite(ms) && ms > now.getTime());
  return future.length > 0 ? Math.min(...future) : undefined;
}

/** Slack renders `<!date>` in each viewer's own time zone; the fallback is UTC. */
function slackLocalTime(ms: number): string {
  const fallback = `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} at {time}|${fallback}>`;
}

function modalTitle(displayName: string): string {
  const name = displayName.trim() || 'Home';
  const chars = Array.from(name);
  return chars.length <= MODAL_TITLE_LIMIT
    ? name
    : `${chars.slice(0, MODAL_TITLE_LIMIT - 1).join('')}…`;
}

export function shortcutModal(input: ShortcutModalInput): ShortcutModalView {
  type LegacyBlock =
    | { type: 'section'; text: MrkdwnText }
    | { type: 'context'; elements: Array<MrkdwnText> };
  const blocks: LegacyBlock[] = [
    ...input.lines.map((line): { type: 'section'; text: MrkdwnText } => ({
      text: { text: line, type: 'mrkdwn' },
      type: 'section',
    })),
    ...(input.context ? [{
      elements: [{ text: input.context, type: 'mrkdwn' as const }],
      type: 'context' as const,
    }] : []),
  ];
  return {
    blocks,
    ...(input.callbackId ? { callback_id: input.callbackId } : {}),
    close: { text: input.close ?? 'Close', type: 'plain_text' },
    ...(input.privateMetadata ? { private_metadata: input.privateMetadata } : {}),
    ...(input.submit ? { submit: { text: input.submit, type: 'plain_text' } } : {}),
    title: { text: input.title.slice(0, 24), type: 'plain_text' },
    type: 'modal',
  };
}

function elapsedLabel(startedAt: string, now: Date): string {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return 'elapsed unknown';
  const seconds = Math.max(0, Math.floor((now.getTime() - startedMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export function escapeMrkdwn(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
