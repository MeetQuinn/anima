import { AgentHealthStore, defaultAgentHealthStore } from './agent-health.store.js';
import { processAlive, providerChildIssueReason } from './item-state.js';
import type { AgentRestartCommand } from './agent-restart-command.store.js';
import type {
  AgentHealthReason,
  AgentHealthState,
  AgentRestartOutcome,
  AgentRestartStatusSummary,
  AgentRuntimeHandleSnapshot,
  AgentRuntimeHealthSummary,
} from '../../shared/snapshot.js';

export const PROVIDER_RATE_LIMIT_GRACE_MS = 60_000;
export const PROVIDER_RATE_LIMIT_RED_STALE_MS = 5 * 60_000;
export const STARTING_TIMEOUT_MS = 30_000;
export const RUNTIME_CHILD_HEALTH_DEBOUNCE_MS = 10_000;
export const FRESH_RUNNING_STALE_GRACE_MS = 10_000;

export interface HealthWriteInput {
  agentId: string;
  clearProviderFailure?: boolean;
  reason?: AgentHealthReason;
  restart?: AgentRestartStatusSummary;
  runtime?: AgentRuntimeHandleSnapshot;
  state: AgentHealthState;
  updatedAt: string;
}

export interface ProviderFailureInput {
  agentId: string;
  reason: AgentHealthReason;
  runtime?: AgentRuntimeHandleSnapshot;
  updatedAt: string;
}

// The single write path for agent health. Carry rules run inside the store's
// locked update() closure: the web process (restartAgent) and the agent
// process (host timer, worker, provider-runner) write concurrently, so the
// read-modify-write must be atomic. Do not split it into get() + write().
export class AgentHealthService {
  constructor(private readonly store: AgentHealthStore = defaultAgentHealthStore) {}

  async ensureDirectory(): Promise<void> {
    await this.store.ensureDirectory();
  }

  async get(agentId: string): Promise<AgentRuntimeHealthSummary | undefined> {
    return this.store.get(agentId);
  }

  async clear(agentId: string): Promise<void> {
    await this.store.clear(agentId);
  }

  async writeHealth(input: HealthWriteInput): Promise<void> {
    await this.store.update(input.agentId, (previous) => applyHealthWrite(previous, input));
  }

  async writeProviderFailure(input: ProviderFailureInput): Promise<void> {
    await this.store.update(input.agentId, (previous) => applyProviderFailure(previous, input));
  }
}

export const defaultAgentHealthService = new AgentHealthService();

export function applyHealthWrite(
  previous: AgentRuntimeHealthSummary | undefined,
  input: Omit<HealthWriteInput, 'agentId'>,
): AgentRuntimeHealthSummary {
  const providerFailure = carriedProviderFailure(previous, input);
  if (providerFailure) return providerFailure;
  const restart = input.restart ?? carriedRestart(previous, input.state);
  return {
    ...(input.reason ? { reason: input.reason } : {}),
    ...(restart ? { restart } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    state: input.state,
    updatedAt: input.updatedAt,
  };
}

export function applyProviderFailure(
  previous: AgentRuntimeHealthSummary | undefined,
  input: Omit<ProviderFailureInput, 'agentId'>,
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

// Health of a live runtime handle. Transient provider-child issues (child
// missing or exited) debounce as degraded for RUNTIME_CHILD_HEALTH_DEBOUNCE_MS
// before escalating: the child may be mid-respawn when the host samples it.
export function runtimeHandleHealth(
  runtime: AgentRuntimeHandleSnapshot | undefined,
  previous: AgentRuntimeHealthSummary | undefined,
  nowIso: string,
): { reason?: AgentHealthReason; state: 'degraded' | 'healthy' | 'unhealthy'; updatedAt: string } {
  if (!runtime) return { reason: 'start_failed', state: 'unhealthy', updatedAt: nowIso };
  const reason = providerChildIssueReason(runtime);
  if (!reason) return { state: 'healthy', updatedAt: nowIso };
  if (previous?.reason === reason && previous.state === 'unhealthy') {
    return { reason, state: 'unhealthy', updatedAt: nowIso };
  }
  if (previous?.reason === reason && previous.state === 'degraded') {
    const ageMs = Date.parse(nowIso) - Date.parse(previous.updatedAt);
    if (Number.isFinite(ageMs) && ageMs < RUNTIME_CHILD_HEALTH_DEBOUNCE_MS) {
      return { reason, state: 'degraded', updatedAt: previous.updatedAt };
    }
    return { reason, state: 'unhealthy', updatedAt: nowIso };
  }
  return { reason, state: 'degraded', updatedAt: nowIso };
}

// A 'starting' snapshot older than STARTING_TIMEOUT_MS means the start attempt
// died without settling health. A pending restart fails; otherwise the start
// failed. Returns undefined while the snapshot is still fresh or not starting.
export function startingTimeoutHealth(
  snapshot: AgentRuntimeHealthSummary,
  nowIso: string,
): AgentRuntimeHealthSummary | undefined {
  if (snapshot.state !== 'starting') return undefined;
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt) || Date.parse(nowIso) - updatedAt < STARTING_TIMEOUT_MS) return undefined;
  const reason: AgentHealthReason = snapshot.restart?.outcome === 'pending' ? 'restart_failed' : 'start_failed';
  const restart = snapshot.restart?.outcome === 'pending'
    ? { ...snapshot.restart, completedAt: nowIso, outcome: 'failed' as const, reason }
    : snapshot.restart;
  return {
    reason,
    ...(restart ? { restart } : {}),
    ...(snapshot.runtime ? { runtime: snapshot.runtime } : {}),
    state: 'unhealthy',
    updatedAt: nowIso,
  };
}

