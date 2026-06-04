import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { resolveAnimaHome } from '../anima-home.js';
import { JsonStore } from '../storage/json-store.js';
import type {
  AgentHealthReason,
  AgentHealthState,
  AgentRestartOutcome,
  AgentRestartStatusSummary,
  AgentRuntimeHandleSnapshot,
  AgentRuntimeHealthSummary,
  ProviderChildHealthSnapshot,
} from '../../shared/snapshot.js';

const AGENT_HEALTH_FILE = 'agent-health-snapshots.json';

const AgentHealthStateSchema: z.ZodType<AgentHealthState> = z.enum([
  'degraded',
  'healthy',
  'starting',
  'unhealthy',
  'unknown',
]);

const AgentHealthReasonSchema: z.ZodType<AgentHealthReason> = z.enum([
  'provider_child_missing',
  'provider_child_exited',
  'provider_auth_failed',
  'provider_quota_exhausted',
  'provider_error',
  'provider_rate_limited',
  'stale_running_item',
  'restart_pending',
  'restart_failed',
  'start_failed',
]);

const AgentRestartOutcomeSchema: z.ZodType<AgentRestartOutcome> = z.enum([
  'pending',
  'recovered',
  'failed',
]);

const ProviderChildHealthSnapshotSchema: z.ZodType<ProviderChildHealthSnapshot> = z.object({
  alive: z.boolean(),
  command: z.string().min(1),
  exited: z.boolean(),
  exitedAt: z.string().min(1).optional(),
  exitCode: z.number().nullable().optional(),
  label: z.string().min(1),
  lastStderrAt: z.string().min(1).optional(),
  lastStdoutAt: z.string().min(1).optional(),
  pid: z.number().int().positive().optional(),
  signal: z.string().nullable().optional(),
  startedAt: z.string().min(1),
  stdinWritable: z.boolean(),
});

const AgentRuntimeHandleSnapshotSchema: z.ZodType<AgentRuntimeHandleSnapshot> = z.object({
  activeItemId: z.string().min(1).optional(),
  activeItemStartedAt: z.string().min(1).optional(),
  processId: z.number().int().positive().optional(),
  providerChild: ProviderChildHealthSnapshotSchema.optional(),
  providerChildExpected: z.boolean(),
  workerId: z.string().min(1).optional(),
});

const AgentRestartStatusSummarySchema: z.ZodType<AgentRestartStatusSummary> = z.object({
  completedAt: z.string().min(1).optional(),
  outcome: AgentRestartOutcomeSchema,
  providerChildPid: z.number().int().positive().optional(),
  reason: AgentHealthReasonSchema.optional(),
  requestId: z.string().min(1),
  requestedAt: z.string().min(1),
  workerPid: z.number().int().positive().optional(),
});

const AgentRuntimeHealthSummarySchema: z.ZodType<AgentRuntimeHealthSummary> = z.object({
  reason: AgentHealthReasonSchema.optional(),
  restart: AgentRestartStatusSummarySchema.optional(),
  runtime: AgentRuntimeHandleSnapshotSchema.optional(),
  state: AgentHealthStateSchema,
  updatedAt: z.string().min(1),
});

const AgentHealthStoreSchema = z.object({
  snapshots: z.record(z.string(), AgentRuntimeHealthSummarySchema),
});

interface AgentHealthStoreFile {
  snapshots: Record<string, AgentRuntimeHealthSummary>;
}

export const PROVIDER_RATE_LIMIT_GRACE_MS = 60_000;
export const PROVIDER_RATE_LIMIT_RED_STALE_MS = 5 * 60_000;

export class AgentHealthStore {
  private readonly store: JsonStore<AgentHealthStoreFile>;

  constructor(private readonly options: { animaHome?: string } = {}) {
    this.store = new JsonStore({
      empty: () => ({ snapshots: {} }),
      parse: (value) => AgentHealthStoreSchema.parse(value),
      path: () => this.path(),
    });
  }

  directory(): string {
    return join(this.animaHome(), 'run');
  }

  filename(): string {
    return AGENT_HEALTH_FILE;
  }

  path(): string {
    return join(this.directory(), this.filename());
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory(), { recursive: true });
  }

  async get(agentId: string): Promise<AgentRuntimeHealthSummary | undefined> {
    return (await this.store.read()).snapshots[agentId];
  }

  async list(): Promise<Record<string, AgentRuntimeHealthSummary>> {
    return (await this.store.read()).snapshots;
  }

  async write(agentId: string, snapshot: AgentRuntimeHealthSummary): Promise<void> {
    await this.store.update((current) => ({
      snapshots: {
        ...current.snapshots,
        [agentId]: snapshot,
      },
    }));
  }

  async writeHealth(input: {
    agentId: string;
    clearProviderFailure?: boolean;
    reason?: AgentHealthReason;
    restart?: AgentRestartStatusSummary;
    runtime?: AgentRuntimeHandleSnapshot;
    state: AgentHealthState;
    updatedAt: string;
  }): Promise<void> {
    await this.store.update((current) => {
      const previous = current.snapshots[input.agentId];
      const providerFailure = carriedProviderFailure(previous, input);
      if (providerFailure) {
        return {
          snapshots: {
            ...current.snapshots,
            [input.agentId]: providerFailure,
          },
        };
      }
      const restart = input.restart ?? carriedRestart(previous, input.state);
      return {
        snapshots: {
          ...current.snapshots,
          [input.agentId]: {
            ...(input.reason ? { reason: input.reason } : {}),
            ...(restart ? { restart } : {}),
            ...(input.runtime ? { runtime: input.runtime } : {}),
            state: input.state,
            updatedAt: input.updatedAt,
          },
        },
      };
    });
  }

  async writeProviderFailure(input: {
    agentId: string;
    reason: AgentHealthReason;
    runtime?: AgentRuntimeHandleSnapshot;
    updatedAt: string;
  }): Promise<void> {
    await this.store.update((current) => {
      const previous = current.snapshots[input.agentId];
      const snapshot = providerFailureSnapshot(previous, input);
      return {
        snapshots: {
          ...current.snapshots,
          [input.agentId]: snapshot,
        },
      };
    });
  }

  async clear(agentId: string): Promise<void> {
    await this.store.update((current) => {
      if (!current.snapshots[agentId]) return current;
      const next = { ...current.snapshots };
      delete next[agentId];
      return { snapshots: next };
    });
  }

  private animaHome(): string {
    return this.options.animaHome ?? resolveAnimaHome();
  }
}

