import { DEFAULT_MAX_CONCURRENT_AGENT_RUNS } from '../../shared/server-settings.js';
import type {
  DashboardAuth,
  ProviderContextLimitsConfig,
  ProviderRuntimeArgsConfig,
  ProviderRuntimeCommandsConfig,
  ReleaseTrack,
  ServerTrack,
  SidebarOrder,
  TeamConfig,
  WorkspacePlatform,
} from '../../shared/server-settings.js';
import type { ProviderContextLimitProvider } from '../../shared/provider-context-limits.js';
import type { ProviderUsageKind } from '../../shared/provider-usage.js';
import {
  serverConfigStore,
  type ServerConfig,
  type ServerConfigStore,
} from '../storage/schema/server.store.js';
import { WebNetworkStore, type WebNetworkConfig } from '../storage/schema/web-network.store.js';

export interface DashboardSettings {
  host: string;
  port: number;
}

export class ServerSettingsService {
  constructor(
    private readonly store: ServerConfigStore = serverConfigStore,
    private readonly webNetworkStore: WebNetworkStore = new WebNetworkStore(),
  ) {}

  getWebNetwork(): Promise<WebNetworkConfig> {
    return this.webNetworkStore.read();
  }

  readConfig(): Promise<ServerConfig> {
    return this.store.read();
  }

  async getDashboardSettings(input: {
    defaultHost: string;
    defaultPort: number;
  }): Promise<DashboardSettings> {
    const config = await this.store.read();
    return {
      host: config.dashboardHost ?? input.defaultHost,
      port: config.dashboardPort ?? input.defaultPort,
    };
  }

  async getSidebarOrder(): Promise<SidebarOrder> {
    const config = await this.store.read();
    return config.sidebarOrder ?? {};
  }

  // Raw team registry as persisted. Absent/empty is normal (zero-touch upgrade); the
  // default-team synthesis + degrade logic lives in TeamService, not here.
  async getTeams(): Promise<TeamConfig[]> {
    const config = await this.store.read();
    return config.teams ?? [];
  }

  async getDashboardAuth(): Promise<DashboardAuth | undefined> {
    const config = await this.store.read();
    return config.dashboardAuth;
  }

  async getReleaseTrack(): Promise<ReleaseTrack> {
    const config = await this.store.read();
    if (config.releaseTrack) return config.releaseTrack;
    if (config.track === 'canary' || config.track === 'stable') return config.track;
    return config.releaseTrack ?? 'stable';
  }

  async getProviderContextLimits(): Promise<ProviderContextLimitsConfig> {
    const config = await this.store.read();
    return config.providerContextLimits ?? {};
  }

  async getProviderRuntimeCommands(): Promise<ProviderRuntimeCommandsConfig> {
    const config = await this.store.read();
    return config.providerCommands ?? {};
  }

  async getProviderRuntimeArgs(): Promise<ProviderRuntimeArgsConfig> {
    const config = await this.store.read();
    return config.providerArgs ?? {};
  }

  async getMaxConcurrentAgentRuns(): Promise<number> {
    const config = await this.store.read();
    return config.runtime?.maxConcurrentAgentRuns ?? DEFAULT_MAX_CONCURRENT_AGENT_RUNS;
  }

  async getTrack(): Promise<ServerTrack> {
    const config = await this.store.read();
    return config.track ?? config.releaseTrack ?? 'stable';
  }

  async getWorkspacePlatform(): Promise<WorkspacePlatform> {
    const config = await this.store.read();
    return config.workspacePlatform ?? 'slack';
  }

  // Every setter changes its own key inside store.update, under the file lock,
  // so it never writes back a copy that predates another key's edit.
  async setReleaseTrack(releaseTrack: ReleaseTrack): Promise<ReleaseTrack> {
    await this.store.update((current) => ({ ...current, releaseTrack, track: releaseTrack }));
    return releaseTrack;
  }

  async setSidebarOrder(sidebarOrder: SidebarOrder): Promise<SidebarOrder> {
    await this.store.update((current) => ({ ...current, sidebarOrder }));
    return sidebarOrder;
  }

  // `change` gets the persisted team list and runs inside the lock, so checks
  // against the list (an id or name already taken) see the latest teams.
  async updateTeams(change: (persisted: TeamConfig[]) => TeamConfig[]): Promise<TeamConfig[]> {
    const config = await this.store.update((current) => ({ ...current, teams: change(current.teams ?? []) }));
    return config.teams ?? [];
  }

  async setDashboardAuth(dashboardAuth: DashboardAuth): Promise<DashboardAuth> {
    await this.store.update((current) => ({ ...current, dashboardAuth }));
    return dashboardAuth;
  }

  async setProviderContextLimit(
    provider: ProviderContextLimitProvider,
    maxTokens: number | null,
  ): Promise<ProviderContextLimitsConfig> {
    const config = await this.store.update((current) => {
      const providerContextLimits = { ...current.providerContextLimits };
      if (maxTokens === null) delete providerContextLimits[provider];
      else providerContextLimits[provider] = maxTokens;
      return { ...current, providerContextLimits };
    });
    return config.providerContextLimits ?? {};
  }

  async setProviderRuntimeSettings(
    provider: ProviderUsageKind,
    command: string | null,
    args?: string[],
  ): Promise<{
    args: ProviderRuntimeArgsConfig;
    commands: ProviderRuntimeCommandsConfig;
  }> {
    const config = await this.store.update((current) => {
      const providerCommands = { ...current.providerCommands };
      if (command === null) delete providerCommands[provider];
      else providerCommands[provider] = command;

      const providerArgs = { ...current.providerArgs };
      if (args !== undefined) {
        if (args.length === 0) delete providerArgs[provider];
        else providerArgs[provider] = [...args];
      }

      const next = { ...current };
      if (Object.keys(providerCommands).length === 0) delete next.providerCommands;
      else next.providerCommands = providerCommands;
      if (Object.keys(providerArgs).length === 0) delete next.providerArgs;
      else next.providerArgs = providerArgs;
      return next;
    });
    return {
      args: config.providerArgs ?? {},
      commands: config.providerCommands ?? {},
    };
  }

  async setWorkspacePlatform(workspacePlatform: WorkspacePlatform): Promise<WorkspacePlatform> {
    await this.store.update((current) => ({ ...current, workspacePlatform }));
    return workspacePlatform;
  }
}

export const defaultServerSettingsService = new ServerSettingsService();
