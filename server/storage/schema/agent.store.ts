// Disk schema for agents/<agentId>/config.json.
// This is user-managed configuration, not runtime state. It can contain
// Slack tokens, so backups and diagnostics must treat it as sensitive.

import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';
import { agentConfigSchema, type AgentConfig } from '../../../shared/agent-config.js';

export const AGENT_ID = /^[A-Za-z0-9._-]+$/;

function getAgentConfigFileStore(agentId: string): JsonStore<AgentConfig> {
  return new JsonStore<AgentConfig>({
    empty: () => agentConfigSchema(agentId).parse({}),
    parse: (value) => agentConfigSchema(agentId).parse(value),
    path: () => agentConfigPath(agentId),
  });
}

function agentPath(agentId: string): string {
  return join(agentsDir(), agentId);
}

function agentConfigPath(agentId: string): string {
  return join(agentsDir(), agentId, 'config.json');
}

function agentConfigExists(agentId: string): boolean {
  return existsSync(agentConfigPath(agentId));
}

export function agentsDir(): string {
  return join(resolveAnimaHome(), 'agents');
}

export class AgentStore {
  private readonly file: JsonStore<AgentConfig>;

  constructor(private readonly agentId: string) {
    this.file = getAgentConfigFileStore(agentId);
  }

  exists(): boolean {
    return agentConfigExists(this.agentId);
  }

  path(): string {
    return agentConfigPath(this.agentId);
  }

  async read(): Promise<AgentConfig> {
    return this.file.read();
  }

  async write(agent: AgentConfig): Promise<AgentConfig> {
    await this.file.write(agent);
    return agent;
  }

  update(op: (agent: AgentConfig) => AgentConfig): Promise<AgentConfig> {
    return this.file.update(op);
  }

  async remove(): Promise<void> {
    await rm(agentPath(this.agentId), { force: true, recursive: true });
  }
}

export class AgentRegistryStore {
  async listIds(): Promise<string[]> {
    if (!existsSync(agentsDir())) return [];
    const entries = await readdir(agentsDir(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && agentConfigExists(entry.name))
      .map((entry) => entry.name)
      .sort();
  }
}
