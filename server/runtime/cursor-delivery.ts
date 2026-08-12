// Cut (b): cursor delivery + same-surface queue coalescing (flag off by default).
//
// One service prepares a consistent observed snapshot + commit plan at claim/start,
// then commits once at the provider-neutral runtime.started seam (idempotent on
// retry). Queue settle is CAS-after-cursor: only still-queued Slack wakes on the
// exact same surface whose observed ordinals are ≤ the captured tail.

import { slackMessageEventId, slackSurfaceId } from '../ids.js';
import type { WakeQueueService } from '../inbox/wake-queue.service.js';
import {
  conversationThreadTs,
  observedConversationStoreForAgent,
  surfaceIdForObservation,
  type AdvanceCursorExpected,
  type ObservedConversationEntry,
  type ObservedConversationStore,
} from '../storage/schema/observed-conversation.store.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import type { InboxItem, SlackInboxItem } from '../../shared/inbox.js';
import { isClaimableQueuedInboxItem } from '../../shared/inbox.js';
import { envelopeTime, renderEnvelope } from '../messages/envelope.js';
import { slackDisplayLabel } from '../slack/slack.helper.js';

/** Newest-fitting bound: max messages in a delivered snapshot. */
export const CURSOR_DELIVERY_MAX_MESSAGES = 20;
/** Newest-fitting bound: max rendered UTF-8 bytes across snapshot lines. */
export const CURSOR_DELIVERY_MAX_BYTES = 16 * 1024;
/** Soft per-message clip so one row cannot consume the whole budget alone. */
export const CURSOR_DELIVERY_MAX_MESSAGE_CHARS = 2_000;

export type CursorDeliveryFailureReason =
  | 'continuity_degraded'
  | 'missing_trigger_observation'
  | 'store_error'
  | 'cas_failure';

export class CursorDeliveryError extends Error {
  readonly reason: CursorDeliveryFailureReason;
  constructor(reason: CursorDeliveryFailureReason, message: string) {
    super(message);
    this.name = 'CursorDeliveryError';
    this.reason = reason;
  }
}

export interface SurfaceDeliveryPlan {
  surfaceId: string;
  /** What getCursor must match for CAS (absent or present@N). */
  cursorExpected: AdvanceCursorExpected;
  /** Inclusive ordinal to advance to (0 allowed for empty child-thread establish). */
  nextDeliveredOrdinal: number;
  lastDeliveredEventId?: string;
  lastDeliveredMessageTs?: string;
  /** Bounded journal rows delivered for this surface (chronological). */
  entries: ObservedConversationEntry[];
  /** Count of candidate rows after cursor not included due to the bound. */
  omittedCount: number;
  /** True when establishing present@0 with no journal rows. */
  establishOnly: boolean;
}

export interface CursorDeliveryPlan {
  agentId: string;
  triggerItemId: string;
  triggerEventId: string;
  surfaces: SurfaceDeliveryPlan[];
  /** Prompt body for the Slack wake (includes bounded context + latest wake). */
  promptBody: string;
  committed: boolean;
}

export type PrepareCursorDeliveryResult =
  | { kind: 'disabled' }
  | { kind: 'already_delivered'; settledItemIds: string[] }
  | { kind: 'prepared'; plan: CursorDeliveryPlan }
  | { kind: 'failed'; error: CursorDeliveryError };

/** Test override: undefined = read server config (default off). */
let enabledOverride: boolean | undefined;

export function setCursorDeliveryEnabledForTests(enabled: boolean | undefined): void {
  enabledOverride = enabled;
}

