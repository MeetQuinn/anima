import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { isAgentRunnable } from '../agents/agent-config-ops.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import type {
  AgentConfig,
} from '../../shared/agent-config.js';
import type {
  AgentHealthReason,
  AgentRuntimeHandleSnapshot,
  AgentRuntimeHealthSummary,
  AgentStatusSummary,
} from '../../shared/snapshot.js';
import { agentHasConnectedTransport } from '../../shared/agent-transports.js';
import { nowIso } from '../ids.js';
import { AgentHealthService, defaultAgentHealthService, restartStatus } from './agent-health.service.js';
import { defaultAgentRestartCommandStore } from './agent-restart-command.store.js';
import { findActiveRuntimeItem } from './active-item.js';
import { latestPrimaryRunningItem, processAlive, providerChildIssueReason } from './item-state.js';

export class RuntimeServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class RuntimeService {
  constructor(private readonly health: AgentHealthService = defaultAgentHealthService) {}

  async listStatuses(): Promise<AgentStatusSummary[]> {
    const agents = await defaultAgentRegistryService.listAgentConfigs();
    return Promise.all(agents.map((agent) => this.statusForAgent(agent)));
  }

  async getStatus(agentId: string): Promise<AgentStatusSummary> {
    const agent = await defaultAgentRegistryService.serviceFor(agentId).getConfig();
    return this.statusForAgent(agent);
  }

  async stopCurrentItem(agentId: string): Promise<void> {
    const queue = new WakeQueueService(agentId);
    const running = latestPrimaryRunningItem(await queue.listRunnable());
    if (!running) throw new RuntimeServiceError(409, `No running item for agent ${agentId}`);
    await queue.requestStop(running.id);
  }

  async restartAgent(agentId: string): Promise<{ requestId: string }> {
    const agent = await defaultAgentRegistryService.serviceFor(agentId).getConfig().catch(() => undefined);
    if (!agent) throw new RuntimeServiceError(404, 'Agent not found');
    if (!agent.enabled) throw new RuntimeServiceError(409, 'Agent is disabled. Enable it to run.');
    const command = await defaultAgentRestartCommandStore.request(agentId);
    await this.health.writeHealth({
      agentId,
      reason: 'restart_pending',
      restart: restartStatus(command, 'pending', nowIso()),
      state: 'starting',
      updatedAt: nowIso(),
    });
    return { requestId: command.requestId };
  }

  private async statusForAgent(agent: AgentConfig): Promise<AgentStatusSummary> {
    const queue = new WakeQueueService(agent.id);
    const items = await queue.listRunnable();
    const running = latestPrimaryRunningItem(items);
    const active = running ? await findActiveRuntimeItem(agent.id, queue) : undefined;
    const currentItemStartedAt = active?.startedAt ?? running?.handling.startedAt;
    const health = await this.healthForAgent(agent, {
      ...(active ? { active } : {}),
      ...(running ? { runningItemId: running.id } : {}),
    });
    return {
      agentId: agent.id,
      ...(running ? { currentItemId: running.id } : {}),
      ...(currentItemStartedAt ? { currentItemStartedAt } : {}),
      ...(health ? { health } : {}),
      queueDepth: items.filter((item) => item.handling.status === 'queued').length,
      itemCount: items.length,
    };
  }

  private async healthForAgent(
    agent: AgentConfig,
    queue: {
      active?: { itemId: string; startedAt?: string; workerId: string };
      runningItemId?: string;
    },
  ): Promise<AgentRuntimeHealthSummary | undefined> {
    if (!expectsRuntimeHealth(agent)) return undefined;

    const snapshot = await this.health.get(agent.id);
    if (!snapshot) {
      return queue.runningItemId
        ? syntheticHealth('unhealthy', 'stale_running_item')
        : syntheticHealth('unknown');
    }

    const timedOut = startingTimedOut(snapshot);
    if (timedOut) return timedOut;

    const staleReason = staleRuntimeReason(queue, snapshot.runtime);
    if (staleReason) return syntheticHealth('unhealthy', staleReason, snapshot);

    const runtimeReason = runtimeProcessReason(snapshot.runtime);
    if (runtimeReason) return syntheticHealth('unhealthy', runtimeReason, snapshot);

    return snapshot;
  }
}

export const defaultRuntimeService = new RuntimeService();

const STARTING_TIMEOUT_MS = 30_000;
const FRESH_RUNNING_STALE_GRACE_MS = 10_000;

function expectsRuntimeHealth(agent: AgentConfig): boolean {
  if (agent.enabled === false) return false;
  if (!agentHasConnectedTransport(agent)) return false;
  return isAgentRunnable(agent);
}

function startingTimedOut(snapshot: AgentRuntimeHealthSummary): AgentRuntimeHealthSummary | undefined {
  if (snapshot.state !== 'starting') return undefined;
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < STARTING_TIMEOUT_MS) return undefined;
  const reason: AgentHealthReason = snapshot.restart?.outcome === 'pending'
    ? 'restart_failed'
    : 'start_failed';
  return syntheticHealth('unhealthy', reason, {
    ...snapshot,
    restart: snapshot.restart?.outcome === 'pending'
      ? {
          ...snapshot.restart,
          completedAt: nowIso(),
          outcome: 'failed',
          reason,
        }
      : snapshot.restart,
  });
}

function staleRuntimeReason(
  queue: {
    active?: { itemId: string; startedAt?: string; workerId: string };
    runningItemId?: string;
  },
  runtime: AgentRuntimeHandleSnapshot | undefined,
): AgentHealthReason | undefined {
  if (!queue.runningItemId) return undefined;
  if (!queue.active) return 'stale_running_item';
  if (!runtime) return 'stale_running_item';
  if (!runtime.workerId || runtime.workerId !== queue.active.workerId) return 'stale_running_item';
  if (!runtime.activeItemId || runtime.activeItemId !== queue.runningItemId) {
    return freshRunningItem(queue.active.startedAt) ? undefined : 'stale_running_item';
  }
  if (runtime.processId && !processAlive(runtime.processId)) return 'stale_running_item';
  return undefined;
}

function runtimeProcessReason(
  runtime: AgentRuntimeHandleSnapshot | undefined,
): AgentHealthReason | undefined {
  if (!runtime) return undefined;
  if (runtime.processId && !processAlive(runtime.processId)) return 'start_failed';
  return providerChildIssueReason(runtime, { checkPid: true });
}

function syntheticHealth(
  state: AgentRuntimeHealthSummary['state'],
  reason?: AgentHealthReason,
  base?: AgentRuntimeHealthSummary,
): AgentRuntimeHealthSummary {
  return {
    ...(reason ? { reason } : {}),
    ...(base?.restart ? { restart: base.restart } : {}),
    ...(base?.runtime ? { runtime: base.runtime } : {}),
    state,
    updatedAt: nowIso(),
  };
}

function freshRunningItem(startedAt: string | undefined): boolean {
  if (!startedAt) return false;
  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) && Date.now() - startedAtMs < FRESH_RUNNING_STALE_GRACE_MS;
}
