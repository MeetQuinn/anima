import {
  listSubscriptionsForAgent,
  platformForSubscription,
  subscriptionStatus,
  type SubscriptionRecord,
} from '../inbox/subscription.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import {
  resolveAvatarsForUsers,
  SLACK_USER_ID,
  type AvatarEnrichmentDeps,
} from './message-profiles.js';
import type {
  AgentChannelListResponse,
  AgentChannelSummary,
  AgentMessageRecord,
} from '../../shared/messages.js';

export const CHANNEL_LIST_MESSAGE_WINDOW = 3_000;

// Slack channel IDs are prefixed by kind: D = 1:1 DM, everything else (C public,
// G private/mpim) is a channel. Lets a DM that was muted as a subscription still
// render with the right kind.
function kindForChannelId(id: string): 'channel' | 'dm' {
  return id.startsWith('D') ? 'dm' : 'channel';
}

function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b; // ISO-8601 strings compare lexicographically
}

function subscriptionActivityAt(subscription: SubscriptionRecord): string {
  return subscription.lastActivityAt ?? subscription.lastPostedAt ?? subscription.updatedAt;
}

function bestSubscriptionByChannel(subscriptions: SubscriptionRecord[]): Map<string, SubscriptionRecord> {
  const byChannel = new Map<string, SubscriptionRecord>();
  for (const subscription of subscriptions) {
    if (subscription.kind !== 'channel') continue;
    if (platformForSubscription(subscription) === 'feishu') continue;
    const existing = byChannel.get(subscription.channelId);
    if (!existing || subscriptionActivityAt(subscription) > subscriptionActivityAt(existing)) {
      byChannel.set(subscription.channelId, subscription);
    }
  }
  return byChannel;
}

function isSlackSurfaceMessage(message: AgentMessageRecord): boolean {
  if (message.platform && message.platform !== 'slack') return false;
  const id = message.channelId?.trim();
  return Boolean(id && !id.startsWith('oc_'));
}

function cleanChannelName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('#')) return trimmed.slice(1);
  if (trimmed.startsWith('DM with @')) return trimmed.slice('DM with @'.length);
  if (trimmed.startsWith('DM with ')) return trimmed.slice('DM with '.length);
  if (trimmed.startsWith('@')) return trimmed.slice(1);
  return trimmed;
}

function displayNameForMessage(message: AgentMessageRecord, kind: 'channel' | 'dm'): string | undefined {
  if (kind === 'dm') {
    return cleanChannelName(message.dmHandle)
      ?? cleanChannelName(message.channelDisplayName)
      ?? cleanChannelName(message.actorHandle)
      ?? cleanChannelName(message.actorDisplayName)
      ?? cleanChannelName(message.actor);
  }
  return cleanChannelName(message.channelName) ?? cleanChannelName(message.channelDisplayName);
}

