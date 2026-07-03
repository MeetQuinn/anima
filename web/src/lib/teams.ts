import { DEFAULT_TEAM_ID } from '@shared/server-settings';
import type { AgentConfig } from '@shared/agent-config';

// Effective teamId for an agent: a blank or dangling id degrades to the default
// team so every agent is always visible under some group (never dropped). This
// mirrors the server-side degrade — the client must never hide an agent just
// because its team reference is stale.
export function effectiveTeamId(agent: AgentConfig, teamIds: ReadonlySet<string>): string {
  const raw = (agent.teamId ?? '').trim();
  return raw && teamIds.has(raw) ? raw : DEFAULT_TEAM_ID;
}
