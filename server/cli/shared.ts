export interface GlobalCliOptions {
  agent?: string;
}

export function resolveAgentIdFrom(agent: string | undefined): string | undefined {
  return agent ?? (process.env.ANIMA_AGENT_ID?.trim() || undefined);
}

