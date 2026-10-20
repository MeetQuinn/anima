// Disk schema and store for agents/<agentId>/subscription.json.
//
// The file is agent-scoped and stores a JSON object keyed by subscriptionId:
//   Record<string, Subscription>
//
// `agentId` and `subscriptionId` are intentionally not duplicated in each
// stored value; callers can derive them from the path and object key.

import { join } from 'node:path';

import { agentsDir } from './agent.store.js';
import { JsonStore } from '../json-store.js';
import { z } from 'zod';

const SubscriptionBase = z.object({
  channelId: z.string(),
  // Legacy subscriptions carried expiresAt/remainingMessages. The attention
  // model is follow + explicit mute, with a 30-day lapse for idle thread
  // follows (threadFollowLapsed). Keep the legacy fields readable so existing
  // subscription.json files migrate on the next write.
  expiresAt: z.string().optional(),
  lastActivityAt: z.string().optional(),
  lastNudgeAt: z.string().optional(),
  lastPostedAt: z.string().optional(),
  mutedAt: z.string().optional(),
  platform: z.enum(['slack', 'feishu']).optional(),
  silentWakeStartedAt: z.string().optional(),
  updatedAt: z.string(),
  wakeCount: z.number().int().nonnegative().optional(),
  wakeWindowStartedAt: z.string().optional(),
  wakesSinceLastPost: z.number().int().nonnegative().optional(),
});

export const ThreadSubscription = SubscriptionBase.extend({
  kind: z.literal('thread'),
  remainingMessages: z.number().optional(),
  threadTs: z.string(),
});

export type ThreadSubscription = z.infer<typeof ThreadSubscription>;

export const ChannelSubscription = SubscriptionBase.extend({
  kind: z.literal('channel'),
});

export type ChannelSubscription = z.infer<typeof ChannelSubscription>;

export const Subscription = z.discriminatedUnion('kind', [ThreadSubscription, ChannelSubscription]);

export type Subscription = z.infer<typeof Subscription>;

const SubscriptionsFileSchema = z.record(z.string(), Subscription);

export type StoredSubscriptions = Record<string, Subscription>;
export type SubscriptionStatus = 'following' | 'muted';
export type SubscriptionRecord = Subscription & { agentId: string; subscriptionId: string };

// One file store per agent for the life of the process. A JsonStore memoizes
// its schema parse by the cached file object, so an unchanged file is parsed
// once. Ingress builds a SubscriptionStore for every event; with a fresh
// JsonStore each time, every event re-parsed the whole file.
const subscriptionFileStores = new Map<string, JsonStore<StoredSubscriptions>>();

function getSubscriptionFileStore(agentId: string): JsonStore<StoredSubscriptions> {
  const existing = subscriptionFileStores.get(agentId);
  if (existing) return existing;
  const created = new JsonStore<StoredSubscriptions>({
    empty: () => ({}),
    parse: SubscriptionsFileSchema.parse,
    path: () => join(agentsDir(), agentId, 'subscription.json'),
  });
  subscriptionFileStores.set(agentId, created);
  return created;
}

export class SubscriptionStore {
  private readonly file: JsonStore<StoredSubscriptions>;

  constructor(private readonly agentId: string) {
    this.file = getSubscriptionFileStore(agentId);
  }

  async list(): Promise<SubscriptionRecord[]> {
    const stored = await this.file.read();
    return Object.entries(stored).map(([subscriptionId, raw]) =>
      normalizeSubscription(this.agentId, subscriptionId, raw),
    );
  }

  async find(subscriptionId: string): Promise<SubscriptionRecord | undefined> {
    const stored = await this.file.read();
    const subscription = stored[subscriptionId];
    return subscription ? normalizeSubscription(this.agentId, subscriptionId, subscription) : undefined;
  }

  /** Writes one record and drops the thread records that can no longer wake the agent. */
  async replace(subscription: SubscriptionRecord): Promise<SubscriptionRecord> {
    if (subscription.agentId !== this.agentId) {
      throw new Error(`Cannot write subscription for ${subscription.agentId} through ${this.agentId} store`);
    }
    const nowMs = writeTimeMs(subscription);
    await this.file.update((stored) => {
      return {
        ...withoutDeadThreadRecords(stored, nowMs),
        [subscription.subscriptionId]: persistedSubscription(subscription),
      };
    });
    return subscription;
  }

  async remove(subscriptionId: string): Promise<boolean> {
    let removed = false;
    await this.file.update((stored) => {
      if (!stored[subscriptionId]) return stored;
      removed = true;
      const next = { ...stored };
      delete next[subscriptionId];
      return next;
    });
    return removed;
  }
}

/** An unmuted thread follow lapses after this long without a wake or a post. */
export const THREAD_FOLLOW_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export function threadFollowLapsed(subscription: Subscription, nowMs: number): boolean {
  if (subscription.kind !== 'thread' || subscription.mutedAt) return false;
  const touchedMs = Math.max(
    ...[subscription.updatedAt, subscription.lastActivityAt, subscription.lastPostedAt]
      .map((value) => (value ? Date.parse(value) : Number.NaN))
      .filter(Number.isFinite),
  );
  return Number.isFinite(touchedMs) && nowMs - touchedMs > THREAD_FOLLOW_IDLE_MS;
}

/** A Slack DM always wakes the agent directly and never consults a thread follow. */
function isSlackDmThread(subscription: Subscription): boolean {
  if (subscription.kind !== 'thread') return false;
  const platform = subscription.platform ?? (subscription.channelId.startsWith('oc_') ? 'feishu' : 'slack');
  return platform === 'slack' && subscription.channelId.startsWith('D');
}

/**
 * Drop thread records that can no longer wake the agent: lapsed unmuted
 * follows, and every Slack DM thread record. The DM case includes muted
 * records, because a DM wakes directly and never consults the mute. Channel
 * records and channel-thread mutes are kept.
 */
function withoutDeadThreadRecords(stored: StoredSubscriptions, nowMs: number): StoredSubscriptions {
  let kept: StoredSubscriptions | undefined;
  for (const [subscriptionId, subscription] of Object.entries(stored)) {
    if (!isSlackDmThread(subscription) && !threadFollowLapsed(subscription, nowMs)) continue;
    kept ??= { ...stored };
    delete kept[subscriptionId];
  }
  return kept ?? stored;
}

/**
 * The clock for pruning is the written record's own `updatedAt`, so callers
 * that pass an explicit time stay consistent. It is capped at the real clock,
 * so a future-dated record cannot make every other follow look idle.
 */
function writeTimeMs(subscription: Subscription): number {
  const writtenMs = Date.parse(subscription.updatedAt);
  return Number.isFinite(writtenMs) ? Math.min(writtenMs, Date.now()) : Date.now();
}

export function subscriptionStatus(subscription: Subscription, _nowMs?: number): SubscriptionStatus {
  return subscription.mutedAt ? 'muted' : 'following';
}

function normalizeSubscription(agentId: string, subscriptionId: string, raw: Subscription): SubscriptionRecord {
  return {
    ...raw,
    agentId,
    subscriptionId,
  };
}

function persistedSubscription(subscription: SubscriptionRecord): Subscription {
  const { agentId: _agentId, subscriptionId: _subscriptionId, ...persisted } = subscription;
  return persisted;
}
