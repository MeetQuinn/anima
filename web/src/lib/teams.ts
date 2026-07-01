import { DEFAULT_TEAM_ID } from '@shared/server-settings';
import type { TeamConfig } from '@shared/server-settings';
import type { AgentConfig } from '@shared/agent-config';

export interface TeamGroup {
  team: TeamConfig;
  agents: AgentConfig[];
}

// The sidebar shows team chrome only once a second team exists. At N=1 it is a
// flat agent list, visually identical to the pre-teams dashboard.
export function isGrouped(teams: TeamConfig[]): boolean {
  return teams.length > 1;
}

// Effective teamId for an agent: a blank or dangling id degrades to the default
// team so every agent is always visible under some group (never dropped). This
// mirrors the server-side degrade — the client must never hide an agent just
// because its team reference is stale.
export function effectiveTeamId(agent: AgentConfig, teamIds: ReadonlySet<string>): string {
  const raw = (agent.teamId ?? '').trim();
  return raw && teamIds.has(raw) ? raw : DEFAULT_TEAM_ID;
}

// Group already-ordered agents under teams. Team (group) order follows the
// registry order (default first); agent order within a group is preserved from
// the incoming list (already sidebar-ordered). Empty teams keep their group so
// an empty team still shows a header + drop target at N>=2.
export function groupAgentsByTeam(agents: AgentConfig[], teams: TeamConfig[]): TeamGroup[] {
  const teamIds = new Set(teams.map((t) => t.id));
  const byTeam = new Map<string, AgentConfig[]>();
  for (const team of teams) byTeam.set(team.id, []);
  for (const agent of agents) {
    const id = effectiveTeamId(agent, teamIds);
    (byTeam.get(id) ?? byTeam.get(DEFAULT_TEAM_ID))?.push(agent);
  }
  return teams.map((team) => ({ team, agents: byTeam.get(team.id) ?? [] }));
}
