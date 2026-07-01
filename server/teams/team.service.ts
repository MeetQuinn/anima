// TeamService — the runtime authority for the team registry.
//
// Design (locked with Milo, 2026-07-01; see docs/design/team-first-class-cut1.md):
//   - Teams live in root/server config as stable ids `{ id, name, home }`.
//   - Agents store only `teamId`; name/home stay here so they can change without rewriting
//     every agent config.
//   - The default team id is deterministic (`default`) and SYNTHESIZED, not persisted, until
//     a second team is created. This keeps the empty/legacy config round-tripping to `{}`
//     (zero-touch upgrade) while still giving every agent a real team to belong to.
//   - Read paths degrade a missing/dangling `teamId` to the default team and surface a
//     repairable warning; they never crash.

import { defaultAgentHomePath, DEFAULT_TEAM_KB_ROOT } from '../../shared/agent-home.js';
import { agentIdFromName } from '../../shared/agent-config.js';
import {
  DEFAULT_TEAM_ID,
  DEFAULT_TEAM_NAME,
  type TeamConfig,
} from '../../shared/server-settings.js';
import {
  defaultServerSettingsService,
  type ServerSettingsService,
} from '../settings/settings.service.js';

export class TeamServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

// The synthesized default team. `home` = the current workspace root, so an existing install's
// agents keep their exact homes ($TEAM_HOME/agents/$id === ~/anima-team/agents/$id today).
export function defaultTeam(): TeamConfig {
  return { id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, home: DEFAULT_TEAM_KB_ROOT };
}

function normalizeHome(rawHome: string): string {
  const trimmed = rawHome.trim();
  if (!trimmed) throw new TeamServiceError(400, 'team home must not be empty');
  // Strip trailing slashes so `$HOME/agents/$id` derivation is stable. Actual `~`/relative
  // resolution happens at the create-agent boundary (resolveServerPath), matching how a raw
  // agent homePath is treated today.
  return trimmed.replace(/\/+$/, '') || trimmed;
}

export class TeamService {
  constructor(private readonly settings: ServerSettingsService = defaultServerSettingsService) {}

  // Effective team list: the persisted registry with the default team guaranteed present and
  // pinned first. Absent/empty config yields exactly `[default]`, so N=1 is the norm.
  async listTeams(): Promise<TeamConfig[]> {
    const persisted = await this.settings.getTeams();
    const withoutDefault = persisted.filter((team) => team.id !== DEFAULT_TEAM_ID);
    const persistedDefault = persisted.find((team) => team.id === DEFAULT_TEAM_ID);
    return [persistedDefault ?? defaultTeam(), ...withoutDefault];
  }

  async getTeam(teamId: string): Promise<TeamConfig | undefined> {
    const teams = await this.listTeams();
    return teams.find((team) => team.id === teamId);
  }

  // Create-agent gate: an explicit teamId must name a real team (400, not a silent degrade).
  async requireTeam(teamId: string): Promise<TeamConfig> {
    const team = await this.getTeam(teamId);
    if (!team) throw new TeamServiceError(400, `unknown team: ${teamId}`);
    return team;
  }

  // Read-path degrade: a missing/blank/dangling teamId resolves to the default team. Returns
  // the effective id plus an optional warning the caller can surface (never throws).
  async resolveEffectiveTeamId(
    teamId: string | undefined,
  ): Promise<{ teamId: string; warning?: string }> {
    const wanted = teamId?.trim();
    if (!wanted || wanted === DEFAULT_TEAM_ID) return { teamId: DEFAULT_TEAM_ID };
    const team = await this.getTeam(wanted);
    if (team) return { teamId: wanted };
    return {
      teamId: DEFAULT_TEAM_ID,
      warning: `team "${wanted}" does not exist; showing this agent under the default team. `
        + 'Reassign it or recreate the team to repair.',
    };
  }

  // Deterministic new-agent home inside a team: $TEAM_HOME/agents/$agentId (tilde/relative
  // form preserved; resolved by the create-agent boundary). Matches today's layout exactly.
  deriveAgentHomePath(team: TeamConfig, agentId: string): string {
    return defaultAgentHomePath(agentId, `${team.home.replace(/\/+$/, '')}/agents`);
  }

  async createTeam(input: { name: string; home?: string }): Promise<TeamConfig> {
    const name = input.name.trim();
    if (!name) throw new TeamServiceError(400, 'team name must not be empty');
    const id = agentIdFromName(name);
    if (!id) throw new TeamServiceError(400, `team name has no valid id form: ${input.name}`);
    if (id === DEFAULT_TEAM_ID) {
      throw new TeamServiceError(409, `"${DEFAULT_TEAM_ID}" is reserved for the default team`);
    }

    const teams = await this.listTeams();
    if (teams.some((team) => team.id === id)) {
      throw new TeamServiceError(409, `team already exists: ${id}`);
    }

    // Default a new team's KB root to a sibling `~/<id>` tree; operators can override.
    const home = normalizeHome(input.home ?? `~/${id}`);
    const created: TeamConfig = { id, name, home };

    // Persist the FULL effective list (including the now-materialized default team) so the
    // registry becomes explicit the moment a second team exists.
    await this.settings.setTeams([...teams, created]);
    return created;
  }
}

export const defaultTeamService = new TeamService();
