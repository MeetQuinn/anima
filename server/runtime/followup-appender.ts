import { errorMessage } from '../ids.js';
import type { WakeQueueService } from '../inbox/wake-queue.service.js';
import { isRestartDrainActive } from '../services/restart-drain.js';
import type { InboxItem } from '../../shared/inbox.js';
import {
  recordRuntimeFollowupAppended,
  recordRuntimeFollowupFailed,
  recordRuntimePending,
} from './activity.js';
import { runtimeContextForItemId } from './context.js';
import type { AgentRuntime } from '../providers/contract.js';
import type { AgentRuntimeBridge } from './runtime-bridge.js';
import type { RuntimeItemContext, RuntimeWorkerConfig } from './types.js';

const FOLLOWUP_POLL_MS = 100;

type RuntimeFollowupDecision =
  | { status: 'appended'; text?: string }
  | { status: 'rejected' }
  | { error: string; status: 'failed' };

interface RuntimeFollowupAppenderInput {
  activeContext: RuntimeItemContext;
  agentRuntime: AgentRuntime;
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

export async function appendQueuedFollowupsUntilFinished(input: RuntimeFollowupAppenderInput): Promise<void> {
  const skippedItemIds = new Set<string>();
  while (!input.itemDone.aborted) {
    if (await isRestartDrainActive()) {
      await sleep(FOLLOWUP_POLL_MS, input.itemDone);
      continue;
    }
    const item = await input.queue.claimNextFollowup({
      activeItemId: input.activeContext.item.id,
      excludedItemIds: skippedItemIds,
      workerId: input.workerId,
    });
    if (!item) {
      await sleep(FOLLOWUP_POLL_MS, input.itemDone);
      continue;
    }
    if (item.kind === 'memory_coherence') {
      skippedItemIds.add(item.id);
      await input.queue.requeue(item.id);
      await sleep(FOLLOWUP_POLL_MS, input.itemDone);
      continue;
    }
    await tryOneFollowupItem(input, item, skippedItemIds);
  }
}

async function tryOneFollowupItem(
  input: RuntimeFollowupAppenderInput,
  item: InboxItem,
  skippedItemIds: Set<string>,
): Promise<void> {
  let appended = false;
  let context: RuntimeItemContext | undefined;
  try {
    context = await runtimeContextForItemId(item.id, input.runtimeConfig, input.queue);
    const followup = await appendRuntimeFollowup({
      activeContext: input.activeContext,
      agentRuntime: input.agentRuntime,
      context,
      runtimeBridge: input.runtimeBridge,
    });
    if (followup.status === 'appended') {
      await recordFollowupAppendSuccess(input, context, followup.text);
      appended = true;
      return;
    }
    await recordFollowupAppendSkip(input, item, followup);
    skippedItemIds.add(item.id);
    await input.queue.requeue(item.id);
    await sleep(FOLLOWUP_POLL_MS, input.itemDone);
  } catch (error) {
    skippedItemIds.add(item.id);
    await input.queue.requeue(item.id);
    await recordRuntimeFollowupFailed(
      { agentId: input.runtimeConfig.agentId },
      {
        activeItemId: input.activeContext.item.id,
        agentRuntime: input.agentRuntime.kind,
        error: errorMessage(error),
        reason: 'followup_failed',
      },
    );
    input.logger.error(`Runtime worker follow-up append failed for item ${item.id}: ${errorMessage(error)}`);
    await sleep(FOLLOWUP_POLL_MS, input.itemDone);
  } finally {
    const current = context && !appended ? await input.queue.find(context.item.id).catch(() => undefined) : undefined;
    if (context && (current?.handling.status === 'completed' || current?.handling.status === 'failed')) {
      await input.onFollowupSettled(context);
    }
  }
}

async function recordFollowupAppendSuccess(
  input: RuntimeFollowupAppenderInput,
  context: RuntimeItemContext,
  text: string | undefined,
): Promise<void> {
  input.onFollowupAccepted();
  await input.queue.markAppended({
    itemId: context.item.id,
    parentItemId: input.activeContext.item.id,
    workerId: input.workerId,
  });
  await input.onFollowupAppended(context, text);
  input.logger.log(JSON.stringify({
    activeItemId: input.activeContext.item.id,
    agentRuntime: input.agentRuntime.kind,
    event: 'runtime.followup_appended',
    itemId: context.item.id,
    text,
    workerId: input.workerId,
  }, null, 2));
}

async function recordFollowupAppendSkip(
  input: RuntimeFollowupAppenderInput,
  item: InboxItem,
  followup: RuntimeFollowupDecision,
): Promise<void> {
  if (followup.status === 'rejected') {
    await recordRuntimePending(
      { agentId: input.runtimeConfig.agentId },
      {
        activeItemId: input.activeContext.item.id,
        agentRuntime: input.agentRuntime.kind,
        reason: 'followup_rejected',
      },
    );
  }
  if (followup.status === 'failed') {
    input.logger.error(`Runtime worker follow-up append failed for item ${item.id}: ${followup.error}`);
  }
}

async function appendRuntimeFollowup(input: {
  activeContext: RuntimeItemContext;
  agentRuntime: AgentRuntime;
  context: RuntimeItemContext;
  runtimeBridge: AgentRuntimeBridge;
}): Promise<RuntimeFollowupDecision> {
  try {
    const result = await input.agentRuntime.appendToActiveRun(await input.runtimeBridge.followupInput({
      activeContext: input.activeContext,
      context: input.context,
    }));
    if (!result.accepted) return { status: 'rejected' };
    await recordRuntimeFollowupAppended(
      { agentId: input.context.agentId },
      {
        activeItemId: input.activeContext.item.id,
        agentRuntime: input.agentRuntime.kind,
        text: result.text,
      },
    );
    return { status: 'appended', text: result.text };
  } catch (error) {
    const message = errorMessage(error);
    await recordRuntimeFollowupFailed(
      { agentId: input.context.agentId },
      {
        activeItemId: input.activeContext.item.id,
        agentRuntime: input.agentRuntime.kind,
        error: message,
        reason: 'followup_failed',
      },
    );
    return { error: message, status: 'failed' };
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
