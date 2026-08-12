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
import { readRestartDrainActive } from './intake-gate.js';
import type { RuntimeItemContext, RuntimeWorkerConfig } from './types.js';
import {
  commitCursorDelivery,
  prepareCursorDelivery,
  primarySurfaceId,
  type CursorDeliveryPlan,
} from './cursor-delivery.js';
import { buildCodeAgentDeliveryPrompt } from './delivery-prompt.js';

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

/**
 * Await drain only. Caller must sync-read pause in the same continuation and
 * act (append/requeue/sleep) without an intermediate await of a boolean helper.
 */
async function probeRestartDrain(input: RuntimeFollowupAppenderInput): Promise<boolean> {
  return readRestartDrainActive(input.isRestartDrainActive);
}

function isPaused(input: RuntimeFollowupAppenderInput): boolean {
  return input.isIntakePaused?.() === true;
}

export async function appendQueuedFollowupsUntilFinished(input: RuntimeFollowupAppenderInput): Promise<void> {
  const skippedItemIds = new Set<string>();
  while (!input.itemDone.aborted) {
    const drainActive = await probeRestartDrain(input);
    if (isPaused(input) || drainActive) {
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

    // Fail-closed after claim: drain probe, sync pause, requeue or continue —
    // no await between pause read and the branch that skips append.
    const drainAfterClaim = await probeRestartDrain(input);
    if (isPaused(input) || drainAfterClaim) {
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
  /** True only after appendToActiveRun accepted — never requeue after that. */
  let accepted = false;
  try {
    contexts = await Promise.all(claimedItemIds.map(
      (itemId) => runtimeContextForItemId(itemId, input.runtimeConfig, input.queue),
    ));
    // Prepare cursor plans (flag-off → disabled). Commit only after accept.
    const keep: RuntimeItemContext[] = [];
    for (const context of contexts) {
      const prepared = await prepareCursorDelivery({
        agentId: input.runtimeConfig.agentId,
        item: context.item,
      });
      if (prepared.kind === 'already_delivered') {
        await input.queue.complete(context.item.id).catch(() => undefined);
        continue;
      }
      if (prepared.kind === 'failed') {
        skippedItemIds.add(context.item.id);
        await input.queue.requeueBatch([context.item.id]);
        continue;
      }
      if (prepared.kind === 'prepared') {
        context.cursorDelivery = prepared.plan;
      }
      keep.push(context);
    }
    contexts = keep;
    if (contexts.length === 0) return;

    const drainAfterContext = await probeRestartDrain(input);
    if (isPaused(input) || drainAfterContext) {
      await input.queue.requeueBatch(contexts.map((c) => c.item.id));
      return;
    }

    // Gate-off / no cursor plans: preserve the original bridge path (reminder
    // context loading, size limits). Gate-on: group by surface.
    let itemIds: string[];
    let prompt: string;
    let plansToCommit: CursorDeliveryPlan[] = [];
    const anyCursor = contexts.some((c) => c.cursorDelivery);
    if (!anyCursor) {
      const followupInput = await input.runtimeBridge.followupInput({
        activeContext: input.activeContext,
        contexts,
        maxPromptBytes: FOLLOWUP_BATCH_MAX_PROMPT_BYTES,
      });
      contexts = contexts.slice(0, followupInput.itemIds.length);
      const overflowIds = keep.map((c) => c.item.id).slice(contexts.length);
      if (overflowIds.length > 0) await input.queue.requeueBatch(overflowIds);
      itemIds = followupInput.itemIds;
      prompt = followupInput.prompt;
      failedItemIds = itemIds;
    } else {
      const built = buildFollowupBatch(contexts, FOLLOWUP_BATCH_MAX_PROMPT_BYTES);
      if (built.itemIds.length === 0) {
        await input.queue.requeueBatch(keep.map((c) => c.item.id));
        return;
      }
      contexts = built.contextsInBatch;
      failedItemIds = built.itemIds;
      itemIds = built.itemIds;
      prompt = built.prompt;
      plansToCommit = built.plansToCommit;
      const inBatch = new Set(itemIds);
      const overflow = keep.map((c) => c.item.id).filter((id) => !inBatch.has(id));
      if (overflow.length > 0) await input.queue.requeueBatch(overflow);
    }

    // Pre-append: drain probe, sync pause, then appendToActiveRun starts in this
    // same continuation (no await of a helper that already sampled pause).
    const drainBeforeAppend = await probeRestartDrain(input);
    if (isPaused(input) || drainBeforeAppend) {
      await input.queue.requeueBatch(failedItemIds);
      return;
    }

    const result = await input.agentRuntime.appendToActiveRun({
      activeItemId: input.activeContext.item.id,
      itemIds,
      prompt,
    });
    if (!result.accepted) {
      // Rejected: do not advance cursors or coalesce.
      await input.queue.requeueBatch(itemIds);
      if (result.retryable) {
        await sleep(FOLLOWUP_POLL_MS, input.itemDone);
        return;
      }
      for (const itemId of itemIds) skippedItemIds.add(itemId);
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

    // Irreversible accept: never requeue from here, even if commit fails.
    accepted = true;

    // Commit each unique surface plan once. On failure: still mark appended
    // (provider already has the text) and surface a durable error — no requeue.
    let commitError: unknown;
    try {
      for (const plan of plansToCommit) {
        await commitCursorDelivery({
          plan,
          queue: input.queue,
          excludeItemIds: itemIds,
        });
      }
    } catch (error) {
      commitError = error;
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
      itemIds,
      parentItemId: input.activeContext.item.id,
      workerId: input.workerId,
    });
    await Promise.all(contexts.map((context) => input.onFollowupAppended(context, result.text)));
    input.logger.log(JSON.stringify({
      activeItemId: input.activeContext.item.id,
      agentRuntime: input.agentRuntime.kind,
      event: 'runtime.followup_appended',
      itemIds,
      text: result.text,
      workerId: input.workerId,
    }, null, 2));

    if (commitError) {
      await recordRuntimeFollowupFailed(
        { agentId: input.runtimeConfig.agentId },
        {
          activeItemId: input.activeContext.item.id,
          agentRuntime: input.agentRuntime.kind,
          error: errorMessage(commitError),
          reason: 'followup_commit_failed',
        },
      );
      input.logger.error(
        `Cursor commit after follow-up accept failed for items ${itemIds.join(', ')}: ${errorMessage(commitError)}`,
      );
    }
  } catch (error) {
    // After accept, provider already has the text — do not requeue (duplicate path).
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

/**
 * Build one prompt per unique cursor surface (plus one per non-cursor item).
 * Same-surface wakes share a single snapshot so the provider does not see
 * duplicated conversation deltas. Stops adding units once maxPromptBytes is hit
 * (same contract as AgentRuntimeBridge.followupInput).
 */
function buildFollowupBatch(
  contexts: RuntimeItemContext[],
  maxPromptBytes: number,
): {
  itemIds: string[];
  prompt: string;
  plansToCommit: CursorDeliveryPlan[];
  contextsInBatch: RuntimeItemContext[];
} {
  type SurfaceGroup = {
    plan: CursorDeliveryPlan;
    contexts: RuntimeItemContext[];
  };
  const bySurface = new Map<string, SurfaceGroup>();
  const nonCursor: RuntimeItemContext[] = [];
  // Preserve claim order for size-limit batching (FIFO units).
  const unitOrder: Array<{ kind: 'surface'; key: string } | { kind: 'item'; context: RuntimeItemContext }> = [];

  for (const context of contexts) {
    const plan = context.cursorDelivery;
    if (!plan) {
      nonCursor.push(context);
      unitOrder.push({ kind: 'item', context });
      continue;
    }
    const key = primarySurfaceId(plan);
    const existing = bySurface.get(key);
    if (!existing) {
      bySurface.set(key, { plan, contexts: [context] });
      unitOrder.push({ kind: 'surface', key });
      continue;
    }
    existing.contexts.push(context);
    const existingTail = Math.max(...existing.plan.surfaces.map((s) => s.nextDeliveredOrdinal));
    const nextTail = Math.max(...plan.surfaces.map((s) => s.nextDeliveredOrdinal));
    if (nextTail >= existingTail) existing.plan = plan;
  }

  const prompts: string[] = [];
  const itemIds: string[] = [];
  const plansToCommit: CursorDeliveryPlan[] = [];
  const contextsInBatch: RuntimeItemContext[] = [];
  let promptBytes = 0;

  const tryAdd = (prompt: string, add: () => void): boolean => {
    const separator = prompts.length > 0 ? '\n\n' : '';
    const candidateBytes = promptBytes + Buffer.byteLength(`${separator}${prompt}`, 'utf8');
    if (prompts.length > 0 && candidateBytes > maxPromptBytes) return false;
    prompts.push(prompt);
    promptBytes = candidateBytes;
    add();
    return true;
  };

  for (const unit of unitOrder) {
    if (unit.kind === 'surface') {
      const group = bySurface.get(unit.key)!;
      const prompt = buildCodeAgentDeliveryPrompt(group.contexts[0]!.item, {
        cursorDeliveryPromptBody: group.plan.promptBody,
      });
      const ok = tryAdd(prompt, () => {
        for (const context of group.contexts) {
          itemIds.push(context.item.id);
          contextsInBatch.push(context);
        }
        plansToCommit.push(group.plan);
      });
      if (!ok) break;
      continue;
    }
    const prompt = buildCodeAgentDeliveryPrompt(unit.context.item);
    const ok = tryAdd(prompt, () => {
      itemIds.push(unit.context.item.id);
      contextsInBatch.push(unit.context);
    });
    if (!ok) break;
  }

  return {
    itemIds,
    prompt: prompts.join('\n\n'),
    plansToCommit,
    contextsInBatch,
  };
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
