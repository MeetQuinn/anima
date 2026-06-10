import { WakeQueueService, type InboxItem } from '../inbox/wake-queue.service.js';
import { isPrimaryRunningInboxItem } from '../../shared/inbox.js';

export interface ActiveRuntimeItemRecord {
  agentId: string;
  settledAt?: string;
  startedAt?: string;
  itemId: string;
  updatedAt: string;
  workerId: string;
}

export interface ActiveRuntimeItemQueue {
  list(): Promise<InboxItem[]>;
  markRunning(input: {
    itemId: string;
    startedAt?: string;
    workerId: string;
  }): Promise<InboxItem>;
  markSettled(input: {
    itemId: string;
    workerId: string;
  }): Promise<InboxItem | undefined>;
}

// Tool processes can outlive the provider call by a few moments; keep a short
// settled pointer so Slack output can still resolve recent channel context.
const TOOL_AUDIT_SETTLED_ITEM_GRACE_MS = 2 * 60 * 1000;

export async function setActiveRuntimeItem(input: {
  agentId: string;
  itemId: string;
  startedAt?: string;
  workerId: string;
}, queue: ActiveRuntimeItemQueue = new WakeQueueService(input.agentId)): Promise<void> {
  await queue.markRunning(input);
}

export async function clearActiveRuntimeItem(input: {
  agentId: string;
  itemId: string;
  workerId: string;
}, queue: ActiveRuntimeItemQueue = new WakeQueueService(input.agentId)): Promise<void> {
  await queue.markSettled(input);
}

export async function findActiveRuntimeItem(
  agentId: string,
  queue: Pick<ActiveRuntimeItemQueue, 'list'> = new WakeQueueService(agentId),
): Promise<ActiveRuntimeItemRecord | undefined> {
  const running = (await queue.list())
    .filter((event) => isPrimaryRunningInboxItem(event) && event.handling.workerId && !event.handling.settledAt)
    .sort((a, b) => (b.handling.startedAt ?? b.handling.updatedAt).localeCompare(a.handling.startedAt ?? a.handling.updatedAt))[0];
  if (!running?.handling.workerId) return undefined;
  return runtimeRecordFromEvent(agentId, running);
}

export async function findToolAuditRuntimeItem(
  agentId: string,
  queue: Pick<ActiveRuntimeItemQueue, 'list'> = new WakeQueueService(agentId),
): Promise<ActiveRuntimeItemRecord | undefined> {
  const candidates = (await queue.list())
    .filter((event) => event.handling.workerId);
  const running = candidates
    .filter((event) => isPrimaryRunningInboxItem(event) && !event.handling.settledAt)
    .sort((a, b) => (b.handling.startedAt ?? b.handling.updatedAt).localeCompare(a.handling.startedAt ?? a.handling.updatedAt))[0];
  if (running) return runtimeRecordFromEvent(agentId, running);

  const settledCandidates = candidates
    .filter((event) => event.handling.status === 'completed' || event.handling.status === 'failed')
    .sort((a, b) => b.handling.updatedAt.localeCompare(a.handling.updatedAt));
  for (const event of settledCandidates) {
    const record = runtimeRecordFromEvent(agentId, event);
    if (!record.settledAt) continue;
    if (Date.now() - Date.parse(record.settledAt) > TOOL_AUDIT_SETTLED_ITEM_GRACE_MS) continue;
    return record;
  }
  return undefined;
}

function runtimeRecordFromEvent(agentId: string, event: InboxItem): ActiveRuntimeItemRecord {
  const handling = event.handling;
  if (!handling.workerId) throw new Error(`Wake queue item ${event.id} has no workerId.`);
  return {
    agentId,
    ...(handling.settledAt ? { settledAt: handling.settledAt } : {}),
    ...(handling.startedAt ? { startedAt: handling.startedAt } : {}),
    itemId: event.id,
    updatedAt: handling.updatedAt,
    workerId: handling.workerId,
  };
}
