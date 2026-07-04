import { join } from 'node:path';

import { z } from 'zod';

import { nowIso } from '../../ids.js';
import { agentsDir } from './agent.store.js';
import { JsonStore } from '../json-store.js';
import { isPrimaryRunningInboxItem, InboxItemSchema, type InboxItem } from '../../../shared/inbox.js';

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
    parse: (value) => activeWakeQueueFile(WakeQueueFileSchema.parse(value)),
    path: () => join(agentsDir(), agentId, 'wake-queue.json'),
  });

interface WakeQueueFilePersistence {
  read(): Promise<WakeQueueFile>;
  update(op: (current: WakeQueueFile) => WakeQueueFile | Promise<WakeQueueFile>): Promise<WakeQueueFile>;
}

export interface TakeNextRunnableInput {
  currentWorkerId?: string;
  isWorkerAlive: (workerId: string) => boolean;
  now?: Date;
  staleRunningMs?: number;
  workerId: string;
}

export interface TakeNextRunnableResult {
  item?: InboxItem;
  recovered: InboxItem[];
}

export class WakeQueueStore {
  constructor(
    readonly agentId: string,
    private readonly store: WakeQueueFilePersistence = getWakeQueueFileStore(agentId),
  ) {}

  async find(itemId: string): Promise<InboxItem | undefined> {
    return activeWakeQueueFile(await this.store.read())[itemId];
  }

