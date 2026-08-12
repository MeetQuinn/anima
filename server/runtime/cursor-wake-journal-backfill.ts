// Pre-drain migration + shared observe helper for Slack wakes.
//
// Cursor-delivery prepare is fail-closed on missing_trigger_observation. Quiet
// requeue clears resumeReason, so that field is not a durable discriminator —
// every Slack queue producer must journal before claim, and startup/pre-drain
// backfill covers genuinely pre-journal active wakes (upgrade recovery).
//
// Ordering for backfill: surfaceId, then Slack messageTs, then item id —
// deterministic conversation order so empty journals receive chronological
// ordinals.
//
// Actorless wakes (e.g. Slack shortcut source messages that omit message.user)
// use a stable synthetic botId for observation when no actor.userId is present.

import type { InboxItem, SlackInboxItem, SlackFileMeta } from '../../shared/inbox.js';
import { WakeQueueService, wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { errorMessage, slackMessageEventId } from '../ids.js';
import {
  observedConversationStoreForAgent,
  surfaceIdForObservation,
  type ObserveSlackMessageInput,
  type ObserveSlackMessageResult,
  type ObservedConversationStore,
  type ObservedFileDescriptor,
} from '../storage/schema/observed-conversation.store.js';

/**
 * Stable observation actor when a Slack wake has no userId (shortcut handoffs
 * over source messages that omit message.user). Must stay constant so dedupe
 * and prepare lookups remain stable across restart.
 */
export const ACTORLESS_SLACK_WAKE_BOT_ID = 'B_ANIMA_SHORTCUT';

export interface CursorWakeJournalBackfillResult {
  appended: number;
  examined: number;
  failed: number;
  skipped: number;
}

export interface CursorWakeJournalBackfillInput {
  agentId: string;
  logger?: Pick<Console, 'error' | 'log'>;
  queue?: WakeQueueService;
  store?: ObservedConversationStore;
}

/**
 * List active Slack wakes and ensure each is present in the observed journal
 * via the normal deduped `store.observe` path. Safe to call every drain;
 * already-journaled wakes are no-ops.
 */
export async function backfillActiveSlackWakeJournal(
  input: CursorWakeJournalBackfillInput,
): Promise<CursorWakeJournalBackfillResult> {
  const queue = input.queue ?? wakeQueueServiceForAgent(input.agentId);
  const store = input.store ?? observedConversationStoreForAgent(input.agentId);
  const logger = input.logger ?? console;

  const items = await queue.list();
  const slackWakes = items
    .filter((item): item is SlackInboxItem => item.kind === 'slack')
    .slice()
    .sort(compareSlackWakesForBackfill);

  let appended = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of slackWakes) {
    try {
      const result = await observeSlackWakeInJournal({
        agentId: input.agentId,
        item,
        store,
        throwOnError: true,
      });
      if (!result) {
        failed += 1;
        continue;
      }
      if (result.appended) appended += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        `cursor-wake journal backfill failed agent=${input.agentId} item=${item.id}: ${errorMessage(error)}`,
      );
    }
  }

  if (appended > 0 || failed > 0) {
    logger.log(
      `cursor-wake journal backfill agent=${input.agentId}: `
        + `examined=${slackWakes.length} appended=${appended} skipped=${skipped} failed=${failed}`,
    );
  }

  return {
    examined: slackWakes.length,
    appended,
    skipped,
    failed,
  };
}

/**
 * Journal one Slack wake through the normal deduped observation store.
 * Used by producers (shortcut handoff) and by pre-drain backfill.
 */
export async function observeSlackWakeInJournal(input: {
  agentId: string;
  item: SlackInboxItem;
  store?: ObservedConversationStore;
  throwOnError?: boolean;
}): Promise<ObserveSlackMessageResult | undefined> {
  const observeInput = observeInputFromSlackWake(input.item);
  const store = input.store ?? observedConversationStoreForAgent(input.agentId);
  try {
    return await store.observe(observeInput);
  } catch (error) {
    if (input.throwOnError) throw error;
    console.warn(
      `observed-conversation journal write failed for agent=${input.agentId} `
        + `wake=${input.item.id}: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/** Deterministic conversation order for journal ordinal assignment. */
export function compareSlackWakesForBackfill(a: SlackInboxItem, b: SlackInboxItem): number {
  const surfaceA = surfaceIdForObservation({
    channelId: a.channelId,
    messageTs: a.messageTs,
    teamId: a.teamId,
    threadTs: a.threadTs,
  });
  const surfaceB = surfaceIdForObservation({
    channelId: b.channelId,
    messageTs: b.messageTs,
    teamId: b.teamId,
    threadTs: b.threadTs,
  });
  const bySurface = surfaceA.localeCompare(surfaceB);
  if (bySurface !== 0) return bySurface;
  const byTs = a.messageTs.localeCompare(b.messageTs);
  if (byTs !== 0) return byTs;
  return a.id.localeCompare(b.id);
}

/**
 * Build observe input from a queued Slack wake. Prefer actor.userId; when
 * absent (legal for some shortcut source messages), use a stable botId so
 * observation and prepare can still complete.
 */
export function observeInputFromSlackWake(item: SlackInboxItem): ObserveSlackMessageInput {
  const userId = item.actor?.userId?.trim();
  const files = observedFilesFromInbox(item.files);
  const input: ObserveSlackMessageInput = {
    channelId: item.channelId,
    messageTs: item.messageTs,
    teamId: item.teamId,
    text: item.text,
    ...(userId ? { userId } : { botId: ACTORLESS_SLACK_WAKE_BOT_ID }),
  };
  if (item.threadTs) input.threadTs = item.threadTs;
  if (item.receivedAt) input.receivedAt = item.receivedAt;
  if (files.length > 0) input.files = files;
  return input;
}

export function eventIdForSlackWake(item: SlackInboxItem): string {
  return slackMessageEventId(item.teamId, item.channelId, item.messageTs);
}

function observedFilesFromInbox(files: SlackFileMeta[] | undefined): ObservedFileDescriptor[] {
  if (!Array.isArray(files) || files.length === 0) return [];
  const out: ObservedFileDescriptor[] = [];
  for (const file of files) {
    if (!file || typeof file.id !== 'string' || file.id.trim().length === 0) continue;
    const descriptor: ObservedFileDescriptor = { id: file.id };
    if (typeof file.name === 'string' && file.name.length > 0) descriptor.name = file.name;
    if (typeof file.mimetype === 'string' && file.mimetype.length > 0) {
      descriptor.mimetype = file.mimetype;
    }
    out.push(descriptor);
  }
  return out;
}

/** Active queue rows only (queued/running); settled items are not listed. */
export function isActiveSlackWake(item: InboxItem): item is SlackInboxItem {
  return item.kind === 'slack';
}