// Pure composition: recent local message-history conversations plus active
// channel subscriptions. Subscriptions overlay muted/following status and
// activity timestamps, and channel subscriptions create rows for subscribed but
// quiet channels.
export function composeChannelList(input: {
  subscriptions: SubscriptionRecord[];
  messages: AgentMessageRecord[];
}): AgentChannelListResponse {
  const byId = new Map<string, AgentChannelSummary>();

  for (const message of input.messages) {
    if (!isSlackSurfaceMessage(message)) continue;
    const id = message.channelId!.trim();
    const kind = kindForChannelId(id);
    const name = displayNameForMessage(message, kind);
    const existing = byId.get(id);
    if (existing) {
      if (name && !existing.name) existing.name = name;
      existing.lastActivityAt = laterOf(existing.lastActivityAt, message.timestamp);
      if (message.direction === 'out') {
        existing.lastPostedAt = laterOf(existing.lastPostedAt, message.timestamp);
      }
      if (kind === 'dm' && !existing.avatarUrl && message.direction === 'in' && message.actorAvatarUrl) {
        existing.avatarUrl = message.actorAvatarUrl;
      }
      continue;
    }
    byId.set(id, {
      id,
      ...(name ? { name } : {}),
      platform: 'slack',
      kind,
      status: 'following',
      ...(message.timestamp ? { lastActivityAt: message.timestamp } : {}),
      ...(message.direction === 'out' ? { lastPostedAt: message.timestamp } : {}),
      ...(kind === 'dm' && message.direction === 'in' && message.actorAvatarUrl
        ? { avatarUrl: message.actorAvatarUrl }
        : {}),
    });
  }

  const subscriptionByChannel = bestSubscriptionByChannel(input.subscriptions);
  for (const [channelId, subscription] of subscriptionByChannel) {
    const channel = byId.get(channelId);
    if (channel) {
      channel.status = subscriptionStatus(subscription);
      channel.lastActivityAt = laterOf(channel.lastActivityAt, subscription.lastActivityAt);
      channel.lastPostedAt = laterOf(channel.lastPostedAt, subscription.lastPostedAt);
      continue;
    }
    const subscribedChannel: AgentChannelSummary = {
      id: channelId,
      platform: 'slack',
      kind: kindForChannelId(channelId),
      status: subscriptionStatus(subscription),
    };
    if (subscription.lastActivityAt) subscribedChannel.lastActivityAt = subscription.lastActivityAt;
    if (subscription.lastPostedAt) subscribedChannel.lastPostedAt = subscription.lastPostedAt;
    byId.set(channelId, subscribedChannel);
  }

  const channels = [...byId.values()].sort((a, b) => {
    const byActivity = (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
    if (byActivity !== 0) return byActivity;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });
  return { channels };
}

// Map each local Slack DM surface to its counterpart's Slack user id, the only
// id the master list needs an avatar for. Inbound DM messages carry the sender
// as `actorUserId`; an outbound-only DM (the agent messaged first) carries the
// counterpart as `dmUserId`. Channels are skipped entirely, so opening the
// master list never resolves avatars for arbitrary channel senders — that would
// recreate the cold-cache users.info fan-out this route was moved away from.
// First valid counterpart per DM wins; messages lacking a counterpart id are
// passed over so a later message for the same DM can still supply one.
function dmCounterpartsByChannel(messages: AgentMessageRecord[]): Map<string, string> {
  const byChannel = new Map<string, string>();
  for (const message of messages) {
    if (!isSlackSurfaceMessage(message)) continue;
    const id = message.channelId!.trim();
    if (kindForChannelId(id) !== 'dm') continue;
    if (byChannel.has(id)) continue;
    const counterpart = message.direction === 'in' ? message.actorUserId : message.dmUserId;
    if (counterpart && SLACK_USER_ID.test(counterpart)) byChannel.set(id, counterpart);
  }
  return byChannel;
}

// IO wrapper: fetch bounded local message history + subscription overlay. The durable
// message ledger never persists sender avatars, so DM rows would render from
// raw records with no photo and fall back to the initial letter, even though
// the detail-pane bylines (served by the already-enriched /messages route) show
// the real photo. We close that gap read-time, but scoped to DM counterparts
// only: resolving one avatar per unique DM counterpart through the same
// cache-first resolver the /messages feed shares. A miss costs one users.info
// per unique DM counterpart and any failure leaves the avatar unset, so this
// stays a fast local-history view, not a Slack membership inventory. deps stay
// injectable so the enrichment is unit-testable without real Slack IO.
export async function buildAgentChannelList(
  agentId: string,
  deps?: AvatarEnrichmentDeps,
): Promise<AgentChannelListResponse> {
  const [subscriptions, messages] = await Promise.all([
    listSubscriptionsForAgent(agentId),
    messageServiceForAgent(agentId).listLatest({ limit: CHANNEL_LIST_MESSAGE_WINDOW }),
  ]);

  const dmCounterparts = dmCounterpartsByChannel(messages);
  const avatarByUser = await resolveAvatarsForUsers(agentId, dmCounterparts.values(), deps);

  const list = composeChannelList({ subscriptions, messages });
  if (avatarByUser.size > 0) {
    for (const channel of list.channels) {
      if (channel.kind !== 'dm' || channel.avatarUrl) continue;
      const counterpart = dmCounterparts.get(channel.id);
      const avatarUrl = counterpart ? avatarByUser.get(counterpart) : undefined;
      if (avatarUrl) channel.avatarUrl = avatarUrl;
    }
  }
  return list;
}
