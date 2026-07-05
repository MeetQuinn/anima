import { join } from 'node:path';

import { z } from 'zod';

import { nowIso } from '../../ids.js';
import { agentsDir } from './agent.store.js';
import { JsonStore } from '../json-store.js';
import { isPrimaryRunningInboxItem, InboxItemSchema, type InboxItem } from '../../../shared/inbox.js';

// The wake queue file has two sections:
// - `items`: active work only — `queued` items and unsettled `running` items (#377).
// - `seen`: compact dedupe markers for settled item ids, for every item kind.
//   Settling an item atomically moves its id from `items` to `seen` in one file
//   update, so enqueue dedupe never depends on another store (the message
//   ledger remains history, not dedupe authority). Markers are pruned by age
//   and count; the retention window comfortably covers transport redelivery
//   horizons and the memory-coherence per-day id scheme (2-day catchup).
export interface WakeQueueSeenMarker {
  kind: string;
  settledAt: string;
}

export interface WakeQueueFile {
  items: Record<string, InboxItem>;
  seen: Record<string, WakeQueueSeenMarker>;
}

export const WAKE_SEEN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const WAKE_SEEN_MAX_ENTRIES = 4096;

// Legacy status values that predate the current enum. Remap them on read so
// old queue entries don't break validation.
const LEGACY_STATUS_MAP: Record<string, string> = {
  received: 'completed',
};

const WakeQueueSeenMarkerSchema = z.object({
  kind: z.string(),
  settledAt: z.string(),
});

export const WakeQueueFileSchema = z.preprocess(
  migrateWakeQueueFile,
  z.object({
    items: z.record(z.string(), InboxItemSchema),
    seen: z.record(z.string(), WakeQueueSeenMarkerSchema),
  }),
);

// v1 files were a flat Record<id, InboxItem>. #383 additionally retained
// settled memory_coherence items in that flat map as dedupe markers. Migrate:
// active rows become `items`, settled memory_coherence rows become `seen`
// markers, and any other settled row (pre-#377 leftovers) is dropped.
function migrateWakeQueueFile(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { items: {}, seen: {} };
  const record = raw as Record<string, unknown>;
  if (isV2Shape(record)) return record;
  const items: Record<string, unknown> = {};
  const seen: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(record)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = remapLegacyStatus(value as Record<string, unknown>);
    const handling = (item.handling ?? {}) as Record<string, unknown>;
    if (isActiveHandling(handling)) {
      items[id] = item;
      continue;
    }
    if (item.kind === 'memory_coherence') {
      seen[id] = {
        kind: 'memory_coherence',
        settledAt: firstString(
          handling.settledAt,
          handling.completedAt,
          handling.failedAt,
          handling.updatedAt,
        ) ?? nowIso(),
      };
    }
  }
  return { items, seen };
}

function isV2Shape(record: Record<string, unknown>): boolean {
  return (
    typeof record.items === 'object' && record.items !== null && !Array.isArray(record.items) &&
    typeof record.seen === 'object' && record.seen !== null && !Array.isArray(record.seen)
  );
}

function remapLegacyStatus(item: Record<string, unknown>): Record<string, unknown> {
  const { handling } = item as { handling?: Record<string, unknown> };
  if (!handling || typeof handling.status !== 'string') return item;
  const mapped = LEGACY_STATUS_MAP[handling.status];
  if (!mapped) return item;
  return { ...item, handling: { ...handling, status: mapped } };
}

