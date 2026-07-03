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
  // model is permanent-follow + explicit mute, but keep legacy fields readable
  // so existing subscription.json files migrate on the next write.
  expiresAt: z.string().optional(),
  lastActivityAt: z.string().optional(),
  lastNudgeAt: z.string().optional(),
  lastPostedAt: z.string().optional(),
  mutedAt: z.string().optional(),
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

function getSubscriptionFileStore(agentId: string): JsonStore<StoredSubscriptions> {
  return new JsonStore<StoredSubscriptions>({
    empty: () => ({}),
    parse: SubscriptionsFileSchema.parse,
    path: () => join(agentsDir(), agentId, 'subscription.json'),
  });
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

  async replace(subscription: SubscriptionRecord): Promise<SubscriptionRecord> {
    if (subscription.agentId !== this.agentId) {
      throw new Error(`Cannot write subscription for ${subscription.agentId} through ${this.agentId} store`);
    }
    const stored = await this.file.read();
    await this.file.write({
      ...stored,
      [subscription.subscriptionId]: persistedSubscription(subscription),
    });
    return subscription;
  }

  async remove(subscriptionId: string): Promise<boolean> {
    const stored = await this.file.read();
    if (!stored[subscriptionId]) return false;
    const next = { ...stored };
    delete next[subscriptionId];
    await this.file.write(next);
    return true;
  }
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
