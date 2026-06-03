import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { WakeQueueService, type InboxItem } from '../inbox/wake-queue.service.js';
import { isAppendedRunningInboxItem } from '../../shared/inbox.js';
import { clearRestartDrain, requestRestartDrain } from './restart-drain.js';

export const DEFAULT_RESTART_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 15 * 1000;
export const RESTART_IDLE_POLL_MS = 1000;

export interface RestartBlocker {
  agentId: string;
  item: InboxItem;
}

export type RestartBlockedReason = 'became_busy' | 'drain_timeout' | 'idle_timeout';

export class RestartBlockedError extends Error {
  constructor(
    readonly blockers: RestartBlocker[],
    readonly reason: RestartBlockedReason,
    message: string,
  ) {
    super(message);
    this.name = 'RestartBlockedError';
  }
}

export interface RestartDrainResult {
  fallbackToIdle: boolean;
  mode: 'drain-active';
  requestedCount: number;
  resumedCount: number;
  status: 'succeeded';
}

export async function waitForRestartIdle(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let loggedWait = false;
  while (true) {
    const blockers = await listRestartBlockers();
    if (blockers.length === 0) return;

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw restartBlockedError(blockers, 'Timed out waiting for agents to become idle.', 'idle_timeout');
    }

    if (!loggedWait) {
      console.error(`Waiting for agents to become idle before restart (timeout ${formatDurationMs(timeoutMs)}).`);
      loggedWait = true;
    }
    await sleep(Math.min(RESTART_IDLE_POLL_MS, timeoutMs - elapsedMs));
  }
}

export async function waitForRestartDrain(input: {
  drainTimeoutMs?: number;
  markerTtlMs?: number;
} = {}): Promise<RestartDrainResult> {
  const drainTimeoutMs = input.drainTimeoutMs ?? DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
  const startedAt = Date.now();
  await requestRestartDrain(input.markerTtlMs ?? drainTimeoutMs + 60_000);
  const initialRunning = await listRestartBlockers({ statuses: ['running'] });
  if (initialRunning.length === 0) {
    return { fallbackToIdle: true, mode: 'drain-active', requestedCount: 0, resumedCount: 0, status: 'succeeded' };
  }

  await Promise.all(initialRunning.map(({ agentId, item }) =>
    new WakeQueueService(agentId).requestDrain({ itemId: item.id, timeoutMs: drainTimeoutMs }),
  ));

  let loggedWait = false;
  while (true) {
    const blockers = await listRestartBlockers({ statuses: ['running'] });
    if (blockers.length === 0) {
      const resumedCount = await countRequeuedItems(initialRunning);
      return {
        fallbackToIdle: false,
        mode: 'drain-active',
        requestedCount: initialRunning.length,
        resumedCount,
        status: 'succeeded',
      };
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= drainTimeoutMs) {
      await clearRestartDrain().catch(() => {});
      await Promise.all(initialRunning.map(({ agentId, item }) =>
        new WakeQueueService(agentId).clearDrainRequest(item.id).catch(() => undefined),
      ));
      throw restartBlockedError(
        blockers,
        'Timed out waiting for running agents to reach a restart drain point.',
        'drain_timeout',
      );
    }

    if (!loggedWait) {
      console.error(`Waiting for running agents to drain before restart (timeout ${formatDurationMs(drainTimeoutMs)}).`);
      loggedWait = true;
    }
    await sleep(Math.min(RESTART_IDLE_POLL_MS, drainTimeoutMs - elapsedMs));
  }
}

export async function listRestartBlockers(options: {
  statuses?: InboxItem['handling']['status'][];
} = {}): Promise<RestartBlocker[]> {
  const statuses = new Set(options.statuses ?? ['queued', 'running']);
  const blockers: RestartBlocker[] = [];
  for (const agentId of await defaultAgentRegistryService.listAgentIds()) {
    for (const item of await new WakeQueueService(agentId).list()) {
      if (!statuses.has(item.handling.status)) continue;
      if (isAppendedRunningInboxItem(item)) continue;
      blockers.push({ agentId, item });
    }
  }
  return blockers.sort((a, b) =>
    blockerSortKey(a).localeCompare(blockerSortKey(b)),
  );
}

async function countRequeuedItems(blockers: RestartBlocker[]): Promise<number> {
  let count = 0;
  await Promise.all(blockers.map(async ({ agentId, item }) => {
    const current = await new WakeQueueService(agentId).find(item.id).catch(() => undefined);
    if (current?.handling.status === 'queued' && !current.handling.drainRequestedAt) count += 1;
  }));
  return count;
}

export function restartBlockedError(
  blockers: RestartBlocker[],
  prefix: string,
  reason: RestartBlockedReason,
): RestartBlockedError {
  return new RestartBlockedError(blockers, reason, [
    `${prefix} Restart blocked because agent inboxes are not idle:`,
    ...blockers.map(formatBlocker),
    'Use --force to restart anyway.',
  ].join('\n'));
}

export function formatBlocker({ agentId, item }: RestartBlocker): string {
  const handling = item.handling;
  const parts = [
    `agent=${agentId}`,
    `status=${handling.status}`,
    `item=${item.id}`,
    `since=${itemStatusAt(item)}`,
    handling.workerId ? `worker=${handling.workerId}` : undefined,
    itemSummary(item) ? `text=${JSON.stringify(itemSummary(item))}` : undefined,
  ].filter(Boolean);
  return `- ${parts.join(' ')}`;
}

export function restartBlockerInfo({ agentId, item }: RestartBlocker): {
  agentId: string;
  itemId: string;
  since: string;
  status: InboxItem['handling']['status'];
  summary?: string;
  workerId?: string;
} {
  return {
    agentId,
    itemId: item.id,
    since: itemStatusAt(item),
    status: item.handling.status,
    ...(itemSummary(item) ? { summary: itemSummary(item) } : {}),
    ...(item.handling.workerId ? { workerId: item.handling.workerId } : {}),
  };
}

function blockerSortKey(blocker: RestartBlocker): string {
  return `${blocker.agentId}:${itemStatusAt(blocker.item)}:${blocker.item.id}`;
}

function itemStatusAt(item: InboxItem): string {
  return item.handling.startedAt ?? item.handling.queuedAt ?? item.handling.updatedAt;
}

function itemSummary(item: InboxItem): string {
  if (item.kind === 'slack' || item.kind === 'onboarding') return truncate(item.text);
  if (item.kind === 'choice_response') {
    const actor = item.answeredBy.handle ?? item.answeredBy.displayName ?? item.answeredBy.slackUserId;
    return truncate(`${actor}: ${item.optionLabel}`);
  }
  return item.kind;
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
