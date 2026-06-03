export interface AgentTransportSnapshot {
  feishu?: { connected?: boolean };
  slack?: { connected?: boolean };
}

export type AgentTransportKind = 'slack' | 'feishu';

const TRANSPORT_LABELS: Record<AgentTransportKind, string> = {
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

export function agentTransportDisplayLabel(kind: AgentTransportKind): string {
  return TRANSPORT_LABELS[kind];
}

export function agentTransportLabel(agent: AgentTransportSnapshot): string {
  const kind = agentPrimaryTransportKind(agent);
  return kind ? agentTransportDisplayLabel(kind) : 'Not connected';
}
