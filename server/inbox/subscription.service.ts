import {
  SubscriptionStore,
  subscriptionStatus,
  type SubscriptionRecord,
} from '../storage/schema/subscription.store.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import {
  feishuChatAttentionNote,
  slackChannelAttentionNote,
  slackThreadAttentionNote,
} from '../runtime/delivery-notes.js';

export { subscriptionStatus };
export type { SubscriptionRecord };

export const THREAD_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ATTENTION_NUDGE_WINDOW_MS = 60 * 60 * 1000;
const ATTENTION_NUDGE_WAKE_THRESHOLD = 6;
const ATTENTION_NUDGE_BACKOFF_MS = 24 * 60 * 60 * 1000;
const CHRONIC_NUDGE_WAKE_THRESHOLD = 12;
const CHRONIC_NUDGE_WINDOW_MS = 72 * 60 * 60 * 1000;

export type SubscriptionPlatform = 'slack' | 'feishu';

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

export interface SubscriptionDecisionSummary {
  status: 'following' | 'muted';
  subscriptionId: string;
  kind: SubscriptionRecord['kind'];
  threadTs?: string;
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
  platform?: SubscriptionPlatform;
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
  const platform = input.platform ?? legacyPlatformForChannelId(input.channelId);
  const base = {
    agentId: input.agentId,
    channelId: input.channelId,
    lastActivityAt: existing?.lastActivityAt ?? now,
    ...(existing?.lastNudgeAt ? { lastNudgeAt: existing.lastNudgeAt } : {}),
    ...(existing?.lastPostedAt ? { lastPostedAt: existing.lastPostedAt } : {}),
    mutedAt: existing?.mutedAt ?? now,
    ...(existing ? (existing.platform ? { platform: existing.platform } : {}) : { platform }),
    ...(existing?.silentWakeStartedAt ? { silentWakeStartedAt: existing.silentWakeStartedAt } : {}),
    subscriptionId,
    updatedAt: now,
    ...(existing?.wakeCount !== undefined ? { wakeCount: existing.wakeCount } : {}),
    ...(existing?.wakeWindowStartedAt ? { wakeWindowStartedAt: existing.wakeWindowStartedAt } : {}),
    ...(existing?.wakesSinceLastPost !== undefined ? { wakesSinceLastPost: existing.wakesSinceLastPost } : {}),
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

export async function recordOutboundEngagement(input: {
  agentId: string;
  channelId: string;
  nowMs?: number;
  threadTs?: string;
}): Promise<SubscriptionRecord[]> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const store = new SubscriptionStore(input.agentId);
  const updated: SubscriptionRecord[] = [];
  const channel = await store.find(channelSubscriptionId(input.agentId, input.channelId));
  if (channel?.kind === 'channel') {
    updated.push(await store.replace(noteOutboundEngagement(channel, now)));
  }
  if (input.threadTs) {
    const thread = await store.find(threadSubscriptionId(input.agentId, input.channelId, input.threadTs));
    if (thread?.kind === 'thread') {
      updated.push(await store.replace(noteOutboundEngagement(thread, now)));
    }
  }
  return updated;
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
    platform: 'slack',
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
      platform: 'slack',
      posted: true,
      store,
      threadTs: input.messageTs,
      unmute: true,
    });
  }
  return primary;
}

export function followThread(input: {
  agentId: string;
  channelId: string;
  now: string;
  platform: SubscriptionPlatform;
  posted?: boolean;
  store: SubscriptionStore;
  threadTs: string;
  unmute?: boolean;
}): Promise<SubscriptionRecord> {
  return input.store.find(threadSubscriptionId(input.agentId, input.channelId, input.threadTs))
    .then((existing) => {
      const base = existing?.kind === 'thread'
        ? existing
        : threadSubscriptionRecord(input.agentId, input.channelId, input.threadTs, input.now, input.platform);
      return input.store.replace({
        ...base,
        lastActivityAt: input.now,
        ...(input.posted ? {
          lastPostedAt: input.now,
          silentWakeStartedAt: undefined,
          wakeCount: 0,
          wakeWindowStartedAt: input.now,
          wakesSinceLastPost: 0,
        } : {}),
        ...(input.unmute ? { mutedAt: undefined } : {}),
        updatedAt: input.now,
      });
    });
}

export function followChannel(input: {
  agentId: string;
  channelId: string;
  now: string;
  platform: SubscriptionPlatform;
  store: SubscriptionStore;
}): Promise<SubscriptionRecord> {
  return input.store.find(channelSubscriptionId(input.agentId, input.channelId))
    .then((existing) => {
      const base = existing?.kind === 'channel'
        ? existing
        : channelSubscriptionRecord(input.agentId, input.channelId, input.now, input.platform);
      return input.store.replace({
        ...base,
        lastActivityAt: input.now,
        updatedAt: input.now,
      });
    });
}

export function channelSubscriptionRecord(
  agentId: string,
  channelId: string,
  now: string,
  platform: SubscriptionPlatform,
): SubscriptionRecord {
  return {
    agentId,
    channelId,
    kind: 'channel',
    lastActivityAt: now,
    platform,
    subscriptionId: channelSubscriptionId(agentId, channelId),
    updatedAt: now,
  };
}

