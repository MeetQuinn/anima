// Disk schema for ANIMA_HOME/config.json.
// This is server-level configuration shared by all agents in one Anima home.

import { join } from 'node:path';

import { z } from 'zod';

import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';
import {
  CursorDeliveryConfig,
  DashboardAuth,
  MemoryCoherenceConfig,
  ProviderContextLimitsConfig,
  ProviderRuntimeArgsConfig,
  ProviderRuntimeCommandsConfig,
  ReleaseTrack,
  RuntimeConfig,
  ServerTrack,
  SidebarOrder,
  TeamConfig,
  WorkspacePlatform,
} from '../../../shared/server-settings.js';

// Shape stays strict for unknown keys so new typos still fail loudly.
// Exception: leftover `providerAccounts` from the removed multi-account feature
// is stripped before parse so stale config.json boots without error. The value
// is never read, written, or rendered (feature stays dead).
const ServerConfigFields = z
  .object({
    cursorDelivery: CursorDeliveryConfig.optional(),
    dashboardAuth: DashboardAuth.optional(),
    dashboardHost: z.string().min(1).optional(),
    dashboardPort: z.number().int().positive().max(65535).optional(),
    memoryCoherence: MemoryCoherenceConfig.optional(),
    providerContextLimits: ProviderContextLimitsConfig.optional(),
    providerArgs: ProviderRuntimeArgsConfig.optional(),
    providerCommands: ProviderRuntimeCommandsConfig.optional(),
    releaseTrack: ReleaseTrack.optional(),
    runtime: RuntimeConfig.optional(),
    sidebarOrder: SidebarOrder.optional(),
    // Team registry. Optional + never schema-defaulted, so a legacy/empty config still loads
    // as `{}` (zero-touch upgrade). The default team is synthesized in TeamService, not here.
    teams: z.array(TeamConfig).optional(),
    track: ServerTrack.optional(),
    workspacePlatform: WorkspacePlatform.optional(),
  })
  .strict();

export const ServerConfig = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!Object.prototype.hasOwnProperty.call(value, 'providerAccounts')) return value;
  const { providerAccounts: _ignored, ...rest } = value as Record<string, unknown>;
  return rest;
}, ServerConfigFields);

export type ServerConfig = z.infer<typeof ServerConfigFields>;

export class ServerConfigStore {
  constructor(private readonly animaHome?: string) {}

  private readonly file = new JsonStore<ServerConfig>({
    empty: () => ({}),
    parse: ServerConfig.parse,
    path: () => join(this.animaHome ?? resolveAnimaHome(), 'config.json'),
    // Same authority as path(). Deriving the root separately would let a store
    // built with an explicit home protect the ambient one instead, and then
    // recreate its own home as an "outside" path.
    writeRoot: () => this.animaHome ?? resolveAnimaHome(),
  });

  read(): Promise<ServerConfig> {
    return this.file.read();
  }

  write(config: ServerConfig): Promise<void> {
    return this.file.write(config);
  }

  update(
    op: (config: ServerConfig) => ServerConfig | Promise<ServerConfig>,
  ): Promise<ServerConfig> {
    return this.file.update(op);
  }
}

export const serverConfigStore = new ServerConfigStore();
