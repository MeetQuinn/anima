import {
  SubscriptionStore,
  subscriptionStatus,
  type SubscriptionRecord,
} from '../storage/schema/subscription.store.js';
import { activityServiceForAgent } from '../activities/activity.service.js';

export { subscriptionStatus };
export type { SubscriptionRecord };

export const THREAD_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ATTENTION_NUDGE_WINDOW_MS = 60 * 60 * 1000;
const ATTENTION_NUDGE_WAKE_THRESHOLD = 6;
const ATTENTION_NUDGE_BACKOFF_MS = 24 * 60 * 60 * 1000;

interface SlackRuntimeMessageEvent {
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type?: string;
  user?: string;
}

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

export interface AttentionMap {
  activeThreads: SubscriptionRecord[];
  channels: Array<{
    channelId: string;
    channelName?: string;
    status: 'following' | 'muted';
    subscription?: SubscriptionRecord;
  }>;
  mutedThreads: SubscriptionRecord[];
  quietThreadCount: number;
  quietThreads: SubscriptionRecord[];
}

export function shouldReply(
  event: SlackRuntimeMessageEvent,
): boolean {
  return immediateSlackRuntimeReason(event) !== undefined;
}

export async function listSubscriptionsForAgent(agentId: string): Promise<SubscriptionRecord[]> {
  return new SubscriptionStore(agentId).list();
}

export function attentionMapForSubscriptions(input: {
  includeAll?: boolean;
  memberChannels?: Array<{ id: string; name?: string }>;
  nowMs?: number;
  subscriptions: SubscriptionRecord[];
}): AttentionMap {
  const nowMs = input.nowMs ?? Date.now();
  const channelById = new Map<string, AttentionMap['channels'][number]>();
  for (const channel of input.memberChannels ?? []) {
    channelById.set(channel.id, {
      channelId: channel.id,
      ...(channel.name ? { channelName: channel.name } : {}),
      status: 'following',
    });
  }
  for (const subscription of input.subscriptions) {
    if (subscription.kind !== 'channel') continue;
    const existing = channelById.get(subscription.channelId);
    channelById.set(subscription.channelId, {
      channelId: subscription.channelId,
      ...(existing?.channelName ? { channelName: existing.channelName } : {}),
      status: subscriptionStatus(subscription),
      subscription,
    });
  }

  const activeThreads: SubscriptionRecord[] = [];
  const mutedThreads: SubscriptionRecord[] = [];
  const quietThreads: SubscriptionRecord[] = [];
  for (const subscription of input.subscriptions) {
    if (subscription.kind !== 'thread') continue;
    if (subscription.mutedAt) {
      mutedThreads.push(subscription);
      continue;
    }
    if (threadRecentlyActive(subscription, nowMs)) {
      activeThreads.push(subscription);
    } else {
      quietThreads.push(subscription);
    }
  }

  const byUpdatedDesc = (a: SubscriptionRecord, b: SubscriptionRecord) =>
    subscriptionActivityAt(b).localeCompare(subscriptionActivityAt(a));
  activeThreads.sort(byUpdatedDesc);
  mutedThreads.sort(byUpdatedDesc);
  quietThreads.sort(byUpdatedDesc);

  return {
    channels: [...channelById.values()].sort((a, b) =>
      (a.channelName ?? a.channelId).localeCompare(b.channelName ?? b.channelId),
    ),
    activeThreads,
    mutedThreads,
    quietThreadCount: quietThreads.length,
    quietThreads: input.includeAll ? quietThreads : [],
  };
}

export async function muteSubscriptionForAgent(input: {
  agentId: string;
  channelId: string;
  channelName?: string;
  threadTs?: string;
  nowMs?: number;
}): Promise<SubscriptionRecord> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const store = new SubscriptionStore(input.agentId);
  const subscriptionId = input.threadTs
    ? threadSubscriptionId(input.agentId, input.channelId, input.threadTs)
    : channelSubscriptionId(input.agentId, input.channelId);
  const existing = await store.find(subscriptionId);
  const base = {
    agentId: input.agentId,
    channelId: input.channelId,
    lastActivityAt: existing?.lastActivityAt ?? now,
    ...(existing?.lastNudgeAt ? { lastNudgeAt: existing.lastNudgeAt } : {}),
    ...(existing?.lastPostedAt ? { lastPostedAt: existing.lastPostedAt } : {}),
    mutedAt: existing?.mutedAt ?? now,
    subscriptionId,
    updatedAt: now,
    ...(existing?.wakeCount !== undefined ? { wakeCount: existing.wakeCount } : {}),
    ...(existing?.wakeWindowStartedAt ? { wakeWindowStartedAt: existing.wakeWindowStartedAt } : {}),
  };
  const muted = await store.replace(input.threadTs
    ? { ...base, kind: 'thread', threadTs: input.threadTs }
    : { ...base, kind: 'channel' });
  await activityServiceForAgent(input.agentId).record({
    type: 'anima.subscription.mute',
    payload: {
      channelId: input.channelId,
      ...(input.channelName ? { channelName: input.channelName } : {}),
      kind: muted.kind,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    },
  });
  return muted;
}