function isActiveHandling(handling: Record<string, unknown>): boolean {
  if (handling.status === 'queued') return true;
  return handling.status === 'running' && !handling.settledAt;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

export const getWakeQueueFileStore = (agentId: string): JsonStore<WakeQueueFile> =>
  new JsonStore<WakeQueueFile>({
    empty: () => ({ items: {}, seen: {} }),
    parse: (value) => normalizedWakeQueueFile(WakeQueueFileSchema.parse(value)),
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
    return (await this.read()).items[itemId];
  }

  /** True when the id is active work or a settled dedupe marker. */
  async has(itemId: string): Promise<boolean> {
    const file = await this.read();
    return Boolean(file.items[itemId] ?? file.seen[itemId]);
  }

  async insertIfAbsent(event: InboxItem): Promise<{ inserted: boolean; item: InboxItem }> {
    const item = activeInboxItem(event);
    let result: { inserted: boolean; item: InboxItem } | undefined;
    await this.update((current) => {
      const existing = current.items[item.id];
      if (existing) {
        result = { inserted: false, item: existing };
        return current;
      }
      if (current.seen[item.id]) {
        result = { inserted: false, item };
        return current;
      }
      result = { inserted: true, item };
      return { items: { ...current.items, [item.id]: item }, seen: current.seen };
    });
    if (!result) throw new Error(`Wake queue insert failed: ${item.id}`);
    return result;
  }

  /**
   * Remove an unclaimed queued item and record it as seen. Used to compensate
   * an enqueue that later turns out to be a duplicate (legacy ledger horizon).
   * Returns undefined when the item is absent or already claimed.
   */
  async withdrawQueued(itemId: string): Promise<InboxItem | undefined> {
    let withdrawn: InboxItem | undefined;
    await this.update((current) => {
      const item = current.items[itemId];
      if (!item || item.handling.status !== 'queued' || item.handling.workerId) return current;
      withdrawn = item;
      const items = { ...current.items };
      delete items[itemId];
      return { items, seen: withSeenMarker(current.seen, item, nowIso()) };
    });
    return withdrawn;
  }

  async replaceItem(item: InboxItem): Promise<InboxItem> {
    const parsed = activeInboxItem(item);
    await this.update((current) => {
      if (!current.items[parsed.id]) throw new Error(`Wake queue item not found: ${parsed.id}`);
      return { items: { ...current.items, [parsed.id]: parsed }, seen: current.seen };
    });
    return parsed;
  }

  async replaceQueuedItem(item: InboxItem): Promise<boolean> {
    const parsed = activeInboxItem(item);
    let replaced = false;
    await this.update((current) => {
      const currentItem = current.items[parsed.id];
      if (!currentItem || currentItem.handling.status !== 'queued') return current;
      replaced = true;
      return {
        items: { ...current.items, [parsed.id]: { ...parsed, handling: currentItem.handling } },
        seen: current.seen,
      };
    });
    return replaced;
  }

  async list(): Promise<InboxItem[]> {
    return Object.values((await this.read()).items)
      .sort((a, b) => itemSortAt(a).localeCompare(itemSortAt(b)));
  }

  async takeNextRunnable(input: TakeNextRunnableInput): Promise<TakeNextRunnableResult> {
    let result: TakeNextRunnableResult | undefined;
    const now = input.now ?? new Date();
    const nowText = now.toISOString();
    const nowMs = now.getTime();
    if (!hasPotentialRunnableWork(await this.read(), input, nowMs)) return { recovered: [] };

    await this.update((current) => {
      const next = { ...current.items };
      const recovered: InboxItem[] = [];
      let changed = false;
      for (const [itemId, item] of Object.entries(current.items)) {
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
        return changed ? { items: next, seen: current.seen } : current;
      }

      const item = Object.values(next)
        .filter((candidate) => candidate.handling.status === 'queued')
        .sort((a, b) => itemSortAt(a).localeCompare(itemSortAt(b)))[0];
      if (!item) {
        result = { recovered };
        return changed ? { items: next, seen: current.seen } : current;
      }

      const claimed = withHandling(item, {
        startedAt: nowText,
        status: 'running',
        workerId: input.workerId,
      }, nowText);
      next[item.id] = claimed;
      result = { item: claimed, recovered };
      return { items: next, seen: current.seen };
    });
    return result ?? { recovered: [] };
  }

  async complete(itemId: string): Promise<void> {
    await this.settleItem(itemId);
  }

  async fail(itemId: string): Promise<void> {
    await this.settleItem(itemId);
  }

  async completeAppendedTo(parentItemId: string): Promise<InboxItem[]> {
    return this.settleAppendedTo(parentItemId, 'completed');
  }

  async failAppendedTo(parentItemId: string): Promise<InboxItem[]> {
    return this.settleAppendedTo(parentItemId, 'failed');
  }

  async takeQueued(input: {
    itemId: string;
    workerId: string;
  }): Promise<InboxItem | undefined> {
    return this.updateItemIfPresent(input.itemId, (item, now) => {
      if (item.handling.status !== 'queued') return undefined;
      return withHandling(item, {
        startedAt: now,
        status: 'running',
        workerId: input.workerId,
      }, now);
    });
  }

  async requestDrain(input: {
    itemId: string;
    timeoutMs: number;
  }): Promise<InboxItem> {
    return this.updateItem(input.itemId, (item, now) => withHandling(item, {
      drainRequestedAt: now,
      drainTimeoutMs: input.timeoutMs,
    }, now));
  }

  async clearDrainRequest(itemId: string): Promise<InboxItem> {
    return this.updateItem(itemId, (item, now) => {
      const handling = { ...item.handling };
      delete handling.drainRequestedAt;
      delete handling.drainTimeoutMs;
      return { ...item, handling: { ...handling, updatedAt: now } };
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
    return this.updateItem(itemId, (item, now) => withHandling(item, { stopRequestedAt: now }, now));
  }

  async markRunning(input: {
    itemId: string;
    startedAt?: string;
    workerId: string;
  }): Promise<InboxItem> {
    return this.updateItem(input.itemId, (item, now) => withHandling(item, {
      startedAt: input.startedAt ?? item.handling.startedAt ?? now,
      status: 'running',
      workerId: input.workerId,
    }, now));
  }

  async markAppended(input: {
    itemId: string;
    parentItemId: string;
    workerId: string;
  }): Promise<InboxItem> {
    return this.updateItem(input.itemId, (item, now) => withHandling(item, {
      appendedAt: now,
      appendedToItemId: input.parentItemId,
      startedAt: item.handling.startedAt ?? now,
      status: 'running',
      workerId: input.workerId,
    }, now));
  }

  async markSettled(input: {
    itemId: string;
    workerId: string;
  }): Promise<InboxItem | undefined> {
    let updated: InboxItem | undefined;
    await this.update((current) => {
      const item = current.items[input.itemId];
      if (!item || item.handling.workerId !== input.workerId) return current;
      const now = nowIso();
      updated = withHandling(item, { settledAt: now }, now);
      const items = { ...current.items };
      delete items[input.itemId];
      return { items, seen: withSeenMarker(current.seen, item, now) };
    });
    return updated;
  }

  private async settleItem(itemId: string): Promise<void> {
    let found = false;
    await this.update((current) => {
      const item = current.items[itemId];
      if (!item) return current;
      found = true;
      const items = { ...current.items };
      delete items[itemId];
      return { items, seen: withSeenMarker(current.seen, item, nowIso()) };
    });
    if (!found) throw new Error(`Wake queue item not found: ${itemId}`);
  }

  private async settleAppendedTo(
    parentItemId: string,
    outcome: 'completed' | 'failed',
  ): Promise<InboxItem[]> {
    const updated: InboxItem[] = [];
    await this.update((current) => {
      const now = nowIso();
      updated.length = 0;
      const items: Record<string, InboxItem> = {};
      let seen = current.seen;
      for (const [itemId, item] of Object.entries(current.items)) {
        if (item.handling.status === 'running' && item.handling.appendedToItemId === parentItemId) {
          updated.push(settledItem(item, outcome, now));
          seen = withSeenMarker(seen, item, now);
        } else {
          items[itemId] = item;
        }
      }
      return updated.length > 0 ? { items, seen } : current;
    });
    return updated;
  }

  private async updateAppendedTo(
    parentItemId: string,
    update: (item: InboxItem, now: string) => InboxItem,
  ): Promise<InboxItem[]> {
    const updated: InboxItem[] = [];
    await this.update((current) => {
      const now = nowIso();
      updated.length = 0;
      const items: Record<string, InboxItem> = {};
      for (const [itemId, item] of Object.entries(current.items)) {
        if (item.handling.status === 'running' && item.handling.appendedToItemId === parentItemId) {
          const nextItem = update(item, now);
          items[itemId] = nextItem;
          updated.push(nextItem);
        } else {
          items[itemId] = item;
        }
      }
      return updated.length > 0 ? { items, seen: current.seen } : current;
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
    await this.update((current) => {
      const item = current.items[itemId];
      if (!item) return current;
      const nextItem = update(item, nowIso());
      if (!nextItem) return current;
      updated = nextItem;
      return { items: { ...current.items, [itemId]: updated }, seen: current.seen };
    });
    return updated;
  }

  private async read(): Promise<WakeQueueFile> {
    return normalizedWakeQueueFile(await this.store.read());
  }

  private async update(
    op: (current: WakeQueueFile) => WakeQueueFile,
  ): Promise<void> {
    await this.store.update((rawCurrent) => {
      const current = normalizedWakeQueueFile(rawCurrent);
      const next = op(current);
      if (next === current) return rawCurrent;
      return { items: next.items, seen: pruneSeen(next.seen, Date.now()) };
    });
  }
}

function withHandling(
  item: InboxItem,
  patch: Partial<InboxItem['handling']>,
  now: string,
): InboxItem {
  return { ...item, handling: { ...item.handling, ...patch, updatedAt: now } };
}

function settledItem(item: InboxItem, outcome: 'completed' | 'failed', now: string): InboxItem {
  return withHandling(
    item,
    outcome === 'completed'
      ? { completedAt: now, status: 'completed' }
      : { failedAt: now, status: 'failed' },
    now,
  );
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

function withSeenMarker(
  seen: Record<string, WakeQueueSeenMarker>,
  item: InboxItem,
  settledAt: string,
): Record<string, WakeQueueSeenMarker> {
  return { ...seen, [item.id]: { kind: item.kind, settledAt } };
}

function pruneSeen(
  seen: Record<string, WakeQueueSeenMarker>,
  nowMs: number,
): Record<string, WakeQueueSeenMarker> {
  const fresh = Object.entries(seen).filter(([, marker]) => {
    const settledMs = Date.parse(marker.settledAt);
    return Number.isNaN(settledMs) || nowMs - settledMs < WAKE_SEEN_RETENTION_MS;
  });
  const bounded = fresh.length > WAKE_SEEN_MAX_ENTRIES
    ? fresh
        .sort(([, a], [, b]) => b.settledAt.localeCompare(a.settledAt))
        .slice(0, WAKE_SEEN_MAX_ENTRIES)
    : fresh;
  return Object.fromEntries(bounded);
}

// Injected persistences (tests) may hand back legacy flat files or items in
// non-active states; normalize to the v2 shape with active-only items.
function normalizedWakeQueueFile(file: WakeQueueFile): WakeQueueFile {
  const migrated = migrateWakeQueueFile(file) as WakeQueueFile;
  const items = Object.fromEntries(
    Object.entries(migrated.items ?? {}).filter(([, item]) => isActiveWakeQueueItem(item)),
  );
  return { items, seen: migrated.seen ?? {} };
}

function isActiveWakeQueueItem(item: InboxItem): boolean {
  return item.handling.status === 'queued' || (item.handling.status === 'running' && !item.handling.settledAt);
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

function hasPotentialRunnableWork(
  file: WakeQueueFile,
  input: TakeNextRunnableInput,
  nowMs: number,
): boolean {
  return Object.values(file.items).some((item) => (
    item.handling.status === 'queued' ||
    (item.handling.status === 'running' && shouldRecoverRunningItem(item, input, nowMs))
  ));
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
