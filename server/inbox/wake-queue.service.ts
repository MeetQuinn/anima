import type { InboxItem } from '../../shared/inbox.js';
import { errorMessage } from '../ids.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { WakeQueueStore, type TakeNextRunnableInput } from '../storage/schema/wake-queue.store.js';

export type { InboxItem };

export interface WakeQueueEnqueueResult {
  duplicate: boolean;
  item: InboxItem;
  queued: boolean;
}

export interface WakeQueueMessageRecorder {
  hasInboxItem?(itemId: string): Promise<boolean>;
  recordInboxItem(item: InboxItem): Promise<{ inserted: boolean } | undefined>;
}

interface WakeQueueLogger {
  warn(message: string): void;
}

export const wakeQueueServiceForAgent = (agentId: string): WakeQueueService =>
  new WakeQueueService(agentId);

export class WakeQueueService {
  constructor(
    readonly agentId: string,
    private readonly store: WakeQueueStore = new WakeQueueStore(agentId),
    private readonly messages: WakeQueueMessageRecorder = messageServiceForAgent(agentId),
    private readonly logger: WakeQueueLogger = console,
  ) {}

  /**
   * Enqueue with the wake-queue file as the dedupe authority: the insert
   * atomically checks active items plus settled seen markers, so a crash
   * between steps can no longer drop a wake. The message ledger is written
   * after the item is safely queued — it is conversation history, not dedupe
   * state — with one legacy exception: ids settled before seen markers
   * existed are only known to the ledger, so a ledger hit withdraws the
   * just-queued item (or, if a worker already claimed it, lets it run once).
   */
  async enqueue(event: InboxItem): Promise<WakeQueueEnqueueResult> {
    const result = await this.store.insertIfAbsent(event);
    if (!result.inserted) {
      await this.recordMessage(event);
      return { duplicate: true, item: result.item, queued: false };
    }
    const recorded = await this.recordMessage(event);
    if (recorded?.inserted === false) {
      const withdrawn = await this.store.withdrawQueued(event.id);
      if (withdrawn) return { duplicate: true, item: withdrawn, queued: false };
    }
    return { duplicate: false, item: result.item, queued: true };
  }

  async hasSeen(itemId: string): Promise<boolean> {
    if (await this.store.has(itemId)) return true;
    try {
      return Boolean(await this.messages.hasInboxItem?.(itemId));
    } catch (error) {
      this.logger.warn(`Wake queue message ledger lookup failed for item ${itemId}: ${errorMessage(error)}`);
      return false;
    }
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

  /** @deprecated Post-#377 the queue only stores runnable work; same as list(). */
  listRunnable(): Promise<InboxItem[]> {
    return this.store.list();
  }

  async takeNextRunnable(input: TakeNextRunnableInput): Promise<InboxItem | undefined> {
    return (await this.store.takeNextRunnable(input)).item;
  }

  async takeNextFollowup(input: {
    activeItemId: string;
    excludedItemIds?: Iterable<string>;
    workerId: string;
  }): Promise<InboxItem | undefined> {
    const items = await this.list();
    const activeItem = items.find((item) => item.id === input.activeItemId);
    if (!activeItem || activeItem.handling.status !== 'running' || activeItem.handling.workerId !== input.workerId) {
      return undefined;
    }

    const excludedItemIds = new Set(input.excludedItemIds ?? []);
    const queued = items
      .filter((item) => item.handling.status === 'queued' && !excludedItemIds.has(item.id));
    return this.takeFirstQueued(input.workerId, queued);
  }

  async complete(itemId: string): Promise<void> {
    await this.store.complete(itemId);
  }

  async completeAppendedTo(parentItemId: string): Promise<InboxItem[]> {
    return this.store.completeAppendedTo(parentItemId);
  }

  async fail(itemId: string): Promise<void> {
    await this.store.fail(itemId);
  }

  async failAppendedTo(parentItemId: string): Promise<InboxItem[]> {
    return this.store.failAppendedTo(parentItemId);
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
    return this.store.markSettled(input);
  }

  private async takeFirstQueued(workerId: string, items: InboxItem[]): Promise<InboxItem | undefined> {
    for (const item of items) {
      if (item.handling.status !== 'queued') continue;
      const taken = await this.store.takeQueued({ itemId: item.id, workerId });
      if (taken) return taken;
    }
    return undefined;
  }

  private async recordMessage(item: InboxItem): Promise<{ inserted: boolean } | undefined> {
    try {
      return await this.messages.recordInboxItem(item);
    } catch (error) {
      this.logger.warn(`Wake queue message ledger write failed for item ${item.id}: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
