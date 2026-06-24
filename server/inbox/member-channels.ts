import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';

export interface MemberChannel {
  id: string;
  name?: string;
}

// The Slack channels the agent's bot is a member of (`is_member`, including muted
// + silent), normalized to {id, name}. Cached, 10-min TTL via the directory
// service. Returns [] when the agent has no Slack token or the lookup fails, so
// callers degrade to subscription/message-derived data rather than erroring.
export async function memberChannelsForAgent(
  agent: { id: string; slack?: { botToken?: string; teamId?: string } },
): Promise<MemberChannel[]> {
  if (!agent.slack?.botToken) return [];
  try {
    const client = await agentSlackServiceForAgent(agent.id).getWebClient();
    const channels = await new SlackWorkspaceDirectoryService({
      client,
      teamId: agent.slack.teamId,
    }).getMemberConversations();
    return channels.flatMap((channel) => {
      if (!channel.id) return [];
      const name = channel.name_normalized?.trim() || channel.name?.trim();
      return [{ id: channel.id, ...(name ? { name } : {}) }];
    });
  } catch {
    return [];
  }
}
