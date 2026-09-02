import type { InboxItem, SlackInboxItem } from '../../shared/inbox.js';
import { isDeferredQueuedInboxItem } from '../../shared/inbox.js';
import { makeId } from '../ids.js';
import { observeSlackWakeInJournal } from '../runtime/cursor-wake-journal-backfill.js';
import { wakeQueueServiceForAgent } from './wake-queue.service.js';

export type DeferredWakeRetryConflictReason =
  | 'gone'
  | 'not_deferred'
  | 'not_found'
  | 'race'
  | 'unsupported_kind';

export type DeferredWakeRetryResult =
  | { kind: 'retried'; previousItemId: string; retryItemId: string }
  | { kind: 'conflict'; reason: DeferredWakeRetryConflictReason };

/**
 * Operator Retry-now for a rate-limit-deferred wake.
 *
 * Clears the parked item so its notBefore cannot fire later, and enqueues a
 * unique Slack wake that keeps the original channel/message/thread anchors
 * with `resumeReason: deferred_retry` so cursor already_delivered does not
 * swallow the turn.
 */
export async function retryDeferredWakeNow(
  agentId: string,
  itemId: string,
): Promise<DeferredWakeRetryResult> {
  const queue = wakeQueueServiceForAgent(agentId);
  const current = await queue.find(itemId);
  if (!current) {
    // Settled/known id (seen marker or message ledger) → gone (HTTP 409).
    // Never-known id → not_found (HTTP 404). Sequential double-clicks land here.
    if (await queue.hasSeen(itemId)) {
      return { kind: 'conflict', reason: 'gone' };
    }
    return { kind: 'conflict', reason: 'not_found' };
  }
  if (current.kind !== 'slack') return { kind: 'conflict', reason: 'unsupported_kind' };
  if (current.handling.workerId) return { kind: 'conflict', reason: 'race' };
  if (!isDeferredQueuedInboxItem(current)) return { kind: 'conflict', reason: 'not_deferred' };

  const outcome = await queue.swapDeferredForRetry(itemId, (previous, now) => {
    if (previous.kind !== 'slack') {
      // Pre-checked; keep the builder total for the store callback.
      throw new Error(`unexpected deferred retry kind ${previous.kind}`);
    }
    return buildSlackDeferredRetryItem(previous, now);
  });

  if (outcome.kind !== 'ok') {
    // We already observed the deferred Slack row; a store `not_found` here is a
    // lost CAS (parallel Retry now / external settle), not a true unknown id.
    if (outcome.kind === 'not_found') {
      return { kind: 'conflict', reason: 'gone' };
    }
    return { kind: 'conflict', reason: outcome.kind };
  }

  // Journal must still resolve the original messageTs (already observed on the
  // first attempt). Re-observe fail-soft so prepare cannot miss the trigger.
  if (outcome.retry.kind === 'slack') {
    await observeSlackWakeInJournal({ agentId, item: outcome.retry });
  }

  return {
    kind: 'retried',
    previousItemId: outcome.previous.id,
    retryItemId: outcome.retry.id,
  };
}

function buildSlackDeferredRetryItem(previous: SlackInboxItem, now: string): SlackInboxItem {
  return {
    ...previous,
    handling: {
      createdAt: now,
      queuedAt: now,
      resumeReason: 'deferred_retry',
      status: 'queued',
      updatedAt: now,
    },
    id: makeId('slack-deferred-retry'),
    receivedAt: now,
  };
}

/** Test helper: build the retry item shape without touching the queue. */
export function buildSlackDeferredRetryItemForTests(
  previous: SlackInboxItem,
  now: string,
): InboxItem {
  return buildSlackDeferredRetryItem(previous, now);
}