export async function slackRuntimeDecision(
  event: SlackRuntimeMessageEvent,
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
  event: SlackRuntimeMessageEvent,
): SlackRuntimeDecision['reason'] | undefined {
  if (event.channel_type === 'im') return 'dm';
  if (event.type === 'app_mention') return 'mention';
  return undefined;
}

async function activateMentionFollow(
  event: SlackRuntimeMessageEvent,
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
  event: SlackRuntimeMessageEvent,
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
  event: SlackRuntimeMessageEvent,
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
    : channelSubscriptionRecord(agentId, event.channel, now);
  const { next, suggestion } = noteInboundWake(base, nowMs);
  if (!options.duplicate) await store.replace(next);
  return {
    ...(suggestion ? { attentionSuggestion: suggestion } : {}),
    reason: 'channel_follow',
    shouldStartRuntime: true,
    subscription: subscriptionDecisionSummary(next),
  };
}

export async function recordChannelPost(input: {
  agentId: string;
  channelId: string;
  nowMs?: number;
}): Promise<SubscriptionRecord | undefined> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const store = new SubscriptionStore(input.agentId);
  const existing = await store.find(channelSubscriptionId(input.agentId, input.channelId));
  if (existing?.kind !== 'channel') return undefined;
  const next = {
    ...noteOutboundPost(existing, now),
    ...(existing.mutedAt ? { mutedAt: existing.mutedAt } : {}),
  };
  return store.replace(next);
}

export async function ensureThreadSubscriptionForSentMessage(input: {
  agentId: string;
  channelId: string;
  messageTs: string;
  nowMs?: number;
  threadTs?: string;
}): Promise<SubscriptionRecord | undefined> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const threadTs = input.threadTs || input.messageTs;
  const store = new SubscriptionStore(input.agentId);
  const primary = await followThread({
    agentId: input.agentId,
    channelId: input.channelId,
    now,
    posted: true,
    store,
    threadTs,
    unmute: true,
  });
  if (input.threadTs && input.messageTs !== input.threadTs) {
    await followThread({
      agentId: input.agentId,
      channelId: input.channelId,
      now,
      posted: true,
      store,
      threadTs: input.messageTs,
      unmute: true,
    });
  }
  return primary;
}

function followThread(input: {
  agentId: string;
  channelId: string;
  now: string;
  posted?: boolean;
  store: SubscriptionStore;
  threadTs: string;
  unmute?: boolean;
}): Promise<SubscriptionRecord> {
  return input.store.find(threadSubscriptionId(input.agentId, input.channelId, input.threadTs))
    .then((existing) => {
      const base = existing?.kind === 'thread'
        ? existing
        : threadSubscriptionRecord(input.agentId, input.channelId, input.threadTs, input.now);
      return input.store.replace({
        ...base,
        lastActivityAt: input.now,
        ...(input.posted ? { lastPostedAt: input.now, wakeCount: 0, wakeWindowStartedAt: input.now } : {}),
        ...(input.unmute ? { mutedAt: undefined } : {}),
        updatedAt: input.now,
      });
    });
}

function threadSubscriptionRecord(
  agentId: string,
  channelId: string,
  threadTs: string,
  now: string,
): SubscriptionRecord {
  return {
    agentId,
    channelId,
    kind: 'thread',
    lastActivityAt: now,
    subscriptionId: threadSubscriptionId(agentId, channelId, threadTs),
    threadTs,
    updatedAt: now,
  };
}

