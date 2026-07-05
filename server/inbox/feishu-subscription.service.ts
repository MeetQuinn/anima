import type { FeishuInboxItem } from '../../shared/inbox.js';
import { SubscriptionStore } from '../storage/schema/subscription.store.js';
import {
  channelSubscriptionId,
  channelSubscriptionRecord,
  followChannel,
  noteInboundWake,
  subscriptionDecisionSummary,
  type SubscriptionRecord,
} from './subscription.service.js';

export interface FeishuRuntimeDecision {
  attentionSuggestion?: string;
  subscription?: {
    status: 'following' | 'muted';
    subscriptionId: string;
    kind: SubscriptionRecord['kind'];
  };
  reason: 'channel_follow' | 'dm' | 'mention' | 'muted' | 'not_addressed';
  shouldStartRuntime: boolean;
}

export async function feishuRuntimeDecision(
  event: FeishuInboxItem,
  options: { agentId?: string; duplicate?: boolean; mentioned?: boolean; nowMs?: number },
): Promise<FeishuRuntimeDecision> {
  if (event.chatType === 'p2p') return { reason: 'dm', shouldStartRuntime: true };
  if (!event.chatId) return { reason: 'not_addressed', shouldStartRuntime: false };
  if (options.mentioned) return activateFeishuMentionFollow(event, options);
  return consumeFeishuChannelFollow(event, options);
}

export async function activateFeishuMentionFollow(
  event: FeishuInboxItem,
  options: { agentId?: string; duplicate?: boolean; nowMs?: number },
): Promise<FeishuRuntimeDecision> {
  const agentId = options.agentId ?? 'anima';
  if (options.duplicate) return { reason: 'mention', shouldStartRuntime: true };

  const store = new SubscriptionStore(agentId);
  const subscription = await followChannel({
    agentId,
    channelId: event.chatId,
    now: new Date(options.nowMs ?? Date.now()).toISOString(),
    platform: 'feishu',
    store,
  });
  return {
    reason: 'mention',
    shouldStartRuntime: true,
    subscription: subscriptionDecisionSummary(subscription),
  };
}

export async function consumeFeishuChannelFollow(
  event: FeishuInboxItem,
  options: { agentId?: string; duplicate?: boolean; nowMs?: number },
): Promise<FeishuRuntimeDecision> {
  const agentId = options.agentId ?? 'anima';
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const store = new SubscriptionStore(agentId);
  const existing = await store.find(channelSubscriptionId(agentId, event.chatId));
  if (existing?.mutedAt) {
    return {
      reason: 'muted',
      shouldStartRuntime: false,
      subscription: subscriptionDecisionSummary(existing),
    };
  }

  const base = existing?.kind === 'channel'
    ? existing
    : channelSubscriptionRecord(agentId, event.chatId, now, 'feishu');
  const { next, suggestion } = noteInboundWake(base, nowMs);
  if (!options.duplicate) await store.replace(next);
  return {
    ...(suggestion ? { attentionSuggestion: suggestion } : {}),
    reason: 'channel_follow',
    shouldStartRuntime: true,
    subscription: subscriptionDecisionSummary(next),
  };
}
