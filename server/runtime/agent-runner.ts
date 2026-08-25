import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { errorMessage } from '../ids.js';
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
import { createFeishuMessageClient } from '../feishu/client.js';
import { createSlackWebClient } from '../slack/client.js';
import { postRuntimeFailureNotice } from './failure-notice.js';
import type { FeishuConfig } from '../../shared/agent-config.js';
import type { AgentRuntimeHandleSnapshot } from '../../shared/snapshot.js';
import { AgentRuntimeWorker, type AgentRuntimeWorkerCloseOptions } from './runtime-worker.js';
import type { RuntimeWorkerConfig } from './types.js';
import { agentTokenUsageServiceForAgent } from '../usage/agent-token-usage.service.js';
import { recordLifetimeTokenUsageForItem } from './usage.js';
import type { TeamRunLimiter } from './team-run-limiter.js';

interface RunningAgentOptions extends RuntimeWorkerConfig {
  agentRuntime: AgentRuntime;
  animaHome: string;
  appToken?: string;
  /** Synced Slack bot user id for mention routing (start-time authority). */
  botUserId?: string;
  botToken?: string;
  feishu?: FeishuConfig;
  idleTimeoutMs?: number;
  runLimiter: TeamRunLimiter;
  runtimeEnv: Record<string, string>;
  startAbortForceAfterMs?: number;
  startTimeoutMs?: number;
}

export interface RunningAgentHandle {
  health?(): AgentRuntimeHandleSnapshot;
  isActive?(): boolean;
  /** `undefined` = provider does not expose background-task quiescence. */
  isProviderQuiescent?(): boolean | undefined;
  /** While true, the worker claims no new items and does not append follow-ups. */
  setIntakePaused?(paused: boolean): void;
  stop(options?: AgentRuntimeWorkerCloseOptions): Promise<void>;
  waitForProviderQuiescent?(signal?: AbortSignal): Promise<void>;
}

export async function startRunningAgent(options: RunningAgentOptions): Promise<RunningAgentHandle> {
  await agentTokenUsageServiceForAgent(options.agentId).initialize();
  const queue = wakeQueueServiceForAgent(options.agentId);
  const reactionClient = options.botToken ? slackReactionClient(options.botToken) : undefined;
  const feishuMessageClient = options.feishu?.connected ? createFeishuMessageClient(options.feishu) : undefined;
  const feishuClient = feishuMessageClient && options.feishu
    ? feishuProcessingReactionClient(options.feishu, { client: feishuMessageClient })
    : undefined;
  const slackClient = options.botToken ? createSlackWebClient(options.botToken) : undefined;
  const worker = new AgentRuntimeWorker(
    {
      ...options,
      agentRuntime: options.agentRuntime,
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      onItemStarted: async (context) => {
        await addProcessingReaction({ context, logger: console, reactionClient });
        await addFeishuProcessingReaction({ context, feishuClient, logger: console });
      },
      onItemFailed: async (context, failure) => {
        await postRuntimeFailureNotice({
          agentId: context.agentId,
          failure,
          ...(feishuMessageClient ? { feishuClient: feishuMessageClient } : {}),
          item: context.item,
          logger: console,
          runtimeKind: options.agentRuntime.kind,
          ...(slackClient ? { slackClient } : {}),
        });
      },
      onItemSettled: async (context) => {
        // Keep the legacy lifetime diagnostic populated while the exact daily
        // ledger becomes the source for the new usage surfaces.
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
    },
    console,
    options.runLimiter,
  );
  const subscriber = new InboxSubscriber({
    agentRuntimeKind: options.agentRuntime.kind,
    animaHome: options.animaHome,
    ...(options.appToken ? { appToken: options.appToken } : {}),
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
    ...(options.botToken ? { botToken: options.botToken } : {}),
    ...(options.feishu ? { feishu: options.feishu } : {}),
    queue,
    runtimeEnv: options.runtimeEnv,
  });
  try {
    worker.start();
    await startSubscriberWithTimeout(subscriber, options.startTimeoutMs);
  } catch (error) {
    await Promise.allSettled([
      subscriber.stop(),
      worker.close({
        abortReason: 'operator_restart',
        ...(options.startAbortForceAfterMs !== undefined ? { forceAfterMs: options.startAbortForceAfterMs } : {}),
      }),
    ]);
    throw error;
  }
  return {
    health() {
      return worker.health();
    },
    isActive() {
      return worker.isActive();
    },
    isProviderQuiescent() {
      return worker.isProviderQuiescent();
    },
    setIntakePaused(paused: boolean) {
      worker.setIntakePaused(paused);
    },
    async stop(stopOptions: AgentRuntimeWorkerCloseOptions = {}) {
      await Promise.allSettled([
        subscriber.stop(),
        worker.close(stopOptions),
      ]);
    },
    waitForProviderQuiescent(signal?: AbortSignal) {
      return worker.waitForProviderQuiescent(signal);
    },
  };
}

async function startSubscriberWithTimeout(subscriber: InboxSubscriber, timeoutMs: number | undefined): Promise<void> {
  if (timeoutMs === undefined) {
    await subscriber.start();
    return;
  }
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const startPromise = subscriber.start();
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Inbox subscriber startup timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([startPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      void startPromise.catch((lateError: unknown) => {
        console.error(`Timed-out inbox subscriber startup later failed: ${errorMessage(lateError)}`);
      });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
