import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';

export interface MemberChannel {
  id: string;
  name?: string;
}

export interface MemberChannelResult {
  channels: MemberChannel[];
  // True only when a Slack lookup was attempted (the agent has a token) and it
  // FAILED. Distinct from a legitimately empty list (no token, or genuinely no
  // member channels), so callers can signal that membership may be incomplete
  // instead of silently under-reporting.
  degraded: boolean;
}

// The Slack channels the agent's bot is a member of (`is_member`, including muted
// + silent), normalized to {id, name}. Cached, 10-min TTL via the directory
// service. On a Slack-fetch failure returns `{ channels: [], degraded: true }`;
// when the agent simply has no token it returns `{ channels: [], degraded: false }`.
export async function memberChannelsResultForAgent(
  agent: { id: string; slack?: { botToken?: string; teamId?: string } },
): Promise<MemberChannelResult> {
  if (!agent.slack?.botToken) return { channels: [], degraded: false };
  try {
    const client = await agentSlackServiceForAgent(agent.id).getWebClient();
    const channels = await new SlackWorkspaceDirectoryService({
      client,
      teamId: agent.slack.teamId,
    }).getMemberConversations();
    return {
      channels: channels.flatMap((channel) => {
        if (!channel.id) return [];
        const name = channel.name?.trim();
        return [{ id: channel.id, ...(name ? { name } : {}) }];
      }),
      degraded: false,
    };
  } catch {
    return { channels: [], degraded: true };
  }
}

// Convenience: just the channels, degrading silently to [] on any failure. Used
// by callers (e.g. the subscriptions CLI) that don't surface a degraded signal.
export async function memberChannelsForAgent(
  agent: { id: string; slack?: { botToken?: string; teamId?: string } },
): Promise<MemberChannel[]> {
  return (await memberChannelsResultForAgent(agent)).channels;
}
