import { isPrimaryRunningInboxItem, type InboxItem } from '../../shared/inbox.js';
import { errorMessage } from '../ids.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { WakeQueueStore } from '../storage/schema/wake-queue.store.js';

export type { InboxItem };

export interface WakeQueueEnqueueResult {
  duplicate: boolean;
  item: InboxItem;
  queued: boolean;
}

export interface WakeQueueMessageRecorder {
  legacyBackfilled?(): Promise<boolean>;
  recordInboxItem(item: InboxItem): Promise<unknown>;
}

interface WakeQueueLogger {
  warn(message: string): void;
}

const WAKE_QUEUE_SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class WakeQueueService {
  constructor(
    readonly agentId: string,
    private readonly store: WakeQueueStore = new WakeQueueStore(agentId),
    private readonly messages: WakeQueueMessageRecorder = messageServiceForAgent(agentId),
    private readonly logger: WakeQueueLogger = console,
  ) {}

  async enqueue(event: InboxItem): Promise<WakeQueueEnqueueResult> {
    const result = await this.store.insertIfAbsent(event);
    await this.recordMessage(result.item);
    await this.pruneOldSettled();
    return {
      duplicate: !result.inserted,
      item: result.item,
      queued: result.inserted,
    };
  }

  find(itemId: string): Promise<InboxItem | undefined> {
    return this.store.find(itemId);
  }

  replaceItem(item: InboxItem): Promise<InboxItem> {
    return this.store.replaceItem(item);
  }

  list(): Promise<InboxItem[]> {
    return this.store.list();
  }

  listRunnable(): Promise<InboxItem[]> {
    return this.store.listRunnable();
  }

  async claimNext(workerId: string): Promise<InboxItem | undefined> {
    const items = await this.listRunnable();
    if (items.some((item) => isPrimaryRunningInboxItem(item))) return undefined;
    return this.claimFirstQueued(workerId, items);
  }

  async claimNextFollowup(input: {
    activeItemId: string;
    excludedItemIds?: Iterable<string>;
    workerId: string;
  }): Promise<InboxItem | undefined> {
    const runnable = await this.listRunnable();
    const activeItem = runnable.find((item) => item.id === input.activeItemId);
    if (!activeItem || activeItem.handling.status !== 'running' || activeItem.handling.workerId !== input.workerId) {
      return undefined;
    }

    const excludedItemIds = new Set(input.excludedItemIds ?? []);
    const items = runnable
      .filter((item) => item.handling.status === 'queued' && !excludedItemIds.has(item.id));
    return this.claimFirstQueued(input.workerId, items);
  }

  async recoverInterrupted(input: {
    currentWorkerId?: string;
    isWorkerAlive: (workerId: string) => boolean;
    now?: Date;
    staleRunningMs?: number;
  }): Promise<InboxItem[]> {
    const recovered: InboxItem[] = [];
    const nowMs = input.now?.getTime() ?? Date.now();
    for (const item of await this.listRunnable()) {
      if (item.handling.status !== 'running') continue;
      const workerAlive = item.handling.workerId ? input.isWorkerAlive(item.handling.workerId) : false;
      const workerReplaced = workerChangedInCurrentProcess(item.handling.workerId, input.currentWorkerId);
      if (workerAlive && !workerReplaced && !staleRunningItem(item, nowMs, input.staleRunningMs)) continue;
      await this.store.requeue(item.id, {
        ...(item.handling.drainRequestedAt ? { resumeReason: 'runtime_restart' as const } : {}),
      });
      const updated = await this.find(item.id);
      if (updated?.handling.status === 'queued') recovered.push(updated);
    }
    return recovered;
  }

  async complete(itemId: string): Promise<void> {
    await this.store.complete(itemId);
    await this.pruneOldSettled();
  }

  async completeAppendedTo(parentItemId: string): Promise<InboxItem[]> {
    const items = await this.store.completeAppendedTo(parentItemId);
    await this.pruneOldSettled();
    return items;
  }

  async fail(itemId: string): Promise<void> {
    await this.store.fail(itemId);
    await this.pruneOldSettled();
  }

  async failAppendedTo(parentItemId: string): Promise<InboxItem[]> {
    const items = await this.store.failAppendedTo(parentItemId);
    await this.pruneOldSettled();
    return items;
  }

  requeue(itemId: string, options: { resumeReason?: 'runtime_restart' } = {}): Promise<void> {
    return this.store.requeue(itemId, options);
  }

  requeueAppendedTo(
    parentItemId: string,
    options: { resumeReason?: 'runtime_restart' } = {},
  ): Promise<InboxItem[]> {
    return this.store.requeueAppendedTo(parentItemId, options);
  }

  requestStop(itemId: string): Promise<InboxItem> {
    return this.store.requestStop(itemId);
  }

  requestDrain(input: {
    itemId: string;
    timeoutMs: number;
  }): Promise<InboxItem> {
    return this.store.requestDrain(input);
  }

  clearDrainRequest(itemId: string): Promise<InboxItem> {
    return this.store.clearDrainRequest(itemId);
  }

  markRunning(input: {
    itemId: string;
    startedAt?: string;
    workerId: string;
  }): Promise<InboxItem> {
    return this.store.markRunning(input);
  }

  markAppended(input: {
    itemId: string;
    parentItemId: string;
    workerId: string;
  }): Promise<InboxItem> {
    return this.store.markAppended(input);
  }

  async markSettled(input: {
    itemId: string;
    workerId: string;
  }): Promise<InboxItem | undefined> {
    const item = await this.store.markSettled(input);
    await this.pruneOldSettled();
    return item;
  }

  private async claimFirstQueued(workerId: string, items: InboxItem[]): Promise<InboxItem | undefined> {
    for (const item of items) {
      if (item.handling.status !== 'queued') continue;
      const claimed = await this.store.claimQueued({ itemId: item.id, workerId });
      if (claimed) return claimed;
    }
    return undefined;
  }

  private async recordMessage(item: InboxItem): Promise<void> {
    try {
      await this.messages.recordInboxItem(item);
    } catch (error) {
      this.logger.warn(`Wake queue message ledger write failed for item ${item.id}: ${errorMessage(error)}`);
    }
  }

  private async pruneOldSettled(): Promise<void> {
    if (!this.messages.legacyBackfilled) return;
    try {
      if (!await this.messages.legacyBackfilled()) return;
      const cutoffIso = new Date(Date.now() - WAKE_QUEUE_SETTLED_RETENTION_MS).toISOString();
      await this.store.pruneSettledBefore(cutoffIso);
    } catch (error) {
      this.logger.warn(`Wake queue retention failed for ${this.agentId}: ${errorMessage(error)}`);
    }
  }
}

function workerChangedInCurrentProcess(
  itemWorkerId: string | undefined,
  currentWorkerId: string | undefined,
): boolean {
  if (!itemWorkerId || !currentWorkerId || itemWorkerId === currentWorkerId) return false;
  const itemPid = workerPid(itemWorkerId);
  const currentPid = workerPid(currentWorkerId);
  return itemPid !== undefined && itemPid === currentPid;
}

function workerPid(workerId: string): number | undefined {
  const pidText = workerId.split(':').at(-1);
  const pid = pidText ? Number.parseInt(pidText, 10) : Number.NaN;
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function staleRunningItem(item: InboxItem, nowMs: number, staleRunningMs: number | undefined): boolean {
  if (staleRunningMs === undefined || staleRunningMs <= 0) return false;
  const startedAtMs = Date.parse(item.handling.startedAt ?? item.handling.updatedAt);
  const updatedAtMs = Date.parse(item.handling.updatedAt);
  if (Number.isNaN(startedAtMs) || Number.isNaN(updatedAtMs)) return false;
  return nowMs - startedAtMs >= staleRunningMs && nowMs - updatedAtMs >= staleRunningMs;
}
