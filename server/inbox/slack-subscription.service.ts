import { SubscriptionStore } from '../storage/schema/subscription.store.js';
import type { SlackRawMessageEvent } from './slack-events.js';
import {
  channelSubscriptionId,
  channelSubscriptionRecord,
  followThread,
  noteInboundWake,
  subscriptionDecisionSummary,
  threadSubscriptionId,
  type SubscriptionRecord,
} from './subscription.service.js';

export interface SlackRuntimeDecision {
  attentionSuggestion?: string;
  subscription?: {
    status: 'following' | 'muted';
    subscriptionId: string;
    kind: SubscriptionRecord['kind'];
    threadTs?: string;
  };
  reason: 'channel_follow' | 'dm' | 'mention' | 'muted' | 'not_addressed' | 'thread_follow';
  shouldStartRuntime: boolean;
}

export function shouldReply(
  event: SlackRawMessageEvent,
): boolean {
  return immediateSlackRuntimeReason(event) !== undefined;
}

export async function slackRuntimeDecision(
  event: SlackRawMessageEvent,
  options: { agentId?: string; duplicate?: boolean; nowMs?: number },
): Promise<SlackRuntimeDecision> {
  const immediateReason = immediateSlackRuntimeReason(event);
  if (immediateReason) {
    if (immediateReason === 'mention') {
      return activateMentionFollow(event, options);
    }
    return { reason: immediateReason, shouldStartRuntime: true };
  }
  if (isThreadReply(event)) {
    return consumeThreadFollow(event, options);
  }
  return consumeChannelFollow(event, options);
}

function immediateSlackRuntimeReason(
  event: SlackRawMessageEvent,
): SlackRuntimeDecision['reason'] | undefined {
  if (event.channel_type === 'im') return 'dm';
  if (event.type === 'app_mention') return 'mention';
  return undefined;
}

async function activateMentionFollow(
  event: SlackRawMessageEvent,
  options: { agentId?: string; duplicate?: boolean; nowMs?: number },
): Promise<SlackRuntimeDecision> {
  const agentId = options.agentId ?? 'anima';
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const threadTs = threadTsForMention(event);
  if (!event.channel || !threadTs || event.channel_type === 'im') {
    return { reason: 'mention', shouldStartRuntime: true };
  }
  if (options.duplicate) return { reason: 'mention', shouldStartRuntime: true };

  const store = new SubscriptionStore(agentId);
  const subscription = await followThread({
    agentId,
    channelId: event.channel,
    now,
    platform: 'slack',
    store,
    threadTs,
    unmute: true,
  });
  return {
    reason: 'mention',
    shouldStartRuntime: true,
    subscription: subscriptionDecisionSummary(subscription),
  };
}

async function consumeThreadFollow(
  event: SlackRawMessageEvent,
  options: { agentId?: string; duplicate?: boolean; nowMs?: number },
): Promise<SlackRuntimeDecision> {
  const agentId = options.agentId ?? 'anima';
  if (!event.channel || !event.thread_ts) return { reason: 'not_addressed', shouldStartRuntime: false };

  const store = new SubscriptionStore(agentId);
  const subscription = await store.find(threadSubscriptionId(agentId, event.channel, event.thread_ts));
  if (!subscription || subscription.kind !== 'thread') return { reason: 'not_addressed', shouldStartRuntime: false };
  if (subscription.mutedAt) {
    return {
      reason: 'muted',
      shouldStartRuntime: false,
      subscription: subscriptionDecisionSummary(subscription),
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const { next, suggestion } = noteInboundWake(subscription, nowMs);
  if (!options.duplicate) await store.replace(next);
  return {
    ...(suggestion ? { attentionSuggestion: suggestion } : {}),
    reason: 'thread_follow',
    shouldStartRuntime: true,
    subscription: subscriptionDecisionSummary(next),
  };
}

async function consumeChannelFollow(
  event: SlackRawMessageEvent,
  options: { agentId?: string; duplicate?: boolean; nowMs?: number },
): Promise<SlackRuntimeDecision> {
  const agentId = options.agentId ?? 'anima';
  if (!event.channel || event.channel_type === 'im') return { reason: 'not_addressed', shouldStartRuntime: false };

  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const store = new SubscriptionStore(agentId);
  const existing = await store.find(channelSubscriptionId(agentId, event.channel));
  if (existing?.mutedAt) {
    return {
      reason: 'muted',
      shouldStartRuntime: false,
      subscription: subscriptionDecisionSummary(existing),
    };
  }
  const base = existing?.kind === 'channel'
    ? existing
    : channelSubscriptionRecord(agentId, event.channel, now, 'slack');
  const { next, suggestion } = noteInboundWake(base, nowMs);
  if (!options.duplicate) await store.replace(next);
  return {
    ...(suggestion ? { attentionSuggestion: suggestion } : {}),
    reason: 'channel_follow',
    shouldStartRuntime: true,
    subscription: subscriptionDecisionSummary(next),
  };
}

function isThreadReply(event: SlackRawMessageEvent): boolean {
  return Boolean(event.thread_ts && event.thread_ts !== event.ts);
}

function threadTsForMention(event: SlackRawMessageEvent): string | undefined {
  return event.thread_ts || event.ts;
}
