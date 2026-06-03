import { errorMessage } from '../ids.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { InboxSubscriber } from '../inbox/subscriber.js';
import {
  addFeishuProcessingReaction,
  addProcessingReaction,
  feishuProcessingReactionClient,
  removeFeishuProcessingReaction,
  removeProcessingReactions,
  slackReactionClient,
} from './processing-reactions.js';
import type { AgentRuntime } from '../providers/contract.js';
import type { FeishuConfig } from '../../shared/agent-config.js';
import { AgentRuntimeWorker, type AgentRuntimeWorkerCloseOptions } from './runtime-worker.js';
import type { RuntimeWorkerConfig } from './types.js';
import { recordLifetimeTokenUsageForItem } from './usage.js';

interface RunningAgentOptions extends RuntimeWorkerConfig {
  agentRuntime: AgentRuntime;
  appToken?: string;
  botToken?: string;
  feishu?: FeishuConfig;
  idleTimeoutMs?: number;
}

export interface RunningAgentHandle {
  isActive?(): boolean;
  stop(options?: AgentRuntimeWorkerCloseOptions): Promise<void>;
}

export async function startRunningAgent(options: RunningAgentOptions): Promise<RunningAgentHandle> {
  const queue = new WakeQueueService(options.agentId);
  const reactionClient = options.botToken ? slackReactionClient(options.botToken) : undefined;
  const feishuClient = options.feishu?.connected ? feishuProcessingReactionClient(options.feishu) : undefined;
  const worker = new AgentRuntimeWorker({
    ...options,
    agentRuntime: options.agentRuntime,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    onItemStarted: async (context) => {
      await addProcessingReaction({ context, logger: console, reactionClient });
      await addFeishuProcessingReaction({ context, feishuClient, logger: console });
    },
    onItemSettled: async (context) => {
      await recordLifetimeTokenUsageForItem(context.agentId, context.item.id).catch((error: unknown) => {
        console.error(`Lifetime token usage update failed for item ${context.item.id}: ${errorMessage(error)}`);
      });
      await removeProcessingReactions({ context, logger: console, reactionClient });
      await removeFeishuProcessingReaction({ context, feishuClient, logger: console });
    },
    onItemFollowupAppended: async (_activeContext, context) => {
      await addProcessingReaction({ context, logger: console, reactionClient });
      await addFeishuProcessingReaction({ context, feishuClient, logger: console });
    },
    queue,
  });
  const subscriber = new InboxSubscriber({
    agentRuntimeKind: options.agentRuntime.kind,
    ...(options.appToken ? { appToken: options.appToken } : {}),
    ...(options.botToken ? { botToken: options.botToken } : {}),
    ...(options.feishu ? { feishu: options.feishu } : {}),
    queue,
  });
  try {
    worker.start();
    await subscriber.start();
  } catch (error) {
    await Promise.allSettled([subscriber.stop(), worker.close()]);
    throw error;
  }
  return {
    isActive() {
      return worker.isActive();
    },
    async stop(stopOptions: AgentRuntimeWorkerCloseOptions = {}) {
      await Promise.allSettled([
        subscriber.stop(),
        worker.close(stopOptions),
      ]);
    },
  };
}
