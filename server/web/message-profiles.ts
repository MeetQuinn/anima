import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { SlackProfileResolver } from '../inbox/slack-profiles.js';
import type { WebClient } from '@slack/web-api';
import type { AgentMessageHistoryPage } from '../../shared/messages.js';

// Read-time, best-effort avatar enrichment for the message-history feed.
//
// The Activity / Channels timeline renders each author Slack-style (avatar +
// name + time). The agent's own avatar comes from its profile, but inbound
// senders only carry `actorUserId` — so without this they fall back to an
// initial and only the agent shows a photo. This populates `actorAvatarUrl` on
// inbound Slack rows so every byline renders its real photo.
//
// Mirrors the DM-avatar decoration in agent-channels.ts and stays inside the
// same boundary Milo flagged: the durable message ledger (message.projection)
// stays pure with no Slack IO; profile lookup is decorative chrome resolved
// only when history is read. Any failure (no token, Slack error, left
// workspace, no photo) leaves the row without an avatar and the UI falls back
// to the initial — resolution is never a hard gate. Dedupes by user so the
// resolver cache is hit once per unique sender per page.

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;

// External touchpoints, injectable so the contract can be unit-tested without
// real Slack IO. Production callers omit `deps` and get the live services.
export interface AvatarEnrichmentDeps {
  loadAgent: (
    agentId: string,
  ) => Promise<{ id: string; slack?: { botToken?: string; teamId?: string } }>;
  getWebClient: (agentId: string) => Promise<unknown>;
  resolveAvatar: (args: {
    client: unknown;
    teamId: string;
    userId: string;
  }) => Promise<string | undefined>;
}

const defaultDeps: AvatarEnrichmentDeps = {
  loadAgent: (agentId) => defaultAgentRegistryService.serviceFor(agentId).getConfig(),
  getWebClient: (agentId) => agentSlackServiceForAgent(agentId).getWebClient(),
  resolveAvatar: async ({ client, teamId, userId }) => {
    const profile = await new SlackProfileResolver().user({
      client: client as WebClient,
      teamId,
      userId,
    });
    return profile?.avatarUrl;
  },
};

export async function enrichInboundAvatars(
  agentId: string,
  page: AgentMessageHistoryPage,
  deps: AvatarEnrichmentDeps = defaultDeps,
): Promise<AgentMessageHistoryPage> {
  try {
    const userIds = new Set<string>();
    for (const m of page.entries) {
      if (
        m.direction === 'in' &&
        m.platform !== 'feishu' &&
        m.actorUserId &&
        SLACK_USER_ID.test(m.actorUserId)
      ) {
        userIds.add(m.actorUserId);
      }
    }
    if (userIds.size === 0) return page;

    const agent = await deps.loadAgent(agentId);
    if (!agent.slack?.botToken) return page;
    // Require a non-empty team id before resolving. The workspace directory
    // disk cache in SlackProfileResolver is keyed by team id; an empty key
    // bypasses it, so a connected-but-teamless/legacy Slack config would call
    // users.info once per unique sender on every 3s /messages poll. Avatars are
    // decorative, so a missing team id degrades to the initials fallback rather
    // than hammering the Slack API uncached.
    const teamId = agent.slack.teamId;
    if (!teamId) return page;
    const client = await deps.getWebClient(agent.id);

    const avatarByUser = new Map<string, string>();
    await Promise.all(
      // One resolver call per unique sender (the Set already deduped).
      [...userIds].map(async (userId) => {
        const avatarUrl = await deps.resolveAvatar({ client, teamId, userId });
        if (avatarUrl) avatarByUser.set(userId, avatarUrl);
      }),
    );
    if (avatarByUser.size === 0) return page;

    return {
      ...page,
      entries: page.entries.map((m) => {
        const avatarUrl = m.actorUserId ? avatarByUser.get(m.actorUserId) : undefined;
        return avatarUrl ? { ...m, actorAvatarUrl: avatarUrl } : m;
      }),
    };
  } catch {
    // Decorative only: never let avatar resolution break message history.
    return page;
  }
}