function channelSubscriptionRecord(agentId: string, channelId: string, now: string): SubscriptionRecord {
  return {
    agentId,
    channelId,
    kind: 'channel',
    lastActivityAt: now,
    subscriptionId: channelSubscriptionId(agentId, channelId),
    updatedAt: now,
  };
}

function noteInboundWake(
  subscription: SubscriptionRecord,
  nowMs: number,
): { next: SubscriptionRecord; suggestion?: string } {
  const now = new Date(nowMs).toISOString();
  const windowStartMs = wakeWindowStartMs(subscription, nowMs);
  const windowStart = new Date(windowStartMs).toISOString();
  const postedAtMs = parseTime(subscription.lastPostedAt);
  const postedInWindow = postedAtMs !== undefined && postedAtMs >= windowStartMs;
  const wakeCount = postedInWindow ? 1 : (subscription.wakeCount ?? 0) + 1;
  const canSuggest =
    wakeCount >= ATTENTION_NUDGE_WAKE_THRESHOLD &&
    !postedInWindow &&
    lastNudgeAllowsSuggestion(subscription, nowMs);
  const next: SubscriptionRecord = {
    ...subscription,
    lastActivityAt: now,
    updatedAt: now,
    wakeCount: canSuggest ? 0 : wakeCount,
    wakeWindowStartedAt: canSuggest ? now : windowStart,
    ...(canSuggest ? { lastNudgeAt: now } : {}),
  };
  return {
    next,
    ...(canSuggest ? { suggestion: attentionSuggestionFor(subscription) } : {}),
  };
}

function noteOutboundPost(subscription: SubscriptionRecord, now: string): SubscriptionRecord {
  return {
    ...subscription,
    lastActivityAt: now,
    lastPostedAt: now,
    mutedAt: undefined,
    updatedAt: now,
    wakeCount: 0,
    wakeWindowStartedAt: now,
  };
}

function wakeWindowStartMs(subscription: SubscriptionRecord, nowMs: number): number {
  const existing = parseTime(subscription.wakeWindowStartedAt);
  if (existing !== undefined && nowMs - existing <= ATTENTION_NUDGE_WINDOW_MS) return existing;
  return nowMs;
}

function lastNudgeAllowsSuggestion(subscription: SubscriptionRecord, nowMs: number): boolean {
  const nudgedAt = parseTime(subscription.lastNudgeAt);
  return nudgedAt === undefined || nowMs - nudgedAt >= ATTENTION_NUDGE_BACKOFF_MS;
}

function attentionSuggestionFor(subscription: SubscriptionRecord): string {
  const target = subscription.kind === 'thread'
    ? `thread ${subscription.threadTs} in ${subscription.channelId}`
    : `channel ${subscription.channelId}`;
  const command = subscription.kind === 'thread'
    ? `anima subscription mute --channel ${subscription.channelId} --thread-ts ${subscription.threadTs}`
    : `anima subscription mute --channel ${subscription.channelId}`;
  return `You've been reading ${target} without posting. If it is not relevant, mute it with \`${command}\`.`;
}

function threadRecentlyActive(subscription: SubscriptionRecord, nowMs: number): boolean {
  const timestamp = parseTime(subscriptionActivityAt(subscription));
  return timestamp !== undefined && nowMs - timestamp <= THREAD_ACTIVE_WINDOW_MS;
}

function subscriptionActivityAt(subscription: SubscriptionRecord): string {
  return subscription.lastActivityAt ?? subscription.updatedAt;
}

function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function subscriptionDecisionSummary(subscription: SubscriptionRecord): NonNullable<SlackRuntimeDecision['subscription']> {
  return {
    status: subscriptionStatus(subscription),
    subscriptionId: subscription.subscriptionId,
    kind: subscription.kind,
    ...(subscription.kind === 'thread' ? { threadTs: subscription.threadTs } : {}),
  };
}

function isThreadReply(event: SlackRuntimeMessageEvent): boolean {
  return Boolean(event.thread_ts && event.thread_ts !== event.ts);
}

function threadTsForMention(event: SlackRuntimeMessageEvent): string | undefined {
  return event.thread_ts || event.ts;
}

function channelSubscriptionId(agentId: string, channelId: string): string {
  return `slack-subscription:${agentId}:${channelId}:channel`;
}

function threadSubscriptionId(agentId: string, channelId: string, threadTs: string): string {
  return `slack-subscription:${agentId}:${channelId}:thread:${threadTs}`;
}
