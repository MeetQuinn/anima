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
  mergeCursorDeliveryPlans,
  prepareCursorDelivery,
  primarySurfaceId,
  type CursorDeliveryPlan,
} from './cursor-delivery.js';
import type { SlackInboxItem } from '../../shared/inbox.js';

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

    // Merge Slack cursor plans by primary surface, unioning every exact child
    // surface (so two C1 roots keep both response-threads). Non-Slack units
    // pass through; bridge builds all prompts (async reminder context).
    const grouped = groupFollowupContexts(contexts);
    const followupInput = await input.runtimeBridge.followupInput({
      activeContext: input.activeContext,
      contexts: grouped.bridgeContexts,
      maxPromptBytes: FOLLOWUP_BATCH_MAX_PROMPT_BYTES,
    });

    // Expand selected lead ids to full group membership for mark/append.
    const selectedLeadIds = new Set(followupInput.itemIds);
    const itemIds: string[] = [];
    const contextsInBatch: RuntimeItemContext[] = [];
    const plansForSelected: CursorDeliveryPlan[] = [];
    for (const unit of grouped.units) {
      if (unit.kind === 'solo') {
        if (!selectedLeadIds.has(unit.context.item.id)) continue;
        itemIds.push(unit.context.item.id);
        contextsInBatch.push(unit.context);
        continue;
      }
      // Slack group: selected if lead is in the bridge batch.
      if (!selectedLeadIds.has(unit.lead.item.id)) continue;
      for (const context of unit.members) {
        itemIds.push(context.item.id);
        contextsInBatch.push(context);
      }
      plansForSelected.push(unit.mergedPlan);
    }

    const selectedSet = new Set(itemIds);
    const overflowIds = keep.map((c) => c.item.id).filter((id) => !selectedSet.has(id));
    if (overflowIds.length > 0) await input.queue.requeueBatch(overflowIds);
    contexts = contextsInBatch;
    failedItemIds = itemIds;
    if (itemIds.length === 0) return;
    const prompt = followupInput.prompt;

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

    // Commit each unique merged plan once. On failure: still mark appended
    // (provider already has the text) and surface a durable error — no requeue.
    let commitError: unknown;
    try {
      for (const plan of plansForSelected) {
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

type FollowupUnit =
  | { kind: 'solo'; context: RuntimeItemContext }
  | {
      kind: 'slack_group';
      lead: RuntimeItemContext;
      members: RuntimeItemContext[];
      mergedPlan: CursorDeliveryPlan;
    };

/**
 * Group Slack cursor contexts that share a primary surface. Merge every exact
 * surface across the group (channel + each response-thread) rather than picking
 * one whole plan. Bridge sees one lead context per group (one prompt); members
 * expand into append/mark item ids after selection.
 */
export function groupFollowupContexts(contexts: RuntimeItemContext[]): {
  bridgeContexts: RuntimeItemContext[];
  units: FollowupUnit[];
} {
  type Acc = { members: RuntimeItemContext[]; plans: CursorDeliveryPlan[] };
  const groups = new Map<string, Acc>();
  const units: FollowupUnit[] = [];
  const seenGroup = new Set<string>();

  for (const context of contexts) {
    const plan = context.cursorDelivery;
    if (!plan || context.item.kind !== 'slack') {
      units.push({ kind: 'solo', context });
      continue;
    }
    const key = primarySurfaceId(plan);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { members: [context], plans: [plan] });
      if (!seenGroup.has(key)) {
        seenGroup.add(key);
        // Placeholder; filled below once all members known.
        units.push({
          kind: 'slack_group',
          lead: context,
          members: [],
          mergedPlan: plan,
        });
      }
      continue;
    }
    existing.members.push(context);
    existing.plans.push(plan);
  }

  // Finalize slack groups in unit order.
  const bridgeContexts: RuntimeItemContext[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i]!;
    if (unit.kind === 'solo') {
      bridgeContexts.push(unit.context);
      continue;
    }
    const key = primarySurfaceId(unit.mergedPlan);
    const acc = groups.get(key)!;
    const triggerItem = acc.members[acc.members.length - 1]!.item as SlackInboxItem;
    const mergedPlan = mergeCursorDeliveryPlans(acc.plans, triggerItem);
    const lead: RuntimeItemContext = {
      ...acc.members[0]!,
      cursorDelivery: mergedPlan,
    };
    units[i] = {
      kind: 'slack_group',
      lead,
      members: acc.members,
      mergedPlan,
    };
    bridgeContexts.push(lead);
  }

  return { bridgeContexts, units };
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