function carriedProviderFailure(
  previous: AgentRuntimeHealthSummary | undefined,
  input: {
    clearProviderFailure?: boolean;
    reason?: AgentHealthReason;
    restart?: AgentRestartStatusSummary;
    runtime?: AgentRuntimeHandleSnapshot;
    state: AgentHealthState;
    updatedAt: string;
  },
): AgentRuntimeHealthSummary | undefined {
  if (input.clearProviderFailure) return undefined;
  if (input.state !== 'healthy') return undefined;
  if (!previous?.reason || !isProviderFailureReason(previous.reason)) return undefined;
  if (previous.reason === 'provider_rate_limited') {
    return carriedRateLimit(previous, input);
  }
  return {
    reason: previous.reason,
    ...(input.runtime ? { runtime: input.runtime } : previous.runtime ? { runtime: previous.runtime } : {}),
    state: 'unhealthy',
    updatedAt: input.updatedAt,
  };
}

function isProviderFailureReason(reason: AgentHealthReason): boolean {
  return reason === 'provider_auth_failed'
    || reason === 'provider_quota_exhausted'
    || reason === 'provider_error'
    || reason === 'provider_rate_limited';
}

function providerFailureSnapshot(
  previous: AgentRuntimeHealthSummary | undefined,
  input: {
    reason: AgentHealthReason;
    runtime?: AgentRuntimeHandleSnapshot;
    updatedAt: string;
  },
): AgentRuntimeHealthSummary {
  if (input.reason !== 'provider_rate_limited') {
    return {
      reason: input.reason,
      ...(input.runtime ? { runtime: input.runtime } : {}),
      state: 'unhealthy',
      updatedAt: input.updatedAt,
    };
  }

  const sameRateLimit = previous?.reason === 'provider_rate_limited';
  const firstObservedAt = sameRateLimit ? previous.updatedAt : input.updatedAt;
  const elapsedMs = Date.parse(input.updatedAt) - Date.parse(firstObservedAt);
  const shouldEscalate =
    sameRateLimit &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= PROVIDER_RATE_LIMIT_GRACE_MS;

  return {
    reason: 'provider_rate_limited',
    ...(input.runtime ? { runtime: input.runtime } : previous?.runtime ? { runtime: previous.runtime } : {}),
    state: shouldEscalate ? 'unhealthy' : 'degraded',
    updatedAt: shouldEscalate ? input.updatedAt : firstObservedAt,
  };
}

function carriedRateLimit(
  previous: AgentRuntimeHealthSummary,
  input: {
    runtime?: AgentRuntimeHandleSnapshot;
    updatedAt: string;
  },
): AgentRuntimeHealthSummary | undefined {
  const ageMs = Date.parse(input.updatedAt) - Date.parse(previous.updatedAt);
  const finiteAge = Number.isFinite(ageMs) ? ageMs : 0;
  const runtime = input.runtime ? { runtime: input.runtime } : previous.runtime ? { runtime: previous.runtime } : {};

  if (previous.state === 'degraded') {
    if (finiteAge < PROVIDER_RATE_LIMIT_GRACE_MS) {
      return {
        reason: 'provider_rate_limited',
        ...runtime,
        state: 'degraded',
        updatedAt: previous.updatedAt,
      };
    }
    return {
      ...runtime,
      state: 'unknown',
      updatedAt: input.updatedAt,
    };
  }

  if (previous.state === 'unhealthy') {
    if (finiteAge < PROVIDER_RATE_LIMIT_RED_STALE_MS) {
      return {
        reason: 'provider_rate_limited',
        ...runtime,
        state: 'unhealthy',
        updatedAt: previous.updatedAt,
      };
    }
    return {
      ...runtime,
      state: 'unknown',
      updatedAt: input.updatedAt,
    };
  }

  return undefined;
}

function carriedRestart(
  previous: AgentRuntimeHealthSummary | undefined,
  nextState: AgentHealthState,
): AgentRestartStatusSummary | undefined {
  if (!previous?.restart) return undefined;
  if (nextState === 'healthy' && previous.restart.outcome === 'failed') return undefined;
  return previous.restart;
}

export const defaultAgentHealthStore = new AgentHealthStore();