export function noteInboundWake(
  subscription: SubscriptionRecord,
  nowMs: number,
): { next: SubscriptionRecord; suggestion?: string } {
  const now = new Date(nowMs).toISOString();
  const { continued: wakeWindowContinued, startMs: windowStartMs } = wakeWindowState(subscription, nowMs);
  const windowStart = new Date(windowStartMs).toISOString();
  const postedAtMs = parseTime(subscription.lastPostedAt);
  const postedInWindow = postedAtMs !== undefined && postedAtMs >= windowStartMs;
  const wakeCount = postedInWindow
    ? 1
    : (wakeWindowContinued ? (subscription.wakeCount ?? 0) : 0) + 1;
  const canSuggestBurst =
    wakeCount >= ATTENTION_NUDGE_WAKE_THRESHOLD &&
    !postedInWindow &&
    lastNudgeAllowsSuggestion(subscription, nowMs);
  const chronic = chronicWakeState(subscription, nowMs);
  const canSuggestChronic =
    chronic.wakesSinceLastPost >= CHRONIC_NUDGE_WAKE_THRESHOLD &&
    nowMs - chronic.baselineMs >= CHRONIC_NUDGE_WINDOW_MS &&
    lastNudgeAllowsSuggestion(subscription, nowMs);
  const suggestion = composeAttentionSuggestion({
    burst: canSuggestBurst,
    chronic: canSuggestChronic,
    subscription,
  });
  const next: SubscriptionRecord = {
    ...subscription,
    lastActivityAt: now,
    updatedAt: now,
    silentWakeStartedAt: canSuggestChronic ? undefined : chronic.silentWakeStartedAt,
    wakeCount: suggestion ? 0 : wakeCount,
    wakeWindowStartedAt: suggestion ? now : windowStart,
    wakesSinceLastPost: canSuggestChronic ? 0 : chronic.wakesSinceLastPost,
    ...(suggestion ? { lastNudgeAt: now } : {}),
  };
  return {
    next,
    ...(suggestion ? { suggestion } : {}),
  };
}

export function subscriptionDecisionSummary(subscription: SubscriptionRecord): SubscriptionDecisionSummary {
  return {
    status: subscriptionStatus(subscription),
    subscriptionId: subscription.subscriptionId,
    kind: subscription.kind,
    ...(subscription.kind === 'thread' ? { threadTs: subscription.threadTs } : {}),
  };
}

export function platformForSubscription(subscription: SubscriptionRecord): SubscriptionPlatform {
  return subscription.platform ?? legacyPlatformForChannelId(subscription.channelId);
}

export function channelSubscriptionId(agentId: string, channelId: string): string {
  return `slack-subscription:${agentId}:${channelId}:channel`;
}

export function threadSubscriptionId(agentId: string, channelId: string, threadTs: string): string {
  return `slack-subscription:${agentId}:${channelId}:thread:${threadTs}`;
}

function threadSubscriptionRecord(
  agentId: string,
  channelId: string,
  threadTs: string,
  now: string,
  platform: SubscriptionPlatform,
): SubscriptionRecord {
  return {
    agentId,
    channelId,
    kind: 'thread',
    lastActivityAt: now,
    platform,
    subscriptionId: threadSubscriptionId(agentId, channelId, threadTs),
    threadTs,
    updatedAt: now,
  };
}

function noteOutboundEngagement(subscription: SubscriptionRecord, now: string): SubscriptionRecord {
  return {
    ...subscription,
    lastActivityAt: now,
    lastPostedAt: now,
    silentWakeStartedAt: undefined,
    updatedAt: now,
    wakeCount: 0,
    wakeWindowStartedAt: now,
    wakesSinceLastPost: 0,
  };
}

function wakeWindowState(subscription: SubscriptionRecord, nowMs: number): { continued: boolean; startMs: number } {
  const existing = parseTime(subscription.wakeWindowStartedAt);
  if (existing !== undefined && nowMs - existing <= ATTENTION_NUDGE_WINDOW_MS) {
    return { continued: true, startMs: existing };
  }
  return { continued: false, startMs: nowMs };
}

function lastNudgeAllowsSuggestion(subscription: SubscriptionRecord, nowMs: number): boolean {
  const nudgedAt = parseTime(subscription.lastNudgeAt);
  return nudgedAt === undefined || nowMs - nudgedAt >= ATTENTION_NUDGE_BACKOFF_MS;
}

function chronicWakeState(
  subscription: SubscriptionRecord,
  nowMs: number,
): { baselineMs: number; silentWakeStartedAt?: string; wakesSinceLastPost: number } {
  const lastPostedAtMs = parseTime(subscription.lastPostedAt);
  const existingStartMs = parseTime(subscription.silentWakeStartedAt);
  const existingStartIsValid =
    existingStartMs !== undefined && (lastPostedAtMs === undefined || existingStartMs > lastPostedAtMs);
  const silentWakeStartedAtMs = existingStartIsValid ? existingStartMs : nowMs;
  const silentWakeStartedAt = new Date(silentWakeStartedAtMs).toISOString();
  return {
    baselineMs: lastPostedAtMs ?? silentWakeStartedAtMs,
    silentWakeStartedAt,
    wakesSinceLastPost: existingStartIsValid ? (subscription.wakesSinceLastPost ?? 0) + 1 : 1,
  };
}

function composeAttentionSuggestion(input: {
  burst: boolean;
  chronic: boolean;
  subscription: SubscriptionRecord;
}): string | undefined {
  if (!input.burst && !input.chronic) return undefined;
  return attentionSuggestionFor(input.subscription);
}

function attentionSuggestionFor(subscription: SubscriptionRecord): string {
  const isFeishuChat = subscription.kind === 'channel' && platformForSubscription(subscription) === 'feishu';
  if (subscription.kind === 'thread') {
    return slackThreadAttentionNote(subscription.channelId, subscription.threadTs);
  }
  if (isFeishuChat) {
    return feishuChatAttentionNote(subscription.channelId);
  }
  return slackChannelAttentionNote(subscription.channelId);
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

function legacyPlatformForChannelId(channelId: string): SubscriptionPlatform {
  return channelId.startsWith('oc_') ? 'feishu' : 'slack';
}
