import type { InboxItem } from '../../shared/inbox.js';
import { isClaimableQueuedInboxItem } from '../../shared/inbox.js';
import { errorMessage } from '../ids.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { WakeQueueStore, type TakeNextRunnableInput } from '../storage/schema/wake-queue.store.js';
import { signalWake } from './wake-signal.js';

export type { InboxItem };

export interface WakeQueueEnqueueResult {
  duplicate: boolean;
  item: InboxItem;
  queued: boolean;
  /** True when the item is durable but not yet claimable (preflight publish path). */
  staged?: boolean;
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
    signalWake(this.agentId);
    return { duplicate: false, item: result.item, queued: true };
  }

  /**
   * Durable insert that workers cannot claim yet (`handling.stagedAt` set).
   * No wake signal and no message-ledger write (uncommitted stages must not
   * create phantom history or seen tombstones). Pair with `publishQueued`
   * after CAS, or `abandonStaged` to drop without tombstoning. Reuses an
   * existing still-staged row for the same id (crash recovery mid path).
   */
  async enqueueStaged(event: InboxItem): Promise<WakeQueueEnqueueResult> {
    const receivedAt = event.receivedAt;
    const staged: InboxItem = {
      ...event,
      handling: {
        ...event.handling,
        stagedAt: event.handling.stagedAt ?? receivedAt,
        status: 'queued',
      },
    };
    const result = await this.store.insertIfAbsent(staged);
    if (!result.inserted) {
      const existing = result.item;
      // Prior crash left the same fire id staged — continue the publish path.
      if (
        existing.handling.status === 'queued'
        && existing.handling.stagedAt
        && !existing.handling.workerId
      ) {
        return { duplicate: false, item: existing, queued: true, staged: true };
      }
      // Seen tombstone or already-active row for this id.
      return { duplicate: true, item: existing, queued: false, staged: false };
    }
    // Intentionally no signalWake and no message ledger until publish.
    return { duplicate: false, item: result.item, queued: true, staged: true };
  }

  /**
   * Publish a staged row for claim: clear stagedAt, write message ledger, signal.
   * Returns false when the item is missing, already published, or no longer queued.
   */
  async publishQueued(itemId: string): Promise<boolean> {
    const published = await this.store.publishStaged(itemId);
    if (!published) return false;
    await this.recordMessage(published);
    signalWake(this.agentId);
    return true;
  }

  /**
   * Remove a still-queued (unclaimed) item and mark it seen (true settle/dedupe).
   */
  async withdrawQueued(itemId: string): Promise<InboxItem | undefined> {
    return this.store.withdrawQueued(itemId);
  }

  /**
   * Atomically settle multiple still-claimable queued items to seen (one store
   * update). Cursor-delivery coalescing uses this so the selected same-surface
   * set cannot partially land.
   */
  async withdrawQueuedBatch(itemIds: string[]): Promise<InboxItem[]> {
    return this.store.withdrawQueuedBatch(itemIds);
  }

  /**
   * Drop an uncommitted staged wake without a seen tombstone so the same fire
   * id remains reusable after cancel/snooze CAS miss.
   */
  async abandonStaged(itemId: string): Promise<InboxItem | undefined> {
    return this.store.abandonStaged(itemId);
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

  replaceQueuedItem(item: InboxItem): Promise<boolean> {
    return this.store.replaceQueuedItem(item);
  }

  list(): Promise<InboxItem[]> {
    return this.store.list();
  }

  async takeNextRunnable(input: TakeNextRunnableInput): Promise<InboxItem | undefined> {
    return (await this.store.takeNextRunnable(input)).item;
  }

  async takeFollowupBatch(input: {
    activeItemId: string;
    excludedItemIds?: Iterable<string>;
    limit: number;
    workerId: string;
  }): Promise<InboxItem[]> {
    const items = await this.list();
    const activeItem = items.find((item) => item.id === input.activeItemId);
    if (!activeItem || activeItem.handling.status !== 'running' || activeItem.handling.workerId !== input.workerId) {
      return [];
    }

    const excludedItemIds = new Set(input.excludedItemIds ?? []);
    const queued = items
      .filter((item) => isClaimableQueuedInboxItem(item) && !excludedItemIds.has(item.id))
      .slice(0, input.limit);
    if (queued.length === 0) return [];
    return this.store.takeQueuedBatch({
      activeItemId: input.activeItemId,
      itemIds: queued.map((item) => item.id),
      workerId: input.workerId,
    });
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

  async requeue(itemId: string, options: { resumeReason?: 'runtime_restart' } = {}): Promise<void> {
    await this.store.requeue(itemId, options);
    signalWake(this.agentId);
  }

  async requeueBatch(itemIds: string[]): Promise<InboxItem[]> {
    const items = await this.store.requeueBatch(itemIds);
    if (items.length > 0) signalWake(this.agentId);
    return items;
  }

  async requeueAppendedTo(
    parentItemId: string,
    options: { resumeReason?: 'runtime_restart' } = {},
  ): Promise<InboxItem[]> {
    const items = await this.store.requeueAppendedTo(parentItemId, options);
    if (items.length > 0) signalWake(this.agentId);
    return items;
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

  markAppendedBatch(input: {
    itemIds: string[];
    parentItemId: string;
    workerId: string;
  }): Promise<InboxItem[]> {
    return this.store.markAppendedBatch(input);
  }

  async markSettled(input: {
    itemId: string;
    workerId: string;
  }): Promise<InboxItem | undefined> {
    return this.store.markSettled(input);
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
