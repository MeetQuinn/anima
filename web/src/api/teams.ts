import { apiRequest, jsonInit } from './client';
import type { AgentConfig } from '@shared/agent-config';
import type { AgentTeamWarning, TeamConfig } from '@shared/server-settings';

export type { TeamConfig, AgentTeamWarning } from '@shared/server-settings';

export interface TeamsResponse {
  teams: TeamConfig[];
  // Repairable diagnostics for agents whose teamId no longer resolves (empty when healthy).
  warnings: AgentTeamWarning[];
}

// The effective team registry plus any repairable team-reference warnings. The default team
// is always present and first, so a fresh/empty install returns exactly one team (N=1, no
// team chrome) and no warnings.
export async function fetchTeams(): Promise<TeamsResponse> {
  const body = await apiRequest<{ teams: TeamConfig[]; warnings?: AgentTeamWarning[] }>('/api/teams');
  return { teams: body.teams, warnings: body.warnings ?? [] };
}

export async function createTeam(input: { name: string; home?: string }): Promise<TeamConfig> {
  const body = await apiRequest<{ team: TeamConfig }>('/api/teams', jsonInit('POST', input));
  return body.team;
}

// Label-only reassignment; the agent's home is never moved.
export async function assignAgentTeam(agentId: string, teamId: string): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/team`, jsonInit('POST', { teamId }));
}
