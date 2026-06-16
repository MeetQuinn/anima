import { join } from 'node:path';

import { z } from 'zod';

import { nowIso } from '../../ids.js';
import { agentsDir } from './agent.store.js';
import { JsonStore } from '../json-store.js';
import { InboxItemSchema, type InboxItem } from '../../../shared/inbox.js';

export type WakeQueueFile = Record<string, InboxItem>;

// Legacy status values that predate the current enum. Remap them on read so
// old queue entries don't break the write-path Zod validation.
const LEGACY_STATUS_MAP: Record<string, string> = {
  received: 'completed',
};

function migrateLegacyWakeQueueFile(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([id, item]) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [id, item];
      const { handling } = item as { handling?: Record<string, unknown> };
      if (!handling || typeof handling.status !== 'string') return [id, item];
      const mapped = LEGACY_STATUS_MAP[handling.status];
      if (!mapped) return [id, item];
      return [id, { ...item, handling: { ...handling, status: mapped } }];
    }),
  );
}

export const WakeQueueFileSchema = z.preprocess(migrateLegacyWakeQueueFile, z.record(z.string(), InboxItemSchema));

export const getWakeQueueFileStore = (agentId: string): JsonStore<WakeQueueFile> =>
  new JsonStore<WakeQueueFile>({
    empty: () => ({}),
    parse: (value) => WakeQueueFileSchema.parse(value),
    // Keep the existing filename for live-data compatibility. Product inbox
    // history now lives in messages.jsonl; this file is only the wake queue.
    path: () => join(agentsDir(), agentId, 'inbox.json'),
  });

interface WakeQueueFilePersistence {
  read(): Promise<WakeQueueFile>;
  update(op: (current: WakeQueueFile) => WakeQueueFile | Promise<WakeQueueFile>): Promise<WakeQueueFile>;
}

export class WakeQueueStore {
  constructor(
    readonly agentId: string,
    private readonly store: WakeQueueFilePersistence = getWakeQueueFileStore(agentId),
  ) {}

  async find(itemId: string): Promise<InboxItem | undefined> {
    return (await this.store.read())[itemId];
  }

  async insertIfAbsent(event: InboxItem): Promise<{ inserted: boolean; item: InboxItem }> {
    const item = InboxItemSchema.parse(event);
    let result: { inserted: boolean; item: InboxItem } | undefined;
    await this.store.update((current) => {
      const existing = current[item.id];
      if (existing) {
        result = { inserted: false, item: existing };
        return current;
      }
      result = { inserted: true, item };
      return { ...current, [item.id]: item };
    });
    if (!result) throw new Error(`Wake queue insert failed: ${item.id}`);
    return result;
  }

  async replaceItem(item: InboxItem): Promise<InboxItem> {
    const parsed = InboxItemSchema.parse(item);
    await this.store.update((current) => {
      if (!current[parsed.id]) throw new Error(`Wake queue item not found: ${parsed.id}`);
      return { ...current, [parsed.id]: parsed };
    });
    return parsed;
  }

  async list(): Promise<InboxItem[]> {
    return Object.values(await this.store.read())
      .sort((a, b) => a.handling.createdAt.localeCompare(b.handling.createdAt));
  }

  async listRunnable(): Promise<InboxItem[]> {
    return (await this.list())
      .sort((a, b) => itemSortAt(a).localeCompare(itemSortAt(b)));
  }

  async pruneSettledBefore(cutoffIso: string): Promise<number> {
    let pruned = 0;
    await this.store.update((current) => {
      pruned = 0;
      const next: WakeQueueFile = {};
      for (const [itemId, item] of Object.entries(current)) {
        if (isSettledBefore(item, cutoffIso)) {
          pruned += 1;
        } else {
          next[itemId] = item;
        }
      }
      return pruned > 0 ? next : current;
    });
    return pruned;
  }