  async insertIfAbsent(event: InboxItem): Promise<{ inserted: boolean; item: InboxItem }> {
    const item = activeInboxItem(event);
    let result: { inserted: boolean; item: InboxItem } | undefined;
    await this.store.update((rawCurrent) => {
      const current = activeWakeQueueFile(rawCurrent);
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
    const parsed = activeInboxItem(item);
    await this.store.update((rawCurrent) => {
      const current = activeWakeQueueFile(rawCurrent);
      if (!current[parsed.id]) throw new Error(`Wake queue item not found: ${parsed.id}`);
      return { ...current, [parsed.id]: parsed };
    });
    return parsed;
  }

  async list(): Promise<InboxItem[]> {
    return Object.values(activeWakeQueueFile(await this.store.read()))
      .sort((a, b) => a.handling.createdAt.localeCompare(b.handling.createdAt));
  }

  async listRunnable(): Promise<InboxItem[]> {
    return (await this.list())
      .sort((a, b) => itemSortAt(a).localeCompare(itemSortAt(b)));
  }

  async takeNextRunnable(input: TakeNextRunnableInput): Promise<TakeNextRunnableResult> {
    let result: TakeNextRunnableResult | undefined;
    const now = input.now ?? new Date();
    const nowText = now.toISOString();
    const nowMs = now.getTime();
    await this.store.update((rawCurrent) => {
      const current = activeWakeQueueFile(rawCurrent);
      const next = { ...current };
      const recovered: InboxItem[] = [];
      let changed = Object.keys(next).length !== Object.keys(rawCurrent).length;
      for (const [itemId, item] of Object.entries(current)) {
        if (item.handling.status !== 'running') continue;
        if (!shouldRecoverRunningItem(item, input, nowMs)) continue;
        const requeued = requeuedItem(item, nowText, {
          ...(item.handling.drainRequestedAt ? { resumeReason: 'runtime_restart' as const } : {}),
        });
        next[itemId] = requeued;
        recovered.push(requeued);
        changed = true;
      }

      if (Object.values(next).some((item) => isPrimaryRunningInboxItem(item))) {
        result = { recovered };
        return changed ? next : rawCurrent;
      }

      const item = Object.values(next)
        .filter((candidate) => candidate.handling.status === 'queued')
        .sort((a, b) => itemSortAt(a).localeCompare(itemSortAt(b)))[0];
      if (!item) {
        result = { recovered };
        return changed ? next : rawCurrent;
      }

      const claimed: InboxItem = {
        ...item,
        handling: {
          ...item.handling,
          startedAt: nowText,
          status: 'running',
          updatedAt: nowText,
          workerId: input.workerId,
        },
      };
      next[item.id] = claimed;
      result = { item: claimed, recovered };
      return next;
    });
    return result ?? { recovered: [] };
  }

  async complete(itemId: string): Promise<void> {
    await this.settleItem(itemId, (item, now) => ({
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
    return this.settleAppendedTo(parentItemId, (item, now) => ({
      ...item,
      handling: {
        ...item.handling,
        completedAt: now,
        status: 'completed',
        updatedAt: now,
      },
    }));
  }

  async takeQueued(input: {
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
    await this.settleItem(itemId, (item, now) => ({
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
    return this.settleAppendedTo(parentItemId, (item, now) => ({
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
    await this.updateItem(itemId, (item, now) => requeuedItem(item, now, options));
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
    let updated: InboxItem | undefined;
    await this.store.update((rawCurrent) => {
      const current = activeWakeQueueFile(rawCurrent);
      const item = current[input.itemId];
      if (!item || item.handling.workerId !== input.workerId) return rawCurrent;
      const now = nowIso();
      updated = {
        ...item,
        handling: {
          ...item.handling,
          settledAt: now,
          updatedAt: now,
        },
      };
      const next = { ...current };
      delete next[input.itemId];
      return next;
    });
    return updated;
  }

  private async settleItem(
    itemId: string,
    update: (item: InboxItem, now: string) => InboxItem,
  ): Promise<void> {
    let found = false;
    await this.store.update((rawCurrent) => {
      const current = activeWakeQueueFile(rawCurrent);
      const item = current[itemId];
      if (!item) return rawCurrent;
      found = true;
      void update(item, nowIso());
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    if (!found) throw new Error(`Wake queue item not found: ${itemId}`);
  }

  private async settleAppendedTo(
    parentItemId: string,
    update: (item: InboxItem, now: string) => InboxItem,
  ): Promise<InboxItem[]> {
    const updated: InboxItem[] = [];
    await this.store.update((rawCurrent) => {
      const current = activeWakeQueueFile(rawCurrent);
      const now = nowIso();
      updated.length = 0;
      const next: WakeQueueFile = {};
      for (const [itemId, item] of Object.entries(current)) {
        if (item.handling.status === 'running' && item.handling.appendedToItemId === parentItemId) {
          updated.push(update(item, now));
        } else {
          next[itemId] = item;
        }
      }
      return updated.length > 0 ? next : rawCurrent;
    });
    return updated;
  }

  private async updateAppendedTo(
    parentItemId: string,
    update: (item: InboxItem, now: string) => InboxItem,
  ): Promise<InboxItem[]> {
    const updated: InboxItem[] = [];
    await this.store.update((rawCurrent) => {
      const current = activeWakeQueueFile(rawCurrent);
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
      return updated.length > 0 ? next : rawCurrent;
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
    await this.store.update((rawCurrent) => {
      const current = activeWakeQueueFile(rawCurrent);
      const item = current[itemId];
      if (!item) return rawCurrent;
      const nextItem = update(item, nowIso());
      if (!nextItem) return rawCurrent;
      updated = nextItem;
      return { ...current, [itemId]: updated };
    });
    return updated;
  }
}

function itemSortAt(item: InboxItem): string {
  return item.handling.queuedAt ?? item.handling.startedAt ?? item.handling.updatedAt;
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

function activeWakeQueueFile(file: WakeQueueFile): WakeQueueFile {
  return Object.fromEntries(
    Object.entries(file).filter(([, item]) =>
      item.handling.status === 'queued' || (item.handling.status === 'running' && !item.handling.settledAt)
    ),
  );
}

function activeInboxItem(item: InboxItem): InboxItem {
  const parsed = InboxItemSchema.parse(item);
  if (
    parsed.handling.status !== 'queued' &&
    (parsed.handling.status !== 'running' || parsed.handling.settledAt)
  ) {
    throw new Error(`Wake queue only stores active items; got ${parsed.handling.status} for ${parsed.id}`);
  }
  return parsed;
}

function shouldRecoverRunningItem(
  item: InboxItem,
  input: TakeNextRunnableInput,
  nowMs: number,
): boolean {
  const workerAlive = item.handling.workerId ? input.isWorkerAlive(item.handling.workerId) : false;
  const workerReplaced = workerChangedInCurrentProcess(item.handling.workerId, input.currentWorkerId);
  return !workerAlive || workerReplaced || staleRunningItem(item, nowMs, input.staleRunningMs);
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
