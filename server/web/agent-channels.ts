import {
  listSubscriptionsForAgent,
  subscriptionStatus,
  type SubscriptionRecord,
} from '../inbox/slack-subscription.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import type {
  AgentChannelListResponse,
  AgentChannelSummary,
  AgentMessageRecord,
} from '../../shared/messages.js';

function isFeishuChatId(id: string): boolean {
  return id.startsWith('oc_');
}

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
    if (isFeishuChatId(subscription.channelId)) continue;
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
  return Boolean(id && !isFeishuChatId(id));
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

// Pure composition: local message-history conversations only. A channel or DM
// appears if the agent has at least one local Slack message for that surface.
// Subscriptions overlay muted/following status and activity timestamps, but they
// never create rows by themselves. That intentionally means silent adds are not
// listed, and historical channels remain visible if the local ledger has them.
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
    if (!channel) continue;
    channel.status = subscriptionStatus(subscription);
    channel.lastActivityAt = laterOf(channel.lastActivityAt, subscription.lastActivityAt);
    channel.lastPostedAt = laterOf(channel.lastPostedAt, subscription.lastPostedAt);
  }

  const channels = [...byId.values()].sort((a, b) => {
    const byActivity = (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
    if (byActivity !== 0) return byActivity;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });
  return { channels };
}

// IO wrapper: fetch local message history + subscription overlay only. This
// intentionally does not call Slack; the Channels tab is a fast conversation
// history view, not a current Slack membership inventory.
export async function buildAgentChannelList(agentId: string): Promise<AgentChannelListResponse> {
  const [subscriptions, messages] = await Promise.all([
    listSubscriptionsForAgent(agentId),
    messageServiceForAgent(agentId).listAll(),
  ]);
  return composeChannelList({
    subscriptions,
    messages,
  });
}
