import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { WakeQueueService, type InboxItem } from '../inbox/wake-queue.service.js';
import type { AgentStatusSummary } from '../../shared/snapshot.js';
import { defaultAgentRestartCommandStore } from './agent-restart-command.store.js';
import { findActiveRuntimeItem } from './active-item.js';

export class RuntimeServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class RuntimeService {
  async listStatuses(): Promise<AgentStatusSummary[]> {
    const agents = await defaultAgentRegistryService.listAgentConfigs();
    return Promise.all(agents.map((agent) => this.statusForAgent(agent.id)));
  }

  async getStatus(agentId: string): Promise<AgentStatusSummary> {
    return this.statusForAgent(agentId);
  }

  async stopCurrentItem(agentId: string): Promise<void> {
    const queue = new WakeQueueService(agentId);
    const running = latestRunningItem(await queue.listRunnable());
    if (!running) throw new RuntimeServiceError(409, `No running item for agent ${agentId}`);
    await queue.requestStop(running.id);
  }

  async restartAgent(agentId: string): Promise<{ requestId: string }> {
    const agent = await defaultAgentRegistryService.serviceFor(agentId).getConfig().catch(() => undefined);
    if (!agent) throw new RuntimeServiceError(404, 'Agent not found');
    if (!agent.enabled) throw new RuntimeServiceError(409, 'Agent is disabled. Enable it to run.');
    const command = await defaultAgentRestartCommandStore.request(agentId);
    return { requestId: command.requestId };
  }

  private async statusForAgent(agentId: string): Promise<AgentStatusSummary> {
    const queue = new WakeQueueService(agentId);
    const items = await queue.listRunnable();
    const running = latestRunningItem(items);
    const active = running ? await findActiveRuntimeItem(agentId) : undefined;
    const currentItemStartedAt = active?.startedAt ?? running?.handling.startedAt;
    return {
      agentId,
      ...(running ? { currentItemId: running.id } : {}),
      ...(currentItemStartedAt ? { currentItemStartedAt } : {}),
      queueDepth: items.filter((item) => item.handling.status === 'queued').length,
      itemCount: items.length,
    };
  }
}

export const defaultRuntimeService = new RuntimeService();

function latestRunningItem(items: InboxItem[]): InboxItem | undefined {
  return items
    .filter((item) => item.handling.status === 'running')
    .sort((a, b) => {
      const aTime = a.handling.startedAt ?? a.handling.updatedAt;
      const bTime = b.handling.startedAt ?? b.handling.updatedAt;
      return bTime.localeCompare(aTime);
    })[0];
}
