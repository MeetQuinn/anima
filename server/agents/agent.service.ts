import {
  agentIdFromName,
  type AgentConfig,
  type AgentCreateRequest,
  type AgentUpdateProfileRequest,
  type AgentUpdateProviderRequest,
} from '../../shared/agent-config.js';
import { DEFAULT_TEAM_ID } from '../../shared/server-settings.js';
import { defaultTeamService, type TeamService } from '../teams/team.service.js';
import type { AgentSkills } from '../../shared/skills.js';
import {
  AgentConfigError,
  agentConfigWithProviderUpdate,
  agentConfigFromCreateInput,
  assertAgentConfigId,
  ensureCreateAgentHome,
  ensureExistingAgentHome,
  normalizeAgentConfig,
  validateAgentConfig,
} from './agent-config-ops.js';
import { scanAgentSkills } from './agent-skills.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import {
  AgentRegistryStore,
  AgentStore,
} from '../storage/schema/agent.store.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nowIso } from '../ids.js';
import { writeSeedMemory } from './seed-memory.js';
import { defaultKbRegistryService, type KbRegistryService } from '../kb/kb.service.js';
import {
  SessionStore,
  type ArchivedProviderSession,
  type Session,
} from '../storage/schema/session.store.js';

export { AgentConfigError } from './agent-config-ops.js';

export interface RotateSessionResult {
  agentId: string;
  archivedAt: string;
  archivedProviderSessions: ArchivedProviderSession[];
}

interface ArchiveProviderSessionResult {
  archivedAt: string;
  archivedProviderSessions: ArchivedProviderSession[];
}

// ---------------------------------------------------------------------------
// AgentService
// ---------------------------------------------------------------------------

export class AgentService {
  constructor(
    private readonly agentId: string,
    private readonly store: AgentStore = new AgentStore(agentId),
    private readonly sessionStore: SessionStore = new SessionStore(agentId),
  ) {}

  exists(): boolean {
    return this.store.exists();
  }

  async getConfig(): Promise<AgentConfig> {
    const path = this.store.path();
    if (!this.store.exists()) throw new AgentConfigError(404, `Agent not found in config: ${this.agentId}`);
    const agent = await this.store.read();
    assertAgentConfigId(this.agentId, agent, path);
    return agent;
  }

  async createAgent(agent: AgentConfig): Promise<AgentConfig> {
    if (this.store.exists()) {
      throw new AgentConfigError(409, `Agent already exists in config: ${this.agentId}`);
    }
    return this.saveConfig(agent);
  }

  async setEnabled(enabled: boolean): Promise<AgentConfig> {
    return this.saveConfig({ ...(await this.getConfig()), enabled });
  }

  async updateHome(homePath: string): Promise<AgentConfig> {
    await ensureExistingAgentHome(homePath);
    return this.saveConfig({ ...(await this.getConfig()), homePath });
  }

  async updateProfile(profile: AgentUpdateProfileRequest): Promise<AgentConfig> {
    const current = await this.getConfig();
    return this.saveConfig({ ...current, profile: { ...current.profile, ...profile } });
  }

  async updateProvider(provider: AgentUpdateProviderRequest): Promise<AgentConfig> {
    const current = await this.getConfig();
    const next = await this.saveConfig(agentConfigWithProviderUpdate(current, provider));
    const archiveNote = providerSessionArchiveNote(current.provider, next.provider);
    if (archiveNote) {
      await this.archiveCurrentProviderSession(archiveNote);
    }
    return next;
  }

  async getSession(): Promise<Session | null> {
    return (await this.sessionStore.read()) ?? null;
  }

  async getSkills(): Promise<AgentSkills> {
    return scanAgentSkills(await this.getConfig());
  }

  async rotateSession(note?: string): Promise<RotateSessionResult> {
    const archived = await this.archiveCurrentProviderSession(note?.trim() || undefined);
    if (!archived) throw new AgentConfigError(409, `No active provider sessions for agent ${this.agentId}`);
    return { agentId: this.agentId, ...archived };
  }

  async removeAgent(): Promise<AgentConfig> {
    const agent = await this.getConfig();
    await this.store.remove();
    return agent;
  }

  async saveConfig(agent: AgentConfig): Promise<AgentConfig> {
    const next = normalizeAgentConfig(this.agentId, agent);
    await validateAgentConfig(next);
    await this.store.write(next);
    return this.getConfig();
  }