// The single stale-running-item predicate: does the queue's running item lack
// a live worker that owns it? The two callers intentionally probe differently:
// the host (restart path) uses grace 0 + the provider-child check because it is
// about to fail the item and wants every wedged shape caught; the API read side
// allows FRESH_RUNNING_STALE_GRACE_MS for a just-claimed item (the stored
// snapshot can be one publish tick behind the queue) and leaves child issues to
// surface as provider_child_* instead of stale_running_item.
export function isStaleRunningItem(input: {
  active?: { startedAt?: string; workerId: string };
  activeItemMismatchGraceMs: number;
  includeProviderChildCheck: boolean;
  nowMs: number;
  runningItemId: string;
  runtime: AgentRuntimeHandleSnapshot | undefined;
}): boolean {
  const { active, runtime } = input;
  if (!active) return true;
  if (!runtime) return true;
  if (!runtime.workerId || runtime.workerId !== active.workerId) return true;
  if (!runtime.activeItemId || runtime.activeItemId !== input.runningItemId) {
    return !withinGrace(active.startedAt, input.activeItemMismatchGraceMs, input.nowMs);
  }
  if (runtime.processId && !processAlive(runtime.processId)) return true;
  if (input.includeProviderChildCheck && providerChildIssueReason(runtime, { checkPid: true })) return true;
  return false;
}

// Read-time health for the status API: overrides the stored snapshot with
// synthetics when the world has moved on since the last write (start attempt
// timed out, running item lost its worker, worker process or provider child
// died).
export function deriveApiHealth(
  snapshot: AgentRuntimeHealthSummary | undefined,
  queue: { active?: { startedAt?: string; workerId: string }; runningItemId?: string },
  nowIso: string,
): AgentRuntimeHealthSummary {
  if (!snapshot) {
    return queue.runningItemId
      ? syntheticHealth('unhealthy', 'stale_running_item', undefined, nowIso)
      : syntheticHealth('unknown', undefined, undefined, nowIso);
  }

  const timedOut = startingTimeoutHealth(snapshot, nowIso);
  if (timedOut) return timedOut;

  const stale = queue.runningItemId !== undefined && isStaleRunningItem({
    activeItemMismatchGraceMs: FRESH_RUNNING_STALE_GRACE_MS,
    ...(queue.active ? { active: queue.active } : {}),
    includeProviderChildCheck: false,
    nowMs: Date.parse(nowIso),
    runningItemId: queue.runningItemId,
    runtime: snapshot.runtime,
  });
  if (stale) return syntheticHealth('unhealthy', 'stale_running_item', snapshot, nowIso);

  const runtimeReason = runtimeProcessReason(snapshot.runtime);
  if (runtimeReason) return syntheticHealth('unhealthy', runtimeReason, snapshot, nowIso);

  return snapshot;
}

export function restartStatus(
  command: AgentRestartCommand,
  outcome: AgentRestartOutcome,
  nowIso: string,
  runtime?: AgentRuntimeHandleSnapshot,
  reason?: AgentHealthReason,
): AgentRestartStatusSummary {
  return {
    ...(outcome !== 'pending' ? { completedAt: nowIso } : {}),
    outcome,
    ...(runtime?.providerChild?.pid ? { providerChildPid: runtime.providerChild.pid } : {}),
    ...(reason ? { reason } : {}),
    requestId: command.requestId,
    requestedAt: command.requestedAt,
    ...(runtime?.processId ? { workerPid: runtime.processId } : {}),
  };
}

export function isProviderFailureReason(reason: AgentHealthReason | undefined): boolean {
  return reason === 'provider_auth_failed'
    || reason === 'provider_quota_exhausted'
    || reason === 'provider_error'
    || reason === 'provider_rate_limited';
}

function carriedProviderFailure(
  previous: AgentRuntimeHealthSummary | undefined,
  input: Omit<HealthWriteInput, 'agentId'>,
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

function carriedRateLimit(
  previous: AgentRuntimeHealthSummary,
  input: { runtime?: AgentRuntimeHandleSnapshot; updatedAt: string },
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

function withinGrace(startedAt: string | undefined, graceMs: number, nowMs: number): boolean {
  if (!startedAt) return false;
  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) && nowMs - startedAtMs < graceMs;
}

function runtimeProcessReason(
  runtime: AgentRuntimeHandleSnapshot | undefined,
): AgentHealthReason | undefined {
  if (!runtime) return undefined;
  if (runtime.processId && !processAlive(runtime.processId)) return 'start_failed';
  return providerChildIssueReason(runtime, { checkPid: true });
}

function syntheticHealth(
  state: AgentHealthState,
  reason: AgentHealthReason | undefined,
  base: AgentRuntimeHealthSummary | undefined,
  nowIso: string,
): AgentRuntimeHealthSummary {
  return {
    ...(reason ? { reason } : {}),
    ...(base?.restart ? { restart: base.restart } : {}),
    ...(base?.runtime ? { runtime: base.runtime } : {}),
    state,
    updatedAt: nowIso,
  };
}
