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
import { renderSlackCursorExtras } from './delivery-prompt.js';
import { ACTORLESS_SLACK_WAKE_BOT_ID } from './cursor-wake-journal-backfill.js';
import {
  exactEarlierMessagesMarker,
  observedSenderLabel,
  truncatedMarkerSuffix,
} from './send-hold-copy.js';

/** Newest-fitting bound: max messages in the final provider-facing envelope. */
export const CURSOR_DELIVERY_MAX_MESSAGES = 20;
/**
 * Max UTF-8 bytes of the final provider-facing rendered envelope (PRD / Iris):
 * snapshot rows + Latest wake + previews + file metadata — everything the
 * agent turn receives from the cursor view.
 */
export const CURSOR_DELIVERY_MAX_BYTES = 16 * 1024;
/**
 * Per-message clip in UTF-8 bytes, applied to snapshot rows and to the trigger
 * text in Latest wake. The trigger appears in both places, so two clipped copies
 * plus envelope overhead must still fit CURSOR_DELIVERY_MAX_BYTES; extras
 * (previews/files) are shrunk against the remainder. Bytes, not characters,
 * because the envelope budget is a prompt-size bound.
 */
export const CURSOR_DELIVERY_MAX_MESSAGE_BYTES = 6_000;

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
  /**
   * Exact after-cursor population from the reconciled ordinal index
   * (`tailOrdinal − deliveredOrdinal`), not the capped retained journal-read
   * length. Used for “N earlier messages not shown” and merge union so archive
   * retention / read limits cannot under-count the true conversation.
   */
  candidateCount: number;
  /** Count of this surface's candidates not included due to the bound. */
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

/**
 * Resolve whether cursor delivery + send hold are on.
 * Default on (enable cut); explicit `cursorDelivery.enabled: false` opts out.
 * Settings/read failures are errors (fail-closed), not silent disable —
 * "enabled but unreadable" must not look like intentional off.
 */
export async function resolveCursorDeliveryEnabled(): Promise<
  | { kind: 'enabled' }
  | { kind: 'disabled' }
  | { kind: 'error'; error: CursorDeliveryError }
