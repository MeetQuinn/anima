import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { memberChannelsResultForAgent, type MemberChannel } from '../inbox/member-channels.js';
import {
  attentionMapForSubscriptions,
  listSubscriptionsForAgent,
  type SubscriptionRecord,
} from '../inbox/slack-subscription.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import type {
  AgentChannelListResponse,
  AgentChannelSummary,
  AgentMessageRecord,
} from '../../shared/messages.js';

// How many recent messages to scan when folding DMs out of the message feed.
// 1:1 DMs have no Slack "membership", so they only surface here; the channel
// list itself comes from authoritative `is_member` data.
const DM_SCAN_LIMIT = 500;

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

// Pure composition: given the agent's real member channels, subscription
// records, and a slice of message history, produce the Slack-only channel +
// DM list sorted by most recent activity. No IO, so directly unit-testable.
export function composeChannelList(input: {
  memberChannels: MemberChannel[];
  subscriptions: SubscriptionRecord[];
  messages: AgentMessageRecord[];
  // True when the authoritative `is_member` lookup succeeded (the happy path).
  // Then a Slack *channel* row must be backed by real membership; a stale
  // followed/muted subscription for a channel the agent was removed from must
  // NOT appear. When false (membership lookup degraded), subscription-derived
  // rows are kept as a best-effort fallback under `membershipPartial`. DMs are
  // exempt either way (1:1 IMs have no `is_member` concept). Defaults to true.
  membershipComplete?: boolean;
  nowMs?: number;
}): AgentChannelListResponse {
  const membershipComplete = input.membershipComplete ?? true;
  const memberIds = new Set(input.memberChannels.map((channel) => channel.id));
  const map = attentionMapForSubscriptions({
    memberChannels: input.memberChannels,
    subscriptions: input.subscriptions,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });

  const byId = new Map<string, AgentChannelSummary>();
  for (const channel of map.channels) {
    if (isFeishuChatId(channel.channelId)) continue; // Slack only in v1
    // Honesty bar: on a successful membership lookup, channel rows come from
    // real `is_member` data only. attentionMapForSubscriptions unions in every
    // kind:'channel' subscription (correct for the inbox feature, a leak here),
    // so drop channel-kind rows with no member backing. DMs (D-prefix) pass
    // through; they are folded from message history, not membership.
    if (
      membershipComplete &&
      kindForChannelId(channel.channelId) === 'channel' &&
      !memberIds.has(channel.channelId)
    ) {
      continue;
    }
    byId.set(channel.channelId, {
      id: channel.channelId,
      ...(channel.channelName ? { name: channel.channelName } : {}),
      platform: 'slack',
      kind: kindForChannelId(channel.channelId),
      status: channel.status,
      ...(channel.subscription?.lastActivityAt
        ? { lastActivityAt: channel.subscription.lastActivityAt }
        : {}),
      ...(channel.subscription?.lastPostedAt
        ? { lastPostedAt: channel.subscription.lastPostedAt }
        : {}),
    });
  }

  // Fold DMs from message history (inbound + outbound), deduped by channel id.
  for (const message of input.messages) {
    if (message.channelKind !== 'dm') continue;
    const id = message.channelId;
    if (!id) continue;
    const name = message.dmHandle?.trim();
    const existing = byId.get(id);
    if (existing) {
      // A DM already seen via a subscription row, or an earlier message.
      existing.kind = 'dm';
      if (name && !existing.name) existing.name = name;
      existing.lastActivityAt = laterOf(existing.lastActivityAt, message.timestamp);
      continue;
    }
    byId.set(id, {
      id,
      ...(name ? { name } : {}),
      platform: 'slack',
      kind: 'dm',
      status: 'following',
      ...(message.timestamp ? { lastActivityAt: message.timestamp } : {}),
    });
  }

  const channels = [...byId.values()].sort(
    (a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''),
  );
  return { channels };
}

// IO wrapper: fetch the three inputs in parallel, then compose. Returns an empty
// list (never throws) when the agent has no Slack access. When the authoritative
// membership lookup FAILED (token present but Slack errored), flags
// `membershipPartial` so the UI can signal the list may be missing silent member
// channels rather than silently under-reporting.
export async function buildAgentChannelList(agentId: string): Promise<AgentChannelListResponse> {
  const agent = await defaultAgentRegistryService.serviceFor(agentId).getConfig();
  const [subscriptions, memberResult, page] = await Promise.all([
    listSubscriptionsForAgent(agentId),
    memberChannelsResultForAgent(agent),
    messageServiceForAgent(agentId).list({ limit: DM_SCAN_LIMIT }),
  ]);
  const list = composeChannelList({
    memberChannels: memberResult.channels,
    subscriptions,
    messages: page.entries,
    membershipComplete: !memberResult.degraded,
  });
  return memberResult.degraded ? { ...list, membershipPartial: true } : list;
}
