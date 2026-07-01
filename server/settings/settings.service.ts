import type {
  DashboardAuth,
  ReleaseTrack,
  ServerTrack,
  SidebarOrder,
  TeamConfig,
  WorkspacePlatform,
} from '../../shared/server-settings.js';
import {
  serverConfigStore,
  type ServerConfig,
  type ServerConfigStore,
} from '../storage/schema/server.store.js';

export interface DashboardSettings {
  host: string;
  port: number;
}

export class ServerSettingsService {
  constructor(private readonly store: ServerConfigStore = serverConfigStore) {}

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

  async getTrack(): Promise<ServerTrack> {
    const config = await this.store.read();
    return config.track ?? config.releaseTrack ?? 'stable';
  }

  async getWorkspacePlatform(): Promise<WorkspacePlatform> {
    const config = await this.store.read();
    return config.workspacePlatform ?? 'slack';
  }

  async setReleaseTrack(releaseTrack: ReleaseTrack): Promise<ReleaseTrack> {
    const config = await this.store.read();
    await this.store.write({ ...config, releaseTrack, track: releaseTrack });
    return releaseTrack;
  }

  async setSidebarOrder(sidebarOrder: SidebarOrder): Promise<SidebarOrder> {
    const config = await this.store.read();
    await this.store.write({ ...config, sidebarOrder });
    return sidebarOrder;
  }

  async setTeams(teams: TeamConfig[]): Promise<TeamConfig[]> {
    const config = await this.store.read();
    await this.store.write({ ...config, teams });
    return teams;
  }

  async setDashboardAuth(dashboardAuth: DashboardAuth): Promise<DashboardAuth> {
    const config = await this.store.read();
    await this.store.write({ ...config, dashboardAuth });
    return dashboardAuth;
  }

  async setWorkspacePlatform(workspacePlatform: WorkspacePlatform): Promise<WorkspacePlatform> {
    const config = await this.store.read();
    await this.store.write({ ...config, workspacePlatform });
    return workspacePlatform;
  }
}

export const defaultServerSettingsService = new ServerSettingsService();