export async function isCursorDeliveryEnabled(): Promise<boolean> {
  if (enabledOverride !== undefined) return enabledOverride;
  try {
    const config = await defaultServerSettingsService.readConfig();
    return config.cursorDelivery?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Surfaces to snapshot for a Slack wake.
 * - Top-level channel: channel surface + response-thread surface (thread:messageTs).
 * - Thread reply: thread surface only.
 * - DM: DM surface only.
 */
export function surfacesForSlackWake(item: SlackInboxItem): string[] {
  const threadTs = conversationThreadTs({
    messageTs: item.messageTs,
    threadTs: item.threadTs,
  });
  if (threadTs) {
    // Thread reply: only the thread surface.
    return [
      slackSurfaceId({
        teamId: item.teamId,
        channelId: item.channelId,
        threadTs,
      }),
    ];
  }
  // Top-level (channel or DM root).
  const primary = slackSurfaceId({
    teamId: item.teamId,
    channelId: item.channelId,
  });
  // DMs have no child response-thread surface.
  if (item.channelId.startsWith('D')) return [primary];
  // Channel parent: also snapshot/establish the response-thread surface so the
  // first threaded reply does not bypass the later hold (counting example).
  const responseThread = slackSurfaceId({
    teamId: item.teamId,
    channelId: item.channelId,
    threadTs: item.messageTs,
  });
  return [primary, responseThread];
}

export function triggerEventId(item: SlackInboxItem): string {
  return slackMessageEventId(item.teamId, item.channelId, item.messageTs);
}

/**
 * Prepare at claim/start. Does not advance cursors or settle queue.
 * When the trigger is already covered by the primary surface cursor, returns
 * already_delivered so the worker can settle without a provider turn.
 */
export async function prepareCursorDelivery(input: {
  agentId: string;
  item: InboxItem;
  store?: ObservedConversationStore;
}): Promise<PrepareCursorDeliveryResult> {
  if (!(await isCursorDeliveryEnabled())) return { kind: 'disabled' };
  if (input.item.kind !== 'slack') return { kind: 'disabled' };
  const item = input.item;
  const store = input.store ?? observedConversationStoreForAgent(input.agentId);

  try {
    const continuity = await store.getContinuity();
    if (continuity.status === 'degraded') {
      return {
        kind: 'failed',
        error: new CursorDeliveryError(
          'continuity_degraded',
          `observation continuity is degraded for agent=${input.agentId}`,
        ),
      };
    }

    const eventId = triggerEventId(item);
    const surfaceIds = surfacesForSlackWake(item);

    // Locate trigger observation on its natural surface (primary for top-level /
    // DM; thread surface for replies).
    const triggerSurfaceId = surfaceIdForObservation({
      teamId: item.teamId,
      channelId: item.channelId,
      messageTs: item.messageTs,
      threadTs: item.threadTs,
    });
    const triggerEntry = await findObservationByEventId(store, triggerSurfaceId, eventId);
    if (!triggerEntry) {
      return {
        kind: 'failed',
        error: new CursorDeliveryError(
          'missing_trigger_observation',
          `trigger ${eventId} not found in observed journal for ${triggerSurfaceId}`,
        ),
      };
    }

    // Recovery: trigger already covered by cursor → settle without provider.
    // Never skip a runtime_restart primary — that is interrupted work, not a
    // coalesced duplicate wake. Cursor coverage may skip later queued wakes only.
    const primaryCursor = await store.getCursor(triggerSurfaceId);
    if (
      item.handling.resumeReason !== 'runtime_restart'
      && primaryCursor.status === 'present'
      && primaryCursor.deliveredOrdinal >= triggerEntry.ordinal
    ) {
      return { kind: 'already_delivered', settledItemIds: [item.id] };
    }

    const surfaces: SurfaceDeliveryPlan[] = [];
    for (const surfaceId of surfaceIds) {
      const plan = await buildSurfacePlan(store, surfaceId, {
        triggerEventId: eventId,
        triggerOrdinal: surfaceId === triggerSurfaceId ? triggerEntry.ordinal : undefined,
        isResponseThreadEstablish: surfaceId !== triggerSurfaceId,
      });
      surfaces.push(plan);
    }

    const promptBody = renderCursorDeliveryPrompt(item, surfaces);
    return {
      kind: 'prepared',
      plan: {
        agentId: input.agentId,
        triggerItemId: item.id,
        triggerEventId: eventId,
        surfaces,
        promptBody,
        committed: false,
      },
    };
  } catch (error) {
    if (error instanceof CursorDeliveryError) {
      return { kind: 'failed', error };
    }
    return {
      kind: 'failed',
      error: new CursorDeliveryError(
        'store_error',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

/**
 * Commit at runtime.started (or after follow-up accept).
 *
 * Idempotent only when live cursor is already at/past the plan target
 * (`current >= target`). Any other expectation mismatch is fail-closed —
 * never rewrite the prepared CAS expectation to the live cursor.
 */
export async function commitCursorDelivery(input: {
  plan: CursorDeliveryPlan;
  queue: WakeQueueService;
  /** Active/trigger item must not be settled by coalesce. */
  excludeItemIds?: Iterable<string>;
  store?: ObservedConversationStore;
}): Promise<{ advanced: string[]; coalescedItemIds: string[] }> {
  const plan = input.plan;
  if (plan.committed) {
    return { advanced: [], coalescedItemIds: [] };
  }
  const store = input.store ?? observedConversationStoreForAgent(plan.agentId);
  const advanced: string[] = [];

  for (const surface of plan.surfaces) {
    const current = await store.getCursor(surface.surfaceId);
    // Idempotent success: already at/past target (retry after partial commit).
    if (
      current.status === 'present'
      && current.deliveredOrdinal >= surface.nextDeliveredOrdinal
    ) {
      continue;
    }

    // Strict CAS: prepared expectation must still match. Stale plans fail closed.
    if (!cursorExpectationMatches(current, surface.cursorExpected)) {
      throw new CursorDeliveryError(
        'cas_failure',
        `stale cursor plan for ${surface.surfaceId}: expected ${JSON.stringify(surface.cursorExpected)}, live ${JSON.stringify(current)}`,
      );
    }

    const result = await store.advanceCursor({
      surfaceId: surface.surfaceId,
      expected: surface.cursorExpected,
      nextDeliveredOrdinal: surface.nextDeliveredOrdinal,
      ...(surface.lastDeliveredEventId
        ? { lastDeliveredEventId: surface.lastDeliveredEventId }
        : {}),
      ...(surface.lastDeliveredMessageTs
        ? { lastDeliveredMessageTs: surface.lastDeliveredMessageTs }
        : {}),
    });

    if (!result.advanced) {
      // Concurrent commit may have landed the same target after our read.
      const again = await store.getCursor(surface.surfaceId);
      if (
        again.status === 'present'
        && again.deliveredOrdinal >= surface.nextDeliveredOrdinal
      ) {
        continue;
      }
      throw new CursorDeliveryError(
        'cas_failure',
        `cursor advance failed for ${surface.surfaceId}: ${result.reason}`,
      );
    }
    advanced.push(surface.surfaceId);
  }

  const coalescedItemIds = await coalesceCoveredWakes({
    agentId: plan.agentId,
    queue: input.queue,
    surfaces: plan.surfaces,
    excludeItemIds: new Set([plan.triggerItemId, ...(input.excludeItemIds ?? [])]),
    store,
  });

  plan.committed = true;
  return { advanced, coalescedItemIds };
}

/**
 * Settle still-queued Slack wakes on the same exact surface whose observed
 * ordinals are within the captured tail. Never touches the active item, other
 * surfaces, later-than-tail rows, staged rows, or non-Slack items.
 *
 * Candidate selection is read-side; the settle is one atomic queue-store batch
 * so the selected set moves to seen together.
 */
export async function coalesceCoveredWakes(input: {
  agentId: string;
  queue: WakeQueueService;
  surfaces: SurfaceDeliveryPlan[];
  excludeItemIds: Set<string>;
  store?: ObservedConversationStore;
}): Promise<string[]> {
  const store = input.store ?? observedConversationStoreForAgent(input.agentId);
  const surfaceTails = new Map(
    input.surfaces.map((s) => [s.surfaceId, s.nextDeliveredOrdinal] as const),
  );
  const items = await input.queue.list();
  const candidateIds: string[] = [];

  for (const item of items) {
    if (input.excludeItemIds.has(item.id)) continue;
    if (!isClaimableQueuedInboxItem(item)) continue; // staged / non-queued out
    if (item.kind !== 'slack') continue;

    const surfaceId = surfaceIdForObservation({
      teamId: item.teamId,
      channelId: item.channelId,
      messageTs: item.messageTs,
      threadTs: item.threadTs,
    });
    const tail = surfaceTails.get(surfaceId);
    if (tail === undefined) continue; // other surface

    const eventId = triggerEventId(item);
    const entry = await findObservationByEventId(store, surfaceId, eventId);
    if (!entry) continue;
    if (entry.ordinal > tail) continue; // later than captured tail

    candidateIds.push(item.id);
  }
  if (candidateIds.length === 0) return [];
  const settled = await input.queue.withdrawQueuedBatch(candidateIds);
  return settled.map((item) => item.id);
}

// --- internals ---

async function buildSurfacePlan(
  store: ObservedConversationStore,
  surfaceId: string,
  opts: {
    triggerEventId: string;
    triggerOrdinal?: number;
    isResponseThreadEstablish: boolean;
  },
): Promise<SurfaceDeliveryPlan> {
  const cursor = await store.getCursor(surfaceId);
  const cursorExpected: AdvanceCursorExpected =
    cursor.status === 'absent'
      ? { status: 'absent' }
      : { status: 'present', deliveredOrdinal: cursor.deliveredOrdinal };

  const afterOrdinal =
    cursor.status === 'present' ? cursor.deliveredOrdinal : 0;
  // Read a generous window; bound selection is separate.
  const all = await store.readJournal(surfaceId, { afterOrdinal, limit: 5_000 });

  // Response-thread with no rows yet: establish present@0 only.
  if (opts.isResponseThreadEstablish && all.length === 0) {
    return {
      surfaceId,
      cursorExpected,
      nextDeliveredOrdinal: 0,
      entries: [],
      omittedCount: 0,
      establishOnly: true,
    };
  }

  const bounded = selectNewestFitting(all, {
    maxMessages: CURSOR_DELIVERY_MAX_MESSAGES,
    maxBytes: CURSOR_DELIVERY_MAX_BYTES,
    mustIncludeEventId: opts.triggerOrdinal !== undefined ? opts.triggerEventId : undefined,
  });

  const last = bounded.entries[bounded.entries.length - 1];
  const nextDeliveredOrdinal = last
    ? last.ordinal
    : cursor.status === 'present'
      ? cursor.deliveredOrdinal
      : 0;

  return {
    surfaceId,
    cursorExpected,
    nextDeliveredOrdinal,
    ...(last
      ? { lastDeliveredEventId: last.eventId, lastDeliveredMessageTs: last.messageTs }
      : {}),
    entries: bounded.entries,
    omittedCount: bounded.omittedCount,
    establishOnly: false,
  };
}

/**
 * Newest-fitting selection: walk from newest backward until message/byte caps,
 * then return chronological. Ensures mustIncludeEventId stays in the window.
 */
export function selectNewestFitting(
  candidates: ObservedConversationEntry[],
  options: {
    maxMessages: number;
    maxBytes: number;
    mustIncludeEventId?: string;
  },
): { entries: ObservedConversationEntry[]; omittedCount: number } {
  if (candidates.length === 0) return { entries: [], omittedCount: 0 };

  const selected: ObservedConversationEntry[] = [];
  let bytes = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const row = candidates[i]!;
    const line = formatObservedLine(row);
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
    if (selected.length >= options.maxMessages) break;
    if (selected.length > 0 && bytes + lineBytes > options.maxBytes) break;
    // Single oversized first line: clip rather than skip.
    if (selected.length === 0 && lineBytes > options.maxBytes) {
      selected.push(row);
      bytes = options.maxBytes;
      break;
    }
    selected.push(row);
    bytes += lineBytes;
  }
  selected.reverse();

  // Ensure trigger is retained even after a long delay filled the window with
  // newer rows: re-window from the trigger forward (newest-fitting among the
  // suffix that includes the trigger).
  if (options.mustIncludeEventId) {
    const has = selected.some((r) => r.eventId === options.mustIncludeEventId);
    if (!has) {
      const trigger = candidates.find((r) => r.eventId === options.mustIncludeEventId);
      if (trigger) {
        const fromTrigger = candidates.filter((r) => r.ordinal >= trigger.ordinal);
        const rewindowed = selectNewestFitting(fromTrigger, {
          maxMessages: options.maxMessages,
          maxBytes: options.maxBytes,
        });
        // Guaranteed to include trigger (it is the oldest of fromTrigger; if the
        // window is all newer and over budget, force-prepend trigger).
        if (!rewindowed.entries.some((r) => r.eventId === options.mustIncludeEventId)) {
          const rest = rewindowed.entries.slice(-(options.maxMessages - 1));
          const forced = [trigger, ...rest.filter((r) => r.eventId !== trigger.eventId)];
          return {
            entries: forced,
            omittedCount: Math.max(0, candidates.length - forced.length),
          };
        }
        return {
          entries: rewindowed.entries,
          omittedCount: Math.max(0, candidates.length - rewindowed.entries.length),
        };
      }
    }
  }

  const omittedCount = Math.max(0, candidates.length - selected.length);
  return { entries: selected, omittedCount };
}

export function formatObservedLine(entry: ObservedConversationEntry): string {
  const actor = entry.userId
    ? slackDisplayLabel({ userId: entry.userId })
    : entry.botId
      ? `bot:${entry.botId}`
      : 'unknown';
  let text = entry.text;
  if (!text && entry.files?.length) {
    text = entry.files.map((f) => f.name ?? f.id).join(', ');
    text = text ? `[file: ${text}]` : '[file]';
  }
  if (text.length > CURSOR_DELIVERY_MAX_MESSAGE_CHARS) {
    text = `${text.slice(0, CURSOR_DELIVERY_MAX_MESSAGE_CHARS)}…`;
  }
  const env = renderEnvelope([
    { key: 'message_ts', value: entry.messageTs },
    { key: 'time', value: envelopeTime(entry.receivedAt) },
    { key: 'user_id', value: entry.userId },
    { key: 'bot_id', value: entry.botId },
    { key: 'ordinal', value: entry.ordinal },
  ]);
  return `${env} ${actor}: ${text}`;
}

export function renderCursorDeliveryPrompt(
  trigger: SlackInboxItem,
  surfaces: SurfaceDeliveryPlan[],
): string {
  // Render every surface that has rows (including child response-threads) so
  // cursor advance never covers content absent from the prompt.
  const parts: string[] = ['Slack conversation update:'];
  let anyContext = false;
  for (const surface of surfaces) {
    if (surface.establishOnly || surface.entries.length === 0) continue;
    anyContext = true;
    const isThread = surface.surfaceId.includes(':thread:');
    parts.push('', isThread ? `Thread ${surface.surfaceId}:` : `Channel ${surface.surfaceId}:`);
    for (const entry of surface.entries) {
      parts.push(formatObservedLine(entry));
    }
    if (surface.omittedCount > 0) {
      parts.push(
        `(${surface.omittedCount} earlier message${surface.omittedCount === 1 ? '' : 's'} not shown)`,
      );
    }
  }
  if (!anyContext) {
    parts.push('', '(no prior observed messages in window)');
  }

  const latest = buildLatestWakeLine(trigger);
  parts.push('', 'Latest wake:', latest);
  if (trigger.attentionSuggestion) {
    parts.push('', trigger.attentionSuggestion);
  }
  return parts.join('\n');
}

/** Primary surface id for a plan (grouping key for follow-up batching). */
export function primarySurfaceId(plan: CursorDeliveryPlan): string {
  return plan.surfaces[0]?.surfaceId ?? plan.triggerEventId;
}

function buildLatestWakeLine(event: SlackInboxItem): string {
  const actor = slackDisplayLabel({
    displayName: event.actor?.displayName ?? event.actor?.realName,
    handle: event.actor?.handle,
    userId: event.actor?.userId,
  });
  const env = renderEnvelope([
    { key: 'channel_id', value: event.channelId },
    { key: 'thread_ts', value: event.threadTs },
    { key: 'message_ts', value: event.messageTs },
    { key: 'wake', value: event.wakeReason },
    { key: 'time', value: envelopeTime(event.receivedAt) },
    { key: 'user_id', value: event.actor?.userId },
  ]);
  let text = event.text;
  if (!text && event.files?.length) {
    text = `[file: ${event.files.map((f) => f.name).join(', ')}]`;
  }
  return `${env} ${actor}: ${text}`;
}

async function findObservationByEventId(
  store: ObservedConversationStore,
  surfaceId: string,
  eventId: string,
): Promise<ObservedConversationEntry | undefined> {
  // Tail window covers normal traffic; for deep history read more.
  const recent = await store.readTail(surfaceId, 2_000);
  const hit = recent.find((row) => row.eventId === eventId);
  if (hit) return hit;
  const all = await store.readJournal(surfaceId, { limit: 10_000 });
  return all.find((row) => row.eventId === eventId);
}

function cursorExpectationMatches(
  view: { status: 'absent' } | { status: 'present'; deliveredOrdinal: number },
  expected: AdvanceCursorExpected,
): boolean {
  if (expected.status === 'absent') return view.status === 'absent';
  return view.status === 'present' && view.deliveredOrdinal === expected.deliveredOrdinal;
}
