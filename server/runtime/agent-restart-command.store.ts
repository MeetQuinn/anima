import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { resolveAnimaHome } from '../anima-home.js';
import { nowIso } from '../ids.js';
import { JsonStore } from '../storage/json-store.js';

const RESTART_COMMANDS_FILE = 'agent-restart-requests.json';

const AgentRestartCommandSchema = z.object({
  agentId: z.string().min(1),
  reason: z.literal('operator_restart'),
  requestId: z.string().min(1),
  requestedAt: z.string().min(1),
});

const AgentRestartCommandStoreSchema = z.object({
  requests: z.record(z.string(), AgentRestartCommandSchema),
});

export type AgentRestartCommand = z.infer<typeof AgentRestartCommandSchema>;

export class AgentRestartCommandStore {
  private readonly store: JsonStore<{ requests: Record<string, AgentRestartCommand> }>;

  constructor(private readonly options: { animaHome?: string } = {}) {
    this.store = new JsonStore({
      empty: () => ({ requests: {} }),
      parse: (value) => AgentRestartCommandStoreSchema.parse(value),
      path: () => this.path(),
      // Same authority as path(): both derive from this store's home, so the
      // guard always protects the root the target actually lives under.
      writeRoot: () => this.animaHome(),
    });
  }

  directory(): string {
    return join(this.animaHome(), 'run');
  }

  filename(): string {
    return RESTART_COMMANDS_FILE;
  }

  path(): string {
    return join(this.directory(), this.filename());
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory(), { recursive: true });
  }

  async request(agentId: string): Promise<AgentRestartCommand> {
    const command: AgentRestartCommand = {
      agentId,
      reason: 'operator_restart',
      requestId: randomUUID(),
      requestedAt: nowIso(),
    };
    await this.store.update((current) => ({
      requests: {
        ...current.requests,
        [agentId]: command,
      },
    }));
    return command;
  }

  async pendingAgentIds(): Promise<string[]> {
    return Object.keys((await this.store.read()).requests).sort();
  }

  async take(agentId: string): Promise<AgentRestartCommand | undefined> {
    let command: AgentRestartCommand | undefined;
    await this.store.update((current) => {
      command = current.requests[agentId];
      if (!command) return current;
      const next = { ...current.requests };
      delete next[agentId];
      return { requests: next };
    });
    return command;
  }

  async clear(agentId: string): Promise<void> {
    await this.store.update((current) => {
      if (!current.requests[agentId]) return current;
      const next = { ...current.requests };
      delete next[agentId];
      return { requests: next };
    });
  }

  private animaHome(): string {
    return this.options.animaHome ?? resolveAnimaHome();
  }
}

export const defaultAgentRestartCommandStore = new AgentRestartCommandStore();
