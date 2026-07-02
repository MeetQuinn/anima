import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { isAgentRunnable } from '../agents/agent-config-ops.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import type {
  AgentConfig,
} from '../../shared/agent-config.js';
import type {
  AgentRuntimeHealthSummary,
  AgentStatusSummary,
} from '../../shared/snapshot.js';
import { agentHasConnectedTransport } from '../../shared/agent-transports.js';
import { nowIso } from '../ids.js';
import { AgentHealthService, defaultAgentHealthService, deriveApiHealth, restartStatus } from './agent-health.service.js';
import { defaultAgentRestartCommandStore } from './agent-restart-command.store.js';
import { findActiveRuntimeItem } from './active-item.js';
import { latestPrimaryRunningItem } from './item-state.js';

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
      active?: { startedAt?: string; workerId: string };
      runningItemId?: string;
    },
  ): Promise<AgentRuntimeHealthSummary | undefined> {
    if (!expectsRuntimeHealth(agent)) return undefined;
    return deriveApiHealth(await this.health.get(agent.id), queue, nowIso());
  }
}

export const defaultRuntimeService = new RuntimeService();

function expectsRuntimeHealth(agent: AgentConfig): boolean {
  if (agent.enabled === false) return false;
  if (!agentHasConnectedTransport(agent)) return false;
  return isAgentRunnable(agent);
}
