export interface AgentTransportSnapshot {
  linear?: { connected: boolean; clientId: string; organizationId: string; appUserId: string };
  feishu?: {
    appId?: string;
    avatarUrl?: string;
    botOpenId?: string;
    connected?: boolean;
  };
  slack?: {
    appId?: string;
    avatarUrl?: string;
    botUserId?: string;
    connected?: boolean;
    teamId?: string;
    workspaceIconUrl?: string;
    workspaceName?: string;
  };
}

export type AgentTransportKind = 'slack' | 'feishu' | 'linear';
export type AgentPlatformLabel = 'Slack' | 'Feishu' | 'Linear';

const TRANSPORT_LABELS: Record<AgentTransportKind, AgentPlatformLabel> = {
  feishu: 'Feishu',
  slack: 'Slack',
  linear: 'Linear',
};

export function agentSlackConnected(agent: AgentTransportSnapshot): boolean {
  return agent.slack?.connected === true;
}

export function agentFeishuConnected(agent: AgentTransportSnapshot): boolean {
  return agent.feishu?.connected === true;
}

export function agentHasConnectedTransport(agent: AgentTransportSnapshot): boolean {
  return agentSlackConnected(agent) || agentFeishuConnected(agent) || agent.linear?.connected === true;
}

export function agentPrimaryTransportKind(agent: AgentTransportSnapshot): AgentTransportKind | undefined {
  // V1 product model is one team/workspace platform. Feishu-connected dev agents
  // may still carry Slack credentials as a runtime bootstrap bridge; keep that
  // implementation detail out of the user-facing platform label.
  if (agentFeishuConnected(agent)) return 'feishu';
  if (agentSlackConnected(agent)) return 'slack';
  if (agent.linear?.connected) return 'linear';
  return undefined;
}

export function agentConfiguredPlatformKind(agent: AgentTransportSnapshot): AgentTransportKind | undefined {
  const connectedKind = agentPrimaryTransportKind(agent);
  if (connectedKind) return connectedKind;

  if (hasString(agent.feishu?.appId) || hasString(agent.feishu?.avatarUrl) || hasString(agent.feishu?.botOpenId)) return 'feishu';
  if (
    hasString(agent.slack?.appId)
    || hasString(agent.slack?.botUserId)
    || hasString(agent.slack?.teamId)
    || hasString(agent.slack?.workspaceIconUrl)
    || hasString(agent.slack?.workspaceName)
    || hasString(agent.slack?.avatarUrl)
  ) {
    return 'slack';
  }
  return undefined;
}

export function agentTransportDisplayLabel(kind: AgentTransportKind): AgentPlatformLabel {
  return TRANSPORT_LABELS[kind];
}

function hasString(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