  async complete(itemId: string): Promise<void> {
    await this.replaceItemWithTimestamp(itemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        completedAt: now,
        status: 'completed',
        updatedAt: now,
      },
    }));
  }

  async completeAppendedTo(parentItemId: string): Promise<InboxItem[]> {
    return this.updateAppendedTo(parentItemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        completedAt: now,
        status: 'completed',
        updatedAt: now,
      },
    }));
  }

  async claimQueued(input: {
    itemId: string;
    workerId: string;
  }): Promise<InboxItem | undefined> {
    return this.updateItemIfPresent(input.itemId, (item, now) => {
      if (item.handling.status !== 'queued') return undefined;
      return {
        ...item,
        handling: {
          ...item.handling,
          startedAt: now,
          status: 'running',
          updatedAt: now,
          workerId: input.workerId,
        },
      };
    });
  }

  async fail(itemId: string): Promise<void> {
    await this.replaceItemWithTimestamp(itemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        failedAt: now,
        status: 'failed',
        updatedAt: now,
      },
    }));
  }

  async failAppendedTo(parentItemId: string): Promise<InboxItem[]> {
    return this.updateAppendedTo(parentItemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        failedAt: now,
        status: 'failed',
        updatedAt: now,
      },
    }));
  }

  async requestDrain(input: {
    itemId: string;
    timeoutMs: number;
  }): Promise<InboxItem> {
    return this.updateItem(input.itemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        drainRequestedAt: now,
        drainTimeoutMs: input.timeoutMs,
        updatedAt: now,
      },
    }));
  }

  async clearDrainRequest(itemId: string): Promise<InboxItem> {
    return this.updateItem(itemId, (item, now) => {
      const handling = { ...item.handling };
      delete handling.drainRequestedAt;
      delete handling.drainTimeoutMs;
      return {
        ...item,
        handling: {
          ...handling,
          updatedAt: now,
        },
      };
    });
  }

  async requeue(itemId: string, options: { resumeReason?: 'runtime_restart' } = {}): Promise<void> {
    await this.replaceItemWithTimestamp(itemId, (item, now) => requeuedItem(item, now, options));
  }

  async requeueAppendedTo(
    parentItemId: string,
    options: { resumeReason?: 'runtime_restart' } = {},
  ): Promise<InboxItem[]> {
    return this.updateAppendedTo(parentItemId, (item, now) => requeuedItem(item, now, options));
  }

  async requestStop(itemId: string): Promise<InboxItem> {
    return this.updateItem(itemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        stopRequestedAt: now,
        updatedAt: now,
      },
    }));
  }

  async markRunning(input: {
    itemId: string;
    startedAt?: string;
    workerId: string;
  }): Promise<InboxItem> {
    return this.updateItem(input.itemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        startedAt: input.startedAt ?? item.handling.startedAt ?? now,
        status: 'running',
        updatedAt: now,
        workerId: input.workerId,
      },
    }));
  }

  async markAppended(input: {
    itemId: string;
    parentItemId: string;
    workerId: string;
  }): Promise<InboxItem> {
    return this.updateItem(input.itemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        appendedAt: now,
        appendedToItemId: input.parentItemId,
        startedAt: item.handling.startedAt ?? now,
        status: 'running',
        updatedAt: now,
        workerId: input.workerId,
      },
    }));
  }

  async markSettled(input: {
    itemId: string;
    workerId: string;
  }): Promise<InboxItem | undefined> {
    return this.updateItemIfPresent(input.itemId, (item, now) => {
      if (item.handling.workerId !== input.workerId) return undefined;
      return {
        ...item,
        handling: {
          ...item.handling,
          settledAt: now,
          updatedAt: now,
        },
      };
    });
  }

  private async replaceItemWithTimestamp(
    itemId: string,
    update: (item: InboxItem, now: string) => InboxItem,
  ): Promise<void> {
    await this.updateItem(itemId, update);
  }

  private async updateAppendedTo(
    parentItemId: string,
    update: (item: InboxItem, now: string) => InboxItem,
  ): Promise<InboxItem[]> {
    const updated: InboxItem[] = [];
    await this.store.update((current) => {
      const now = nowIso();
      updated.length = 0;
      const next: WakeQueueFile = {};
      for (const [itemId, item] of Object.entries(current)) {
        if (item.handling.status === 'running' && item.handling.appendedToItemId === parentItemId) {
          const nextItem = update(item, now);
          next[itemId] = nextItem;
          updated.push(nextItem);
        } else {
          next[itemId] = item;
        }
      }
      return updated.length > 0 ? next : current;
    });
    return updated;
  }

  private async updateItem(
    itemId: string,
    update: (item: InboxItem, now: string) => InboxItem,
  ): Promise<InboxItem> {
    const item = await this.updateItemIfPresent(itemId, update);
    if (!item) throw new Error(`Wake queue item not found: ${itemId}`);
    return item;
  }

  private async updateItemIfPresent(
    itemId: string,
    update: (item: InboxItem, now: string) => InboxItem | undefined,
  ): Promise<InboxItem | undefined> {
    let updated: InboxItem | undefined;
    await this.store.update((current) => {
      const item = current[itemId];
      if (!item) return current;
      const nextItem = update(item, nowIso());
      if (!nextItem) return current;
      updated = nextItem;
      return { ...current, [itemId]: updated };
    });
    return updated;
  }
}

function itemSortAt(item: InboxItem): string {
  return item.handling.queuedAt ?? item.handling.startedAt ?? item.handling.updatedAt;
}

function isSettledBefore(item: InboxItem, cutoffIso: string): boolean {
  if (item.handling.status !== 'completed' && item.handling.status !== 'failed') return false;
  const settledAt = item.handling.settledAt ?? item.handling.completedAt ?? item.handling.failedAt ?? item.handling.updatedAt;
  return settledAt < cutoffIso;
}

function requeuedItem(
  item: InboxItem,
  now: string,
  options: { resumeReason?: 'runtime_restart' } = {},
): InboxItem {
  const handling = { ...item.handling };
  delete handling.startedAt;
  delete handling.workerId;
  delete handling.appendedAt;
  delete handling.appendedToItemId;
  delete handling.settledAt;
  delete handling.drainRequestedAt;
  delete handling.drainTimeoutMs;
  delete handling.resumeReason;
  return {
    ...item,
    handling: {
      ...handling,
      ...(options.resumeReason ? { resumeReason: options.resumeReason } : {}),
      status: 'queued',
      updatedAt: now,
    },
  };
}
