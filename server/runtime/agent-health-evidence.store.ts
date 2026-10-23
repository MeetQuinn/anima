import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { StaleRunningEvidence } from '../../shared/diagnostics.js';
import { resolveAnimaHome } from '../anima-home.js';
import { JsonStore } from '../storage/json-store.js';
import { AGENT_ID } from '../storage/schema/agent.store.js';

export const HEALTH_EVIDENCE_CAP = 20;
const identifier = z.string().min(1).max(256);
const pid = z.number().int().positive();
const Evidence: z.ZodType<StaleRunningEvidence> = z.object({
  observedAt: z.string().datetime(),
  snapshotUpdatedAt: z.string().max(64).optional(),
  mismatch: z.enum([
    'active_missing',
    'snapshot_missing',
    'worker_mismatch',
    'item_mismatch',
    'worker_dead',
    'provider_child_missing',
    'provider_child_exited',
  ]),
  queue: z.object({
    runningItemId: identifier,
    activePresent: z.boolean(),
    workerId: identifier.optional(),
    startedAt: z.string().max(64).optional(),
  }),
  runtime: z.object({
    present: z.boolean(),
    activeItemId: identifier.optional(),
    workerId: identifier.optional(),
    processId: pid.optional(),
    processAlive: z.boolean().optional(),
    providerChildExpected: z.boolean().optional(),
    providerChild: z.object({
      present: z.boolean(),
      pid: pid.optional(),
      processAlive: z.boolean().optional(),
      alive: z.boolean().optional(),
      exited: z.boolean().optional(),
      stdinWritable: z.boolean().optional(),
    }),
  }),
  grace: z.object({
    active: z.boolean(),
    milliseconds: z.number().nonnegative(),
  }),
});
const File = z.object({
  activeFingerprint: z.string().length(64).optional(),
  events: z.array(Evidence).max(HEALTH_EVIDENCE_CAP),
});

export class AgentHealthEvidenceStore {
  private readonly file: JsonStore<z.infer<typeof File>>;

  constructor(agentId: string, animaHome = resolveAnimaHome()) {
    if (!AGENT_ID.test(agentId) || agentId === '.' || agentId === '..')
      throw new Error('Invalid agent id');
    this.file = new JsonStore<z.infer<typeof File>>({
      path: () => join(animaHome, 'agents', agentId, 'health-evidence.json'),
      writeRoot: () => animaHome,
      mode: 0o600,
      empty: () => ({ events: [] }),
      parse: (value) => File.parse(value),
    });
  }

  async list(): Promise<StaleRunningEvidence[]> {
    return (await this.file.read()).events;
  }

  async observe(input: StaleRunningEvidence | undefined): Promise<void> {
    // Parse before persistence too: incidental runtime/provider fields never reach disk.
    const evidence = input && Evidence.parse(input);
    let fingerprint: string | undefined;
    if (evidence) {
      const {
        observedAt: _observedAt,
        snapshotUpdatedAt: _snapshotUpdatedAt,
        ...identity
      } = evidence;
      fingerprint = createHash('sha256')
        .update(JSON.stringify(identity))
        .digest('hex');
    }
    // Normal polls do not acquire a file lock, create a file, or rewrite timestamps.
    if ((await this.file.read()).activeFingerprint === fingerprint) return;
    await this.file.update((current) => {
      if (current.activeFingerprint === fingerprint) return current;
      if (!evidence) return { events: current.events };
      return {
        activeFingerprint: fingerprint,
        events: [...current.events, evidence].slice(-HEALTH_EVIDENCE_CAP),
      };
    });
  }
}
