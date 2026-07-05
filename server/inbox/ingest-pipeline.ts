import type { AttentionSuggestionPayload } from '../../shared/activity.js';
import { WakeReason, type InboxItem } from '../../shared/inbox.js';
import {
  recordAttentionSuggestionActivity,
} from './attention-suggestion-activity.js';
import type { WakeQueueEnqueueResult, WakeQueueService } from './wake-queue.service.js';

export interface IngestRuntimeDecision {
  attentionSuggestion?: string;
  reason: string;
  shouldStartRuntime: boolean;
}

export type IngestSurfaceLogInput<Item extends InboxItem, Decision extends IngestRuntimeDecision> =
  | { decision: Decision; outcome: 'ignored' }
  | { decision: Decision; outcome: 'enqueued'; result: WakeQueueEnqueueResult & { item: Item } };

export interface RunIngestPipelineHooks<Item extends InboxItem, Decision extends IngestRuntimeDecision> {
  agentId: string;
  attentionSuggestionPayload?(item: Item, suggestion: string): AttentionSuggestionPayload;
  decide(input: { duplicate: boolean }): Promise<Decision>;
  enrich(input: { decision: Decision }): Promise<Item>;
  itemId: string;
  onAfterAttentionSuggestion?(input: {
    decision: Decision;
    item: Item;
    result: WakeQueueEnqueueResult & { item: Item };
  }): void;
  onAfterEnqueue?(input: {
    decision: Decision;
    item: Item;
    result: WakeQueueEnqueueResult & { item: Item };
  }): void;
  queue: Pick<WakeQueueService, 'enqueue' | 'hasSeen'>;
  surfaceLog(input: IngestSurfaceLogInput<Item, Decision>): object;
}

export async function runIngestPipeline<Item extends InboxItem, Decision extends IngestRuntimeDecision>(
  hooks: RunIngestPipelineHooks<Item, Decision>,
): Promise<void> {
  const duplicate = Boolean(await hooks.queue.hasSeen(hooks.itemId));
  const decision = await hooks.decide({ duplicate });
  if (!decision.shouldStartRuntime) {
    console.log(JSON.stringify(hooks.surfaceLog({ decision, outcome: 'ignored' }), null, 2));
    return;
  }

  const enriched = await hooks.enrich({ decision });
  const suggested = withAttentionSuggestion(enriched, decision.attentionSuggestion);
  const item = withWakeReason(suggested, decision.reason);
  const result = await hooks.queue.enqueue(item) as WakeQueueEnqueueResult & { item: Item };

  hooks.onAfterEnqueue?.({ decision, item, result });
  if (decision.attentionSuggestion && !result.duplicate && hooks.attentionSuggestionPayload) {
    await recordAttentionSuggestionActivity(
      hooks.agentId,
      hooks.attentionSuggestionPayload(item, decision.attentionSuggestion),
    );
  }
  hooks.onAfterAttentionSuggestion?.({ decision, item, result });
  console.log(JSON.stringify(hooks.surfaceLog({ decision, outcome: 'enqueued', result }), null, 2));
}

function withAttentionSuggestion<Item extends InboxItem>(item: Item, suggestion: string | undefined): Item {
  if (!suggestion) return item;
  return { ...item, attentionSuggestion: suggestion } as Item;
}

function withWakeReason<Item extends InboxItem>(item: Item, reason: string): Item {
  const parsed = WakeReason.safeParse(reason);
  return parsed.success ? { ...item, wakeReason: parsed.data } as Item : item;
}