> {
  if (enabledOverride !== undefined) {
    return enabledOverride ? { kind: 'enabled' } : { kind: 'disabled' };
  }
  try {
    const config = await defaultServerSettingsService.readConfig();
    // Default on: only explicit false disables.
    return config.cursorDelivery?.enabled === false
      ? { kind: 'disabled' }
      : { kind: 'enabled' };
  } catch (error) {
    return {
      kind: 'error',
      error: new CursorDeliveryError(
        'store_error',
        `cursorDelivery settings unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
}

/** Convenience: true unless explicitly disabled (throws on settings error). */
export async function isCursorDeliveryEnabled(): Promise<boolean> {
  const resolved = await resolveCursorDeliveryEnabled();
  if (resolved.kind === 'error') throw resolved.error;
  return resolved.kind === 'enabled';
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
  // Slack-only: non-Slack wakes never consult cursor settings (a corrupt
  // config must not quiet-requeue reminder/choice/Feishu indefinitely).
  if (input.item.kind !== 'slack') return { kind: 'disabled' };

  const enabled = await resolveCursorDeliveryEnabled();
  if (enabled.kind === 'disabled') return { kind: 'disabled' };
  if (enabled.kind === 'error') return { kind: 'failed', error: enabled.error };
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
    // Fail-closed first: cursor past the reconciled journal tail is corruption /
    // partial restore — must not silently swallow reused ordinals as delivered.
    const primaryCursor = await store.getCursor(triggerSurfaceId);
    if (primaryCursor.status === 'present') {
      const primaryIndex = await store.getIndexReconciled(triggerSurfaceId);
      const reconciledTail = primaryIndex?.tailOrdinal ?? 0;
      if (primaryCursor.deliveredOrdinal > reconciledTail) {
        return {
          kind: 'failed',
          error: new CursorDeliveryError(
            'store_error',
            `cursor deliveredOrdinal ${primaryCursor.deliveredOrdinal} beyond reconciled tail ${reconciledTail} on ${triggerSurfaceId}`,
          ),
        };
      }
      if (
        item.handling.resumeReason !== 'runtime_restart'
        && primaryCursor.deliveredOrdinal >= triggerEntry.ordinal
      ) {
        return { kind: 'already_delivered', settledItemIds: [item.id] };
      }
    }

    // Clip previews/files so extras alone cannot blow the 16 KiB envelope.
    // Selection then budgets rows against the remaining capacity.
    const triggerForEnvelope = clipTriggerExtrasForEnvelope(item);

    // Build raw per-surface candidates, then allocate ONE shared 20/16KiB budget
    // for the final provider-facing envelope (rows + Latest wake + previews/files).
    // nextDeliveredOrdinal is computed only from rows that survive that budget —
    // never truncate the rendered evidence after choosing the advance.
    const surfaces = await buildSharedBudgetSurfacePlans(store, surfaceIds, {
      triggerEventId: eventId,
      triggerSurfaceId,
      triggerOrdinal: triggerEntry.ordinal,
      triggerItem: triggerForEnvelope,
    });

    const promptBody = renderCursorDeliveryEnvelope(triggerForEnvelope, surfaces);
    if (Buffer.byteLength(promptBody, 'utf8') > CURSOR_DELIVERY_MAX_BYTES) {
      // Pathological: should not happen after envelope-aware selection + clip.
      return {
        kind: 'failed',
        error: new CursorDeliveryError(
          'store_error',
          `cursor envelope exceeds ${CURSOR_DELIVERY_MAX_BYTES} bytes after budgeting`,
        ),
      };
    }
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

interface SurfaceCandidates {
  surfaceId: string;
  cursorExpected: AdvanceCursorExpected;
  cursorDeliveredOrdinal: number; // 0 if absent
  isResponseThreadEstablish: boolean;
  /** Rows available for selection (may be a shown subset after merge). */
  candidates: ObservedConversationEntry[];
  /**
   * Exact after-cursor population (index-derived). Defaults to candidates.length
   * only when unset (merge re-window always sets this from source plans).
   */
  candidateCount?: number;
}

/**
 * Exact after-cursor count from a captured reconciled ordinal tail, not
 * retained-window length. Fail-closed when the index cannot support the claim
 * (missing index with retained rows, tail behind retained max, retained longer
 * than the ordinal span, or captured tail row absent from the journal window).
 *
 * `candidates` must already be filtered through the same captured tail
 * (`afterOrdinal < ordinal <= tail`).
 */
export function exactCandidateCountFromIndex(input: {
  afterOrdinal: number;
  candidates: ObservedConversationEntry[];
  /** Captured reconciled journal-tail index; undefined when empty / unknown. */
  index: { tailOrdinal: number; lastEventId?: string } | undefined;
  isResponseThreadEstablish: boolean;
  surfaceId: string;
}): number {
  if (input.isResponseThreadEstablish) return 0;

  const hasIndex =
    input.index !== undefined
    && Boolean(input.index.lastEventId)
    && input.index.tailOrdinal > 0;

  if (!hasIndex) {
    if (input.candidates.length > 0) {
      throw new CursorDeliveryError(
        'store_error',
        `missing reconciled index for exact candidateCount on ${input.surfaceId}`,
      );
    }
    return 0;
  }

  const tail = input.index!.tailOrdinal;
  const count = Math.max(0, tail - input.afterOrdinal);
  const maxRetained = input.candidates.reduce(
    (max, row) => (row.ordinal > max ? row.ordinal : max),
    0,
  );
  if (maxRetained > 0 && tail < maxRetained) {
    throw new CursorDeliveryError(
      'store_error',
      `index tail ${tail} behind retained max ordinal ${maxRetained} on ${input.surfaceId}`,
    );
  }
  if (count < input.candidates.length) {
    throw new CursorDeliveryError(
      'store_error',
      `index candidateCount ${count} < retained rows ${input.candidates.length} on ${input.surfaceId}`,
    );
  }
  // Split snapshot: index claims a later tail than any retained row we hold.
  // Never treat that future ordinal as an “earlier message not shown.”
  if (tail > input.afterOrdinal && !input.candidates.some((row) => row.ordinal === tail)) {
    throw new CursorDeliveryError(
      'store_error',
      `captured index tail ${tail} missing from journal snapshot on ${input.surfaceId}`,
    );
  }
  return count;
}

/**
 * Collect candidates per surface, then select under a single shared budget.
 * Surfaces with no selected rows do not advance past their current cursor
 * (except empty child-thread establish → present@0).
 */
async function buildSharedBudgetSurfacePlans(
  store: ObservedConversationStore,
  surfaceIds: string[],
  opts: {
    triggerEventId: string;
    triggerSurfaceId: string;
    triggerOrdinal: number;
    triggerItem: SlackInboxItem;
  },
): Promise<SurfaceDeliveryPlan[]> {
  const raw: SurfaceCandidates[] = [];
  let totalCandidates = 0;
  for (const surfaceId of surfaceIds) {
    const cursor = await store.getCursor(surfaceId);
    const cursorExpected: AdvanceCursorExpected =
      cursor.status === 'absent'
        ? { status: 'absent' }
        : { status: 'present', deliveredOrdinal: cursor.deliveredOrdinal };
    const afterOrdinal = cursor.status === 'present' ? cursor.deliveredOrdinal : 0;
    // Locked snapshot: capture reconciled tail first, journal filtered through it.
    // Never pair a later index tail with an earlier journal window (would label a
    // future row as “earlier message not shown”).
    const snapshot = await store.readCursorDeliverySnapshot(surfaceId, {
      afterOrdinal,
      limit: 5_000,
    });
    const { candidates, index } = snapshot;
    const indexPopulation =
      index && index.lastEventId && index.tailOrdinal > 0
        ? Math.max(0, index.tailOrdinal - afterOrdinal)
        : 0;
    // Empty retained alone is not "never observed" when the index still has a tail
    // (archive retention / read limit can drop early ordinals).
    const isResponseThreadEstablish =
      surfaceId !== opts.triggerSurfaceId
      && candidates.length === 0
      && indexPopulation === 0;
    const candidateCount = exactCandidateCountFromIndex({
      afterOrdinal,
      candidates,
      index,
      isResponseThreadEstablish,
      surfaceId,
    });
    if (!isResponseThreadEstablish) totalCandidates += candidateCount;
    raw.push({
      surfaceId,
      cursorExpected,
      cursorDeliveredOrdinal: cursor.status === 'present' ? cursor.deliveredOrdinal : 0,
      isResponseThreadEstablish,
      candidates,
      candidateCount,
    });
  }

  type Tagged = ObservedConversationEntry & { _surfaceId: string };
  const tagged: Tagged[] = [];
  for (const surface of raw) {
    if (surface.isResponseThreadEstablish) continue;
    for (const entry of surface.candidates) {
      tagged.push({ ...entry, _surfaceId: surface.surfaceId });
    }
  }
  tagged.sort(compareByConversationTime);

  const mustInclude =
    tagged.some((t) => t.eventId === opts.triggerEventId)
      ? opts.triggerEventId
      : undefined;

  // Envelope-aware selection: only keep rows that fit the final provider-facing
  // rendered envelope (incl. Latest wake + previews/files). Advance tracks
  // exactly these rows — no post-hoc truncation. Omission budget uses the
  // index-derived population, not the retained-window length.
  const selected = selectNewestFittingForEnvelope(tagged, {
    maxMessages: CURSOR_DELIVERY_MAX_MESSAGES,
    maxBytes: CURSOR_DELIVERY_MAX_BYTES,
    mustIncludeEventId: mustInclude,
    triggerItem: opts.triggerItem,
    totalCandidates,
  });
  return assembleSurfacePlansFromSelection(raw, selected);
}

function assembleSurfacePlansFromSelection(
  raw: SurfaceCandidates[],
  selected: { entries: ObservedConversationEntry[]; omittedCount: number },
): SurfaceDeliveryPlan[] {
  type Tagged = ObservedConversationEntry & { _surfaceId?: string };
  const selectedBySurface = new Map<string, ObservedConversationEntry[]>();
  for (const entry of selected.entries) {
    const surfaceId = (entry as Tagged)._surfaceId;
    if (!surfaceId) continue;
    const list = selectedBySurface.get(surfaceId) ?? [];
    const { _surfaceId: _, ...rest } = entry as Tagged & { _surfaceId: string };
    list.push(rest);
    selectedBySurface.set(surfaceId, list);
  }
  // Sort each surface's entries by ordinal for stable journal advance.
  for (const [sid, list] of selectedBySurface) {
    list.sort((a, b) => a.ordinal - b.ordinal);
    selectedBySurface.set(sid, list);
  }

  const plans: SurfaceDeliveryPlan[] = [];
  for (const surface of raw) {
    if (surface.isResponseThreadEstablish) {
      plans.push({
        surfaceId: surface.surfaceId,
        cursorExpected: surface.cursorExpected,
        nextDeliveredOrdinal: 0,
        entries: [],
        candidateCount: 0,
        omittedCount: 0,
        establishOnly: true,
      });
      continue;
    }
    const entries = selectedBySurface.get(surface.surfaceId) ?? [];
    const last = entries[entries.length - 1];
    const nextDeliveredOrdinal = last
      ? last.ordinal
      : surface.cursorDeliveredOrdinal;
    // Exact per-surface population after cursor (not an aggregate parked on trigger).
    const candidateCount = surface.candidateCount ?? surface.candidates.length;
    const omittedCount = Math.max(0, candidateCount - entries.length);
    plans.push({
      surfaceId: surface.surfaceId,
      cursorExpected: surface.cursorExpected,
      nextDeliveredOrdinal,
      ...(last
        ? { lastDeliveredEventId: last.eventId, lastDeliveredMessageTs: last.messageTs }
        : {}),
      entries,
      candidateCount,
      omittedCount,
      establishOnly: false,
    });
  }
  return plans;
}

/** Conversation-time order for cross-surface selection (messageTs primary). */
export function compareByConversationTime(
  a: { messageTs: string; receivedAt?: string; ordinal?: number },
  b: { messageTs: string; receivedAt?: string; ordinal?: number },
): number {
  const byTs = a.messageTs.localeCompare(b.messageTs, undefined, { numeric: true });
  if (byTs !== 0) return byTs;
  if (a.receivedAt && b.receivedAt) {
    const byRecv = a.receivedAt.localeCompare(b.receivedAt);
    if (byRecv !== 0) return byRecv;
  }
  return (a.ordinal ?? 0) - (b.ordinal ?? 0);
}

/**
 * Pure union of plans by exact surface id (no re-window). Entries deduped by
 * eventId; cursorExpected prefers the more conservative (lower) present ordinal.
 *
 * Per-surface candidateCount is max(candidateCount_i) across plans (exact journal
 * population after the same cursor). omitted = candidateCount − unique(entries).
 * Never sum plan-local omitted aggregates across overlapping windows.
 */
export function mergeSurfacePlans(plans: CursorDeliveryPlan[]): SurfaceDeliveryPlan[] {
  type Acc = {
    surfaceId: string;
    cursorExpected: AdvanceCursorExpected;
    establishOnly: boolean;
    entries: ObservedConversationEntry[];
    /** Exact after-cursor population for this surface (max across source plans). */
    candidateCount: number;
  };
  const bySurface = new Map<string, Acc>();
  for (const plan of plans) {
    for (const surface of plan.surfaces) {
      const pool = surface.candidateCount > 0
        ? surface.candidateCount
        : surface.entries.length + surface.omittedCount;
      const existing = bySurface.get(surface.surfaceId);
      if (!existing) {
        bySurface.set(surface.surfaceId, {
          surfaceId: surface.surfaceId,
          cursorExpected: surface.cursorExpected,
          establishOnly: surface.establishOnly,
          entries: [...surface.entries],
          candidateCount: pool,
        });
        continue;
      }
      const entryById = new Map<string, ObservedConversationEntry>();
      for (const e of existing.entries) entryById.set(e.eventId, e);
      for (const e of surface.entries) entryById.set(e.eventId, e);
      existing.entries = [...entryById.values()].sort((a, b) => a.ordinal - b.ordinal);
      existing.establishOnly =
        existing.establishOnly && surface.establishOnly && existing.entries.length === 0;
      existing.candidateCount = Math.max(existing.candidateCount, pool);
      if (
        existing.cursorExpected.status === 'present'
        && surface.cursorExpected.status === 'present'
        && surface.cursorExpected.deliveredOrdinal < existing.cursorExpected.deliveredOrdinal
      ) {
        existing.cursorExpected = surface.cursorExpected;
      }
    }
  }
  return [...bySurface.values()].map((acc) => {
    const last = acc.entries[acc.entries.length - 1];
    let floor = 0;
    if (acc.cursorExpected.status === 'present') floor = acc.cursorExpected.deliveredOrdinal;
    const omittedCount = Math.max(0, acc.candidateCount - acc.entries.length);
    return {
      surfaceId: acc.surfaceId,
      cursorExpected: acc.cursorExpected,
      nextDeliveredOrdinal: last ? last.ordinal : acc.establishOnly ? 0 : floor,
      ...(last
        ? { lastDeliveredEventId: last.eventId, lastDeliveredMessageTs: last.messageTs }
        : {}),
      entries: acc.entries,
      candidateCount: acc.candidateCount,
      omittedCount,
      establishOnly: acc.establishOnly && acc.entries.length === 0,
    };
  });
}

/**
 * Merge plans and rebuild the full provider-facing envelope.
 * Single-plan merge preserves surfaces/omitted; multi-plan unions then
 * envelope-aware re-windows under 20/16KiB with prior omissions retained.
 */
export function mergeCursorDeliveryPlans(
  plans: CursorDeliveryPlan[],
  triggerItem: SlackInboxItem,
): CursorDeliveryPlan {
  if (plans.length === 0) {
    throw new Error('mergeCursorDeliveryPlans requires at least one plan');
  }
  if (plans.length === 1) {
    const only = plans[0]!;
    const clipped = clipTriggerExtrasForEnvelope(triggerItem);
    return {
      ...only,
      promptBody: renderCursorDeliveryEnvelope(clipped, only.surfaces),
      committed: false,
    };
  }

  const unioned = mergeSurfacePlans(plans);
  // Exact unique population = sum of per-surface candidateCount (independent journals).
  let totalCandidates = 0;
  type Tagged = ObservedConversationEntry & { _surfaceId: string };
  const tagged: Tagged[] = [];
  for (const surface of unioned) {
    if (surface.establishOnly) continue;
    totalCandidates += surface.candidateCount;
    for (const entry of surface.entries) {
      tagged.push({ ...entry, _surfaceId: surface.surfaceId });
    }
  }
  // Re-window only among rows already shown in source plans; omitted accounting
  // still uses exact per-surface candidateCount (not inventable journal rows).
  totalCandidates = Math.max(totalCandidates, tagged.length);
  const clippedTrigger = clipTriggerExtrasForEnvelope(triggerItem);
  tagged.sort(compareByConversationTime);
  const selected = selectNewestFittingForEnvelope(tagged, {
    maxMessages: CURSOR_DELIVERY_MAX_MESSAGES,
    maxBytes: CURSOR_DELIVERY_MAX_BYTES,
    triggerItem: clippedTrigger,
    totalCandidates,
  });
  // Carry exact candidateCount per surface so assemble can recover omissions
  // for child threads that contributed only aggregate omissions under the bound.
  const raw: SurfaceCandidates[] = unioned.map((s) => ({
    surfaceId: s.surfaceId,
    cursorExpected: s.cursorExpected,
    cursorDeliveredOrdinal:
      s.cursorExpected.status === 'present' ? s.cursorExpected.deliveredOrdinal : 0,
    isResponseThreadEstablish: s.establishOnly,
    candidates: s.entries,
    candidateCount: s.candidateCount,
  }));
  const surfaces = assembleSurfacePlansFromSelection(raw, selected);
  const primary = plans.reduce((a, b) =>
    Math.max(...a.surfaces.map((s) => s.nextDeliveredOrdinal))
      >= Math.max(...b.surfaces.map((s) => s.nextDeliveredOrdinal))
      ? a
      : b,
  );
  return {
    agentId: primary.agentId,
    triggerItemId: primary.triggerItemId,
    triggerEventId: primary.triggerEventId,
    surfaces,
    promptBody: renderCursorDeliveryEnvelope(clippedTrigger, surfaces),
    committed: false,
  };
}

/**
 * Newest-fitting by conversation time using only line bytes (unit tests /
 * internal). Prefer selectNewestFittingForEnvelope when advancing cursors.
 */
export function selectNewestFitting(
  candidates: ObservedConversationEntry[],
  options: {
    maxMessages: number;
    maxBytes: number;
    mustIncludeEventId?: string;
  },
): { entries: ObservedConversationEntry[]; omittedCount: number } {
  return selectNewestFittingForEnvelope(candidates, {
    ...options,
    totalCandidates: candidates.length,
  });
}

/**
 * Newest-fitting selection measured against the final provider-facing envelope
 * (rows + Latest wake + previews + files). Only rows that fit are returned;
 * nextDeliveredOrdinal must be derived from this set alone.
 */
export function selectNewestFittingForEnvelope(
  candidates: ObservedConversationEntry[],
  options: {
    maxMessages: number;
    maxBytes: number;
    mustIncludeEventId?: string;
    triggerItem?: SlackInboxItem;
    totalCandidates?: number;
  },
): { entries: ObservedConversationEntry[]; omittedCount: number } {
  if (candidates.length === 0) {
    return { entries: [], omittedCount: options.totalCandidates ?? 0 };
  }

  const ordered = [...candidates].sort(compareByConversationTime);
  const poolSize = options.totalCandidates ?? candidates.length;

  const fits = (entries: ObservedConversationEntry[]): boolean => {
    if (entries.length > options.maxMessages) return false;
    if (!options.triggerItem) {
      // Line-only budget (merge path without trigger uses row bytes).
      let bytes = 0;
      for (const e of entries) {
        bytes += Buffer.byteLength(formatObservedLine(e), 'utf8') + 1;
      }
      return bytes <= options.maxBytes;
    }
    const envelope = renderCursorDeliveryEnvelopeFromEntries(
      options.triggerItem,
      entries,
      Math.max(0, poolSize - entries.length),
    );
    return Buffer.byteLength(envelope, 'utf8') <= options.maxBytes;
  };

  const selected: ObservedConversationEntry[] = [];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const trial = [...selected, ordered[i]!].sort(compareByConversationTime);
    if (!fits(trial)) {
      // Never force-keep a row that makes the envelope over-cap (extras-alone
      // overflow is handled by clipping trigger extras before selection).
      break;
    }
    selected.length = 0;
    selected.push(...trial);
  }

  if (options.mustIncludeEventId) {
    const has = selected.some((r) => r.eventId === options.mustIncludeEventId);
    if (!has) {
      const trigger = ordered.find((r) => r.eventId === options.mustIncludeEventId);
      if (trigger) {
        const fromTrigger = ordered.filter((r) => compareByConversationTime(r, trigger) >= 0);
        const rewindowed = selectNewestFittingForEnvelope(fromTrigger, {
          maxMessages: options.maxMessages,
          maxBytes: options.maxBytes,
          triggerItem: options.triggerItem,
          totalCandidates: poolSize,
        });
        if (!rewindowed.entries.some((r) => r.eventId === options.mustIncludeEventId)) {
          const rest = rewindowed.entries
            .filter((r) => r.eventId !== trigger.eventId)
            .slice(-(options.maxMessages - 1));
          const forced = [trigger, ...rest].sort(compareByConversationTime);
          // Drop from newest until envelope fits, keeping trigger.
          let kept = forced;
          while (kept.length > 1 && !fits(kept)) {
            // Remove newest non-trigger
            const idx = [...kept].reverse().findIndex((e) => e.eventId !== trigger.eventId);
            if (idx < 0) break;
            const removeAt = kept.length - 1 - idx;
            kept = kept.filter((_, i) => i !== removeAt);
          }
          return {
            entries: kept,
            omittedCount: Math.max(0, poolSize - kept.length),
          };
        }
        return {
          entries: rewindowed.entries,
          omittedCount: Math.max(0, poolSize - rewindowed.entries.length),
        };
      }
    }
  }

  return {
    entries: selected,
    omittedCount: Math.max(0, poolSize - selected.length),
  };
}

export function formatObservedLine(entry: ObservedConversationEntry): string {
  const actor = observedSenderLabel(entry);
  let text = entry.text;
  if (!text && entry.files?.length) {
    text = entry.files.map((f) => f.name ?? f.id).join(', ');
    text = text ? `[file: ${text}]` : '[file]';
  }
  text = clipObservedText(text);
  // Keep synthetic storage bot ids out of the agent-facing envelope; sender
  // label already maps them (e.g. B_ANIMA_SHORTCUT → "shortcut").
  const envelopeBotId = entry.botId === ACTORLESS_SLACK_WAKE_BOT_ID ? undefined : entry.botId;
  const env = renderEnvelope([
    { key: 'message_ts', value: entry.messageTs },
    { key: 'time', value: envelopeTime(entry.receivedAt) },
    { key: 'user_id', value: entry.userId },
    { key: 'bot_id', value: envelopeBotId },
    { key: 'ordinal', value: entry.ordinal },
  ]);
  return `${env} ${actor}: ${text}`;
}

/**
 * Final provider-facing cursor envelope: chronological rows + Latest wake +
 * previews/files. Must not post-truncate after nextDeliveredOrdinal is chosen;
 * callers select rows so this string is already ≤ 16 KiB.
 */
export function renderCursorDeliveryEnvelope(
  trigger: SlackInboxItem,
  surfaces: SurfaceDeliveryPlan[],
): string {
  const allEntries: ObservedConversationEntry[] = [];
  let omitted = 0;
  for (const surface of surfaces) {
    if (surface.establishOnly) continue;
    allEntries.push(...surface.entries);
    omitted += surface.omittedCount;
  }
  return renderCursorDeliveryEnvelopeFromEntries(trigger, allEntries, omitted);
}

export function renderCursorDeliveryEnvelopeFromEntries(
  trigger: SlackInboxItem,
  entries: ObservedConversationEntry[],
  omitted: number,
): string {
  const sorted = [...entries].sort(compareByConversationTime);
  const parts: string[] = ['Slack conversation update:'];
  if (sorted.length > 0) {
    parts.push('');
    // Iris: earlier-omitted marker above shown rows (gap is chronologically
    // before the newest-fitting set) — same placement as HELD delta.
    if (omitted > 0) {
      parts.push(exactEarlierMessagesMarker(omitted));
    }
    for (const entry of sorted) {
      parts.push(formatObservedLine(entry));
    }
  } else {
    parts.push('', '(no prior observed messages in window)');
  }

  parts.push('', 'Latest wake:', buildLatestWakeLine(trigger));
  if (trigger.attentionSuggestion) {
    parts.push('', trigger.attentionSuggestion);
  }
  const extras = renderSlackCursorExtras(trigger);
  if (extras) parts.push('', extras);
  return parts.join('\n');
}

/**
 * Truncate to maxBytes UTF-8 without splitting code points / surrogate pairs.
 * Used for per-message clip and extras clipping — not for post-plan row mutation.
 */
/** Iris: per-message clip ends with `… [truncated]` (ellipsis from truncateUtf8). */
export function clipObservedText(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= CURSOR_DELIVERY_MAX_MESSAGE_BYTES) return text;
  const suffix = truncatedMarkerSuffix();
  const bodyBudget = Math.max(1, CURSOR_DELIVERY_MAX_MESSAGE_BYTES - Buffer.byteLength(suffix, 'utf8'));
  return `${truncateUtf8(text, bodyBudget)}${suffix}`;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  const ellipsisBytes = Buffer.byteLength(ellipsis, 'utf8');
  if (maxBytes < ellipsisBytes) return '';
  const budget = maxBytes - ellipsisBytes;
  let result = '';
  for (const ch of text) {
    // for...of yields full code points (no lone surrogates).
    const next = result + ch;
    if (Buffer.byteLength(next, 'utf8') > budget) break;
    result = next;
  }
  return `${result}${ellipsis}`;
}

/**
 * Clip previews/files so chrome + Latest wake + extras fit in the envelope
 * budget even with zero snapshot rows. Never leave an over-cap prepared plan.
 */
/** Envelope line + sender label + row separators around a snapshot row. */
const TRIGGER_ROW_ENVELOPE_OVERHEAD_BYTES = 256;

export function clipTriggerExtrasForEnvelope(trigger: SlackInboxItem): SlackInboxItem {
  // Start from empty-row envelope; shrink extras until under cap.
  let previews = trigger.previews?.map((p) => ({ ...p }));
  let files = trigger.files?.map((f) => ({ ...f }));
  let attention = trigger.attentionSuggestion;
  // The trigger is rendered twice (its snapshot row + Latest wake). Extras are
  // shrunk against a budget that reserves the row copy, so a long trigger cannot
  // push the mandatory row out of the envelope.
  const triggerRowReserve = Buffer.byteLength(clipObservedText(trigger.text ?? ''), 'utf8') + TRIGGER_ROW_ENVELOPE_OVERHEAD_BYTES;
  const extrasBudget = CURSOR_DELIVERY_MAX_BYTES - triggerRowReserve;

  const measure = (): number => {
    const item: SlackInboxItem = {
      ...trigger,
      ...(previews ? { previews } : { previews: undefined }),
      ...(files ? { files } : { files: undefined }),
      ...(attention ? { attentionSuggestion: attention } : {}),
    };
    // Clear optional fields properly
    const cleaned = { ...item };
    if (!previews?.length) delete (cleaned as { previews?: unknown }).previews;
    else cleaned.previews = previews;
    if (!files?.length) delete (cleaned as { files?: unknown }).files;
    else cleaned.files = files;
    if (!attention) delete (cleaned as { attentionSuggestion?: unknown }).attentionSuggestion;
    else cleaned.attentionSuggestion = attention;
    return Buffer.byteLength(
      renderCursorDeliveryEnvelopeFromEntries(cleaned, [], 0),
      'utf8',
    );
  };

  // Drop attention first if needed.
  if (measure() > extrasBudget) {
    attention = undefined;
  }
  // Progressively clip preview texts.
  if (previews?.length) {
    let guard = 0;
    while (measure() > extrasBudget && guard < 40) {
      guard += 1;
      let clippedAny = false;
      previews = previews.map((p) => {
        const bytes = Buffer.byteLength(p.text, 'utf8');
        if (bytes <= 32) return p;
        clippedAny = true;
        return { ...p, text: truncateUtf8(p.text, Math.max(32, Math.floor(bytes / 2))) };
      });
      if (!clippedAny) {
        // Drop previews entirely.
        previews = undefined;
        break;
      }
    }
  }
  if (measure() > extrasBudget && files?.length) {
    // Strip file display names, then drop files if still over.
    files = files.map((f) => ({ ...f, name: f.id }));
    if (measure() > extrasBudget) {
      files = undefined;
    }
  }
  // Last resort: empty extras; Latest wake text already clipped per-message.
  if (measure() > extrasBudget) {
    previews = undefined;
    files = undefined;
    attention = undefined;
  }

  const out: SlackInboxItem = { ...trigger };
  if (previews?.length) out.previews = previews;
  else delete (out as { previews?: unknown }).previews;
  if (files?.length) out.files = files;
  else delete (out as { files?: unknown }).files;
  if (attention) out.attentionSuggestion = attention;
  else delete (out as { attentionSuggestion?: unknown }).attentionSuggestion;
  return out;
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
  let text = event.text ?? '';
  if (!text && event.files?.length) {
    text = `[file: ${event.files.map((f) => f.name).join(', ')}]`;
  }
  // Same clip as snapshot rows — never re-expand a long trigger in Latest wake.
  text = clipObservedText(text);
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
