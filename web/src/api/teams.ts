import { apiRequest, jsonInit } from './client';
import type { AgentConfig } from '@shared/agent-config';
import type { TeamConfig } from '@shared/server-settings';

export type { TeamConfig } from '@shared/server-settings';

// The effective team registry. The default team is always present and first, so
// a fresh/empty install returns exactly one team (N=1, no team chrome).
export async function fetchTeams(): Promise<TeamConfig[]> {
  const body = await apiRequest<{ teams: TeamConfig[] }>('/api/teams');
  return body.teams;
}

export async function createTeam(input: { name: string; home?: string }): Promise<TeamConfig> {
  const body = await apiRequest<{ team: TeamConfig }>('/api/teams', jsonInit('POST', input));
  return body.team;
}

// Label-only reassignment; the agent's home is never moved.
export async function assignAgentTeam(agentId: string, teamId: string): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/team`, jsonInit('POST', { teamId }));
}
