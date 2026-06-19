import {
  agentFeishuConnected,
  agentSlackConnected,
  type AgentTransportSnapshot,
} from '@shared/agent-transports';

export function agentAvatarUrl(agent: AgentTransportSnapshot | undefined): string | undefined {
  if (!agent) return undefined;
  if (agentFeishuConnected(agent) && agent.feishu?.avatarUrl) return agent.feishu.avatarUrl;
  if (agentSlackConnected(agent) && agent.slack?.avatarUrl) return agent.slack.avatarUrl;
  return agent.slack?.avatarUrl || agent.feishu?.avatarUrl;
}

/**
 * Human-readable agent name for chrome. Falls back to the agent id (a readable
 * handle like `nora`, not an opaque uid) when no profile displayName is set.
 * Structural param so pure helpers that narrow the agent shape can reuse it.
 */
export function agentDisplayName(agent: { id: string; profile?: { displayName?: string } }): string {
  return agent.profile?.displayName ?? agent.id;
}
