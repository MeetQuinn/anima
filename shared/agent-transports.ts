export interface AgentTransportSnapshot {
  feishu?: {
    appId?: string;
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

export type AgentTransportKind = 'slack' | 'feishu';
export type AgentPlatformLabel = 'Slack' | 'Feishu';

const TRANSPORT_LABELS: Record<AgentTransportKind, AgentPlatformLabel> = {
  feishu: 'Feishu',
  slack: 'Slack',
};

export function agentSlackConnected(agent: AgentTransportSnapshot): boolean {
  return agent.slack?.connected === true;
}

export function agentFeishuConnected(agent: AgentTransportSnapshot): boolean {
  return agent.feishu?.connected === true;
}

export function agentHasConnectedTransport(agent: AgentTransportSnapshot): boolean {
  return agentSlackConnected(agent) || agentFeishuConnected(agent);
}

export function agentConnectedTransportKinds(agent: AgentTransportSnapshot): AgentTransportKind[] {
  return [
    agentSlackConnected(agent) ? 'slack' : undefined,
    agentFeishuConnected(agent) ? 'feishu' : undefined,
  ].filter((kind): kind is AgentTransportKind => Boolean(kind));
}

export function agentPrimaryTransportKind(agent: AgentTransportSnapshot): AgentTransportKind | undefined {
  // V1 product model is one team/workspace platform. Feishu-connected dev agents
  // may still carry Slack credentials as a runtime bootstrap bridge; keep that
  // implementation detail out of the user-facing platform label.
  if (agentFeishuConnected(agent)) return 'feishu';
  if (agentSlackConnected(agent)) return 'slack';
  return undefined;
}

export function agentHasMultipleConnectedTransports(agent: AgentTransportSnapshot): boolean {
  return agentConnectedTransportKinds(agent).length > 1;
}

export function agentConfiguredPlatformKind(agent: AgentTransportSnapshot): AgentTransportKind | undefined {
  const connectedKind = agentPrimaryTransportKind(agent);
  if (connectedKind) return connectedKind;

  if (hasString(agent.feishu?.appId) || hasString(agent.feishu?.botOpenId)) return 'feishu';
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

export function agentPlatformLabel(agent: AgentTransportSnapshot): AgentPlatformLabel | null {
  const kind = agentConfiguredPlatformKind(agent);
  return kind ? agentTransportDisplayLabel(kind) : null;
}

export function agentTransportLabel(agent: AgentTransportSnapshot): string {
  const kind = agentPrimaryTransportKind(agent);
  return kind ? agentTransportDisplayLabel(kind) : 'Not connected';
}

export function agentsHaveMixedPlatforms(agents: readonly AgentTransportSnapshot[]): boolean {
  const kinds = new Set<AgentTransportKind>();
  for (const agent of agents) {
    const kind = agentConfiguredPlatformKind(agent);
    if (kind) kinds.add(kind);
    if (kinds.size > 1) return true;
  }
  return false;
}

function hasString(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
