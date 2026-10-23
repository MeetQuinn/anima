import { resolveAnimaHome } from "../anima-home.js";
import { AgentHealthEvidenceStore } from "./agent-health-evidence.store.js";
import { defaultAgentRegistryService } from "../agents/agent.service.js";
import { isAgentRunnable } from "../agents/agent-config-ops.js";
import { wakeQueueServiceForAgent } from "../inbox/wake-queue.service.js";
import type { AgentConfig } from "../../shared/agent-config.js";
import {
  isDeferredQueuedInboxItem,
  type InboxItem,
} from "../../shared/inbox.js";
import type {
  AgentStatusSummary,
  DeferredWakeSummary,
} from "../../shared/snapshot.js";
import { agentHasConnectedTransport } from "../../shared/agent-transports.js";
import { nowIso } from "../ids.js";
import {
  AgentHealthService,
  defaultAgentHealthService,
  sampleApiHealth,
  restartStatus,
} from "./agent-health.service.js";
import { defaultAgentRestartCommandStore } from "./agent-restart-command.store.js";
import { findActiveRuntimeItem } from "./active-item.js";
import { latestPrimaryRunningItem } from "./item-state.js";

export class RuntimeServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class RuntimeService {
  private readonly evidenceErrors = new Map<string, number>();
  constructor(
    private readonly health: AgentHealthService = defaultAgentHealthService,
  ) {}

  async listStatuses(): Promise<AgentStatusSummary[]> {
    const agents = await defaultAgentRegistryService.listAgentConfigs();
    return Promise.all(agents.map((agent) => this.statusForAgent(agent)));
  }

  async getStatus(agentId: string): Promise<AgentStatusSummary> {
    const agent = await defaultAgentRegistryService
      .serviceFor(agentId)
      .getConfig();
    return this.statusForAgent(agent);
  }

  async stopCurrentItem(agentId: string): Promise<void> {
    const queue = wakeQueueServiceForAgent(agentId);
    const running = latestPrimaryRunningItem(await queue.list());
    if (!running)
      throw new RuntimeServiceError(
        409,
        `No running item for agent ${agentId}`,
      );
    await queue.requestStop(running.id);
  }

  async restartAgent(agentId: string): Promise<{ requestId: string }> {
    const agent = await defaultAgentRegistryService
      .serviceFor(agentId)
      .getConfig()
      .catch(() => undefined);
    if (!agent) throw new RuntimeServiceError(404, "Agent not found");
    if (!agent.enabled)
      throw new RuntimeServiceError(
        409,
        "Agent is disabled. Enable it to run.",
      );
    const command = await defaultAgentRestartCommandStore.request(agentId);
    await this.health.writeHealth({
      agentId,
      reason: "restart_pending",
      restart: restartStatus(command, "pending", nowIso()),
      state: "starting",
      updatedAt: nowIso(),
    });
    return { requestId: command.requestId };
  }

  private async statusForAgent(
    agent: AgentConfig,
    confirmStale = true,
  ): Promise<AgentStatusSummary> {
    const queue = wakeQueueServiceForAgent(agent.id);
    const items = await queue.list();
    const running = latestPrimaryRunningItem(items);
    const active = running
      ? await findActiveRuntimeItem(agent.id, { list: async () => items })
      : undefined;
    const currentItemStartedAt =
      active?.startedAt ?? running?.handling.startedAt;
    const sample = await this.healthForAgent(agent, {
      ...(active ? { active } : {}),
      ...(running ? { runningItemId: running.id } : {}),
    });
    const health = sample?.health;
    // Queue and health are separate files. A completion between their reads
    // can pair an old running item with a new idle handle. Confirm once from
    // fresh samples; a persistent mismatch must still surface as unhealthy.
    if (confirmStale && health?.reason === "stale_running_item") {
      return this.statusForAgent(agent, false);
    }
    if (sample) {
      try {
        await new AgentHealthEvidenceStore(agent.id).observe(sample.evidence);
        this.evidenceErrors.delete(`${resolveAnimaHome()}:${agent.id}`);
      } catch {
        // Diagnostic storage must not hide the actual health result. Do not log
        // raw storage errors: schema errors can contain untrusted file contents.
        const key = `${resolveAnimaHome()}:${agent.id}`;
        const last = this.evidenceErrors.get(key);
        if (last === undefined || Date.now() - last >= 60_000) {
          this.evidenceErrors.set(key, Date.now());
          console.warn(
            `Agent ${agent.id}: health evidence could not be saved.`,
          );
        }
      }
    }
    const deferredWakes = deferredWakeSummaries(items);
    return {
      agentId: agent.id,
      ...(running ? { currentItemId: running.id } : {}),
      ...(currentItemStartedAt ? { currentItemStartedAt } : {}),
      ...(deferredWakes.length > 0 ? { deferredWakes } : {}),
      ...(health ? { health } : {}),
      queueDepth: items.filter((item) => item.handling.status === "queued")
        .length,
      itemCount: items.length,
    };
  }

  private async healthForAgent(
    agent: AgentConfig,
    queue: {
      active?: { startedAt?: string; workerId: string };
      runningItemId?: string;
    },
  ): Promise<ReturnType<typeof sampleApiHealth> | undefined> {
    if (!expectsRuntimeHealth(agent)) return undefined;
    return sampleApiHealth(await this.health.get(agent.id), queue, nowIso());
  }
}

export const defaultRuntimeService = new RuntimeService();

function expectsRuntimeHealth(agent: AgentConfig): boolean {
  if (agent.enabled === false) return false;
  if (!agentHasConnectedTransport(agent)) return false;
  return isAgentRunnable(agent);
}

function deferredWakeSummaries(items: InboxItem[]): DeferredWakeSummary[] {
  // Surface every deferred wake for the count; Retry now only for Slack
  // (`retryable`). Non-retryable kinds (e.g. reminder) must not get a button.
  return items
    .filter((item) => isDeferredQueuedInboxItem(item))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      notBefore: item.handling.notBefore!,
      retryable: item.kind === "slack",
      ...(item.handling.deferrals !== undefined
        ? { deferrals: item.handling.deferrals }
        : {}),
    }));
}
