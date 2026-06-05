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
