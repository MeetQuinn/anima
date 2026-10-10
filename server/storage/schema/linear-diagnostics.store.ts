import { join } from 'node:path';
import { z } from 'zod';
import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';
import { AGENT_ID } from './agent.store.js';

const Diagnostics = z.object({ installationId: z.string().optional(), signatureFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0) });
type Diagnostics = z.infer<typeof Diagnostics>;

export class LinearDiagnosticsStore {
  private readonly file: JsonStore<Diagnostics>;
  constructor(agentId: string, animaHome = resolveAnimaHome()) {
    if (!AGENT_ID.test(agentId) || agentId === '.' || agentId === '..') throw new Error('Invalid agent id');
    this.file = new JsonStore({
      path: () => join(animaHome, 'agents', agentId, 'linear-diagnostics.json'), writeRoot: () => animaHome,
      mode: 0o600, empty: () => ({ signatureFailures: 0 }), parse: (value) => Diagnostics.parse(value),
    });
  }
  read(): Promise<Diagnostics> { return this.file.read(); }
  async addRejectedClaims(installationId: string, count: number): Promise<void> {
    await this.file.update((file) => ({ installationId, signatureFailures: Math.min(Number.MAX_SAFE_INTEGER,
      (file.installationId === installationId ? file.signatureFailures : 0) + count) }));
  }
}
