import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { SlackProfileResolver } from '../inbox/slack-profiles.js';
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

export async function enrichInboundAvatars(
  agentId: string,
  page: AgentMessageHistoryPage,
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

    const agent = await defaultAgentRegistryService.serviceFor(agentId).getConfig();
    if (!agent.slack?.botToken) return page;
    const teamId = agent.slack.teamId ?? '';
    const client = await agentSlackServiceForAgent(agent.id).getWebClient();
    const resolver = new SlackProfileResolver();

    const avatarByUser = new Map<string, string>();
    await Promise.all(
      [...userIds].map(async (userId) => {
        const profile = await resolver.user({ client, teamId, userId });
        if (profile?.avatarUrl) avatarByUser.set(userId, profile.avatarUrl);
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
