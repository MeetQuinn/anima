import { errorMessage } from '../ids.js';
import type { WakeQueueService } from '../inbox/wake-queue.service.js';
import {
  recordRuntimeFollowupAppended,
  recordRuntimeFollowupFailed,
  recordRuntimePending,
} from './activity.js';
import { runtimeContextForItemId } from './context.js';
import type { AgentRuntime } from '../providers/contract.js';
import type { AgentRuntimeBridge } from './runtime-bridge.js';
import { isIntakeBlocked } from './intake-gate.js';
import type { RuntimeItemContext, RuntimeWorkerConfig } from './types.js';

const FOLLOWUP_POLL_MS = 100;
export const FOLLOWUP_BATCH_MAX_ITEMS = 16;
export const FOLLOWUP_BATCH_MAX_PROMPT_BYTES = 64 * 1024;

interface RuntimeFollowupAppenderInput {
  activeContext: RuntimeItemContext;
  agentRuntime: AgentRuntime;
  /** When true, leave follow-ups queued for a post-reload runtime (config pending). */
  isIntakePaused?: () => boolean;
  /** Test seam: inject a deferred restart-drain probe. */
  isRestartDrainActive?: () => Promise<boolean>;
  itemDone: AbortSignal;
  logger: Pick<Console, 'error' | 'log'>;
  onFollowupAccepted: () => void;
  onFollowupAppended: (context: RuntimeItemContext, text: string | undefined) => Promise<void>;
  onFollowupSettled: (context: RuntimeItemContext) => Promise<void>;
  queue: WakeQueueService;
  runtimeBridge: AgentRuntimeBridge;
  runtimeConfig: RuntimeWorkerConfig;
  workerId: string;
}

function followupIntakeBlocked(input: RuntimeFollowupAppenderInput): Promise<boolean> {
  return isIntakeBlocked({
    isPaused: () => input.isIntakePaused?.() === true,
    ...(input.isRestartDrainActive ? { isRestartDrainActive: input.isRestartDrainActive } : {}),
  });
}

export async function appendQueuedFollowupsUntilFinished(input: RuntimeFollowupAppenderInput): Promise<void> {
  const skippedItemIds = new Set<string>();
  while (!input.itemDone.aborted) {
    if (await followupIntakeBlocked(input)) {
      await sleep(FOLLOWUP_POLL_MS, input.itemDone);
      continue;
    }
    const items = await input.queue.takeFollowupBatch({
      activeItemId: input.activeContext.item.id,
      excludedItemIds: skippedItemIds,
      limit: FOLLOWUP_BATCH_MAX_ITEMS,
      workerId: input.workerId,
    });
    if (items.length === 0) {
      await sleep(FOLLOWUP_POLL_MS, input.itemDone);
      continue;
    }

    // Fail-closed: pause may flip while takeFollowupBatch awaits. Drain probe
    // first, then sync pause re-read; requeue claimed batch if blocked.
    if (await followupIntakeBlocked(input)) {
      await input.queue.requeueBatch(items.map((item) => item.id));
      await sleep(FOLLOWUP_POLL_MS, input.itemDone);
      continue;
    }

    const eligible = items.filter((item) => item.kind !== 'memory_coherence');
    const excluded = items.filter((item) => item.kind === 'memory_coherence');
    for (const item of excluded) skippedItemIds.add(item.id);
    if (excluded.length > 0) await input.queue.requeueBatch(excluded.map((item) => item.id));
    if (eligible.length === 0) {
      await sleep(FOLLOWUP_POLL_MS, input.itemDone);
      continue;
    }
    await tryFollowupBatch(input, eligible.map((item) => item.id), skippedItemIds);
  }
}

async function tryFollowupBatch(
  input: RuntimeFollowupAppenderInput,
  claimedItemIds: string[],
  skippedItemIds: Set<string>,
): Promise<void> {
  let contexts: RuntimeItemContext[] = [];
  let failedItemIds = claimedItemIds;
  let accepted = false;
  try {
    contexts = await Promise.all(claimedItemIds.map(
      (itemId) => runtimeContextForItemId(itemId, input.runtimeConfig, input.queue),
    ));
    // Pause may flip during context load — drain then sync pause re-read.
    if (await followupIntakeBlocked(input)) {
      await input.queue.requeueBatch(claimedItemIds);
      return;
    }
    const followupInput = await input.runtimeBridge.followupInput({
      activeContext: input.activeContext,
      contexts,
      maxPromptBytes: FOLLOWUP_BATCH_MAX_PROMPT_BYTES,
    });
    contexts = contexts.slice(0, followupInput.itemIds.length);
    const overflowIds = claimedItemIds.slice(contexts.length);
    if (overflowIds.length > 0) await input.queue.requeueBatch(overflowIds);
    failedItemIds = followupInput.itemIds;

    // Pre-append: drain probe then sync pause; no await until append starts.
    if (await followupIntakeBlocked(input)) {
      await input.queue.requeueBatch(failedItemIds);
      return;
    }

    const result = await input.agentRuntime.appendToActiveRun(followupInput);
    if (!result.accepted) {
      await input.queue.requeueBatch(contexts.map((context) => context.item.id));
      if (result.retryable) {
        await sleep(FOLLOWUP_POLL_MS, input.itemDone);
        return;
      }
      for (const context of contexts) skippedItemIds.add(context.item.id);
      await recordRuntimePending(
        { agentId: input.runtimeConfig.agentId },
        {
          activeItemId: input.activeContext.item.id,
          agentRuntime: input.agentRuntime.kind,
          reason: 'followup_rejected',
        },
      );
      await sleep(FOLLOWUP_POLL_MS, input.itemDone);
      return;
    }

    await recordRuntimeFollowupAppended(
      { agentId: input.runtimeConfig.agentId },
      {
        activeItemId: input.activeContext.item.id,
        agentRuntime: input.agentRuntime.kind,
        text: result.text,
      },
    );
    input.onFollowupAccepted();
    await input.queue.markAppendedBatch({
      itemIds: contexts.map((context) => context.item.id),
      parentItemId: input.activeContext.item.id,
      workerId: input.workerId,
    });
    accepted = true;
    await Promise.all(contexts.map((context) => input.onFollowupAppended(context, result.text)));
    input.logger.log(JSON.stringify({
      activeItemId: input.activeContext.item.id,
      agentRuntime: input.agentRuntime.kind,
      event: 'runtime.followup_appended',
      itemIds: contexts.map((context) => context.item.id),
      text: result.text,
      workerId: input.workerId,
    }, null, 2));
  } catch (error) {
    if (!accepted) await input.queue.requeueBatch(failedItemIds);
    for (const itemId of failedItemIds) skippedItemIds.add(itemId);
    await recordRuntimeFollowupFailed(
      { agentId: input.runtimeConfig.agentId },
      {
        activeItemId: input.activeContext.item.id,
        agentRuntime: input.agentRuntime.kind,
        error: errorMessage(error),
        reason: 'followup_failed',
      },
    );
    input.logger.error(
      `Runtime worker follow-up append failed for items ${failedItemIds.join(', ')}: ${errorMessage(error)}`,
    );
    await sleep(FOLLOWUP_POLL_MS, input.itemDone);
  } finally {
    if (!accepted) {
      for (const context of contexts) {
        const current = await input.queue.find(context.item.id).catch(() => undefined);
        if (current?.handling.status === 'completed' || current?.handling.status === 'failed') {
          await input.onFollowupSettled(context);
        }
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
