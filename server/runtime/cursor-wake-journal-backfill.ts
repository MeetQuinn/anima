// Pre-drain migration: backfill the per-agent observed-conversation journal for
// active Slack wakes that predate the journal (upgrade / restart recovery).
//
// Cursor-delivery prepare is fail-closed on missing_trigger_observation. Quiet
// requeue clears resumeReason, so that field is not a durable discriminator —
// the durable fix is to plant missing journal rows through the normal deduped
// observe path before any worker drain claims a wake.
//
// Ordering: surfaceId, then Slack messageTs, then item id — deterministic
// conversation order so empty journals receive ordinals matching chronology.

import type { InboxItem, SlackInboxItem, SlackFileMeta } from '../../shared/inbox.js';
import { WakeQueueService, wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { errorMessage, slackMessageEventId } from '../ids.js';
import {
  observedConversationStoreForAgent,
  surfaceIdForObservation,
  type ObserveSlackMessageInput,
  type ObservedConversationStore,
  type ObservedFileDescriptor,
} from '../storage/schema/observed-conversation.store.js';

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
 * via the normal deduped `store.observe` path. Safe to call every start;
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
    const observeInput = observeInputFromSlackWake(item);
    if (!observeInput) {
      failed += 1;
      logger.error(
        `cursor-wake journal backfill skipped agent=${input.agentId} item=${item.id}: `
          + 'missing actor userId (observe requires userId and/or botId)',
      );
      continue;
    }
    try {
      const result = await store.observe(observeInput);
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

export function observeInputFromSlackWake(item: SlackInboxItem): ObserveSlackMessageInput | undefined {
  const userId = item.actor?.userId?.trim();
  if (!userId) return undefined;

  const files = observedFilesFromInbox(item.files);
  const input: ObserveSlackMessageInput = {
    channelId: item.channelId,
    messageTs: item.messageTs,
    teamId: item.teamId,
    text: item.text,
    userId,
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