  private async archiveCurrentProviderSession(note?: string): Promise<ArchiveProviderSessionResult | undefined> {
    const archivedAt = nowIso();
    let updated: Session | undefined;
    let archived: ArchivedProviderSession | undefined;
    await this.sessionStore.update((session) => {
      if (!session?.current) return undefined;
      archived = {
        ...session.current,
        archivedAt,
        archivedBy: 'operator',
        ...(note ? { note } : {}),
      };
      const {
        current: _current,
        latestProviderStats: _latestProviderStats,
        ...rest
      } = session;
      updated = {
        ...rest,
        archived: dedupeArchivedSessions([archived, ...(session.archived ?? [])]),
        currentStartedAt: archivedAt,
        updatedAt: archivedAt,
      };
      return updated;
    });
    if (!updated || !archived) return undefined;

    const archivedProviderSessions = [archived];
    await activityServiceForAgent(this.agentId).record({
      type: 'anima.session.rotate',
      payload: { archivedAt, archivedCount: 1, archivedProviderSessions, ...(note ? { note } : {}) },
    });
    return { archivedAt, archivedProviderSessions };
  }
}

function providerSessionArchiveNote(
  current: AgentConfig['provider'],
  next: AgentConfig['provider'],
): string | undefined {
  if (current.kind !== next.kind) {
    return `provider switched from ${current.kind} to ${next.kind}`;
  }
  if (
    current.kind === 'claude-code'
    && next.kind === 'claude-code'
    && (current.transport ?? 'stream-json') !== (next.transport ?? 'stream-json')
  ) {
    return `Claude Code transport switched from ${current.transport ?? 'stream-json'} to ${next.transport ?? 'stream-json'}`;
  }
  return undefined;
}

export class AgentRegistryService {
  constructor(
    private readonly registry: AgentRegistryStore = new AgentRegistryStore(),
    private readonly kbRegistryService: KbRegistryService = defaultKbRegistryService,
    private readonly teamService: TeamService = defaultTeamService,
  ) {}

  async listAgentConfigs(): Promise<AgentConfig[]> {
    const ids = await this.registry.listIds();
    return Promise.all(ids.map((id) => this.serviceFor(id).getConfig()));
  }

  listAgentIds(): Promise<string[]> {
    return this.registry.listIds();
  }

  async createAgent(input: AgentCreateRequest): Promise<AgentConfig> {
    const agentId = agentIdFromName(input.name);
    // An explicit teamId must name a real team (400). No teamId => the default team.
    const team = input.teamId
      ? await this.teamService.requireTeam(input.teamId)
      : await this.teamService.requireTeam(DEFAULT_TEAM_ID);
    // Explicit homePath is honored as-is (back-compat). When omitted, derive the deterministic
    // in-team home: $TEAM_HOME/agents/$agentId (matches today's layout for the default team).
    const homePath = input.homePath?.trim()
      ? input.homePath.trim()
      : this.teamService.deriveAgentHomePath(team, agentId);
    const agent = agentConfigFromCreateInput(input, { teamId: team.id, homePath });
    const service = this.serviceFor(agent.id);
    if (service.exists()) {
      throw new AgentConfigError(409, `Agent already exists in config: ${agent.id}`);
    }
    await ensureCreateAgentHome(agent.homePath);
    await this.kbRegistryService.ensureDefaultTeamKbForAgentHome(agent.homePath);
    const created = await service.createAgent(agent);
    await writeSeedMemory(created);
    await mkdir(join(created.homePath, 'notes'), { recursive: true });
    return created;
  }

  // Label-only team reassignment: validates the target team exists, then rewrites the agent's
  // teamId. The existing home is never moved (team = a label; see cut-1 contract).
  async assignTeam(agentId: string, teamId: string): Promise<AgentConfig> {
    const team = await this.teamService.requireTeam(teamId);
    const service = this.serviceFor(agentId);
    const current = await service.getConfig();
    return service.saveConfig({ ...current, teamId: team.id });
  }

  serviceFor(agentId: string): AgentService {
    return new AgentService(agentId);
  }
}

export const defaultAgentRegistryService = new AgentRegistryService();

function dedupeArchivedSessions(sessions: ArchivedProviderSession[]): ArchivedProviderSession[] {
  return [...new Map(sessions.map((s) => [`${s.kind}:${s.id}`, s])).values()];
}
