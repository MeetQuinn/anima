// Disk schema for ANIMA_HOME/config.json.
// This is server-level configuration shared by all agents in one Anima home.

import { join } from 'node:path';

import { z } from 'zod';

import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';
import { ReleaseTrack, ServerTrack, SidebarOrder, WorkspacePlatform } from '../../../shared/server-settings.js';

export const ServerConfig = z.object({
  dashboardHost: z.string().min(1).optional(),
  dashboardPort: z.number().int().positive().max(65535).optional(),
  releaseTrack: ReleaseTrack.optional(),
  sidebarOrder: SidebarOrder.optional(),
  track: ServerTrack.optional(),
  workspacePlatform: WorkspacePlatform.optional(),
}).strict();

export type ServerConfig = z.infer<typeof ServerConfig>;

export class ServerConfigStore {
  private readonly file = new JsonStore<ServerConfig>({
    empty: () => ({}),
    parse: ServerConfig.parse,
    path: () => join(resolveAnimaHome(), 'config.json'),
  });

  read(): Promise<ServerConfig> {
    return this.file.read();
  }

  write(config: ServerConfig): Promise<void> {
    return this.file.write(config);
  }
}

export const serverConfigStore = new ServerConfigStore();
