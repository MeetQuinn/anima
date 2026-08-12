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

/** Newest-fitting bound: max messages in the final provider-facing envelope. */
export const CURSOR_DELIVERY_MAX_MESSAGES = 20;
/**
 * Max UTF-8 bytes of the final provider-facing rendered envelope (PRD / Iris):
 * snapshot rows + Latest wake + previews + file metadata — everything the
 * agent turn receives from the cursor view.
 */
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

    // Build raw per-surface candidates, then allocate ONE shared 20/16KiB budget
    // for the final provider-facing envelope (rows + Latest wake + previews/files).
    // nextDeliveredOrdinal is computed only from rows that survive that budget —
    // never truncate the rendered evidence after choosing the advance.
    const surfaces = await buildSharedBudgetSurfacePlans(store, surfaceIds, {
      triggerEventId: eventId,
      triggerSurfaceId,
      triggerOrdinal: triggerEntry.ordinal,
      triggerItem: item,
    });

    const promptBody = renderCursorDeliveryEnvelope(item, surfaces);
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
  candidates: ObservedConversationEntry[];
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
  for (const surfaceId of surfaceIds) {
    const cursor = await store.getCursor(surfaceId);
    const cursorExpected: AdvanceCursorExpected =
      cursor.status === 'absent'
        ? { status: 'absent' }
        : { status: 'present', deliveredOrdinal: cursor.deliveredOrdinal };
    const afterOrdinal = cursor.status === 'present' ? cursor.deliveredOrdinal : 0;
    const candidates = await store.readJournal(surfaceId, { afterOrdinal, limit: 5_000 });
    const isResponseThreadEstablish =
      surfaceId !== opts.triggerSurfaceId && candidates.length === 0;
    raw.push({
      surfaceId,
      cursorExpected,
      cursorDeliveredOrdinal: cursor.status === 'present' ? cursor.deliveredOrdinal : 0,
      isResponseThreadEstablish,
      candidates,
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
  // rendered envelope (incl. Latest wake + previews + files). Advance tracks
  // exactly these rows — no post-hoc truncation.
  const selected = selectNewestFittingForEnvelope(tagged, {
    maxMessages: CURSOR_DELIVERY_MAX_MESSAGES,
    maxBytes: CURSOR_DELIVERY_MAX_BYTES,
    mustIncludeEventId: mustInclude,
    triggerItem: opts.triggerItem,
    totalCandidates: tagged.length,
  });
  return assembleSurfacePlansFromSelection(raw, selected, opts.triggerSurfaceId, tagged.length);
}

function assembleSurfacePlansFromSelection(
  raw: SurfaceCandidates[],
  selected: { entries: ObservedConversationEntry[]; omittedCount: number },
  triggerSurfaceId: string,
  totalCandidates: number,
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

  const totalOmitted = Math.max(0, totalCandidates - selected.entries.length);
  const plans: SurfaceDeliveryPlan[] = [];
  for (const surface of raw) {
    if (surface.isResponseThreadEstablish) {
      plans.push({
        surfaceId: surface.surfaceId,
        cursorExpected: surface.cursorExpected,
        nextDeliveredOrdinal: 0,
        entries: [],
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
    const isTriggerSurface = surface.surfaceId === triggerSurfaceId;
    plans.push({
      surfaceId: surface.surfaceId,
      cursorExpected: surface.cursorExpected,
      nextDeliveredOrdinal,
      ...(last
        ? { lastDeliveredEventId: last.eventId, lastDeliveredMessageTs: last.messageTs }
        : {}),
      entries,
      omittedCount: isTriggerSurface ? totalOmitted : 0,
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
 * omittedCount is summed for later totalCandidates accounting.
 */
export function mergeSurfacePlans(plans: CursorDeliveryPlan[]): SurfaceDeliveryPlan[] {
  type Acc = {
    surfaceId: string;
    cursorExpected: AdvanceCursorExpected;
    establishOnly: boolean;
    entries: ObservedConversationEntry[];
    omittedCount: number;
  };
  const bySurface = new Map<string, Acc>();
  for (const plan of plans) {
    for (const surface of plan.surfaces) {
      const existing = bySurface.get(surface.surfaceId);
      if (!existing) {
        bySurface.set(surface.surfaceId, {
          surfaceId: surface.surfaceId,
          cursorExpected: surface.cursorExpected,
          establishOnly: surface.establishOnly,
          entries: [...surface.entries],
          omittedCount: surface.omittedCount,
        });
        continue;
      }
      const entryById = new Map<string, ObservedConversationEntry>();
      for (const e of existing.entries) entryById.set(e.eventId, e);
      for (const e of surface.entries) entryById.set(e.eventId, e);
      existing.entries = [...entryById.values()].sort((a, b) => a.ordinal - b.ordinal);
      existing.establishOnly =
        existing.establishOnly && surface.establishOnly && existing.entries.length === 0;
      existing.omittedCount = Math.max(existing.omittedCount, surface.omittedCount);
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
    return {
      surfaceId: acc.surfaceId,
      cursorExpected: acc.cursorExpected,
      nextDeliveredOrdinal: last ? last.ordinal : acc.establishOnly ? 0 : floor,
      ...(last
        ? { lastDeliveredEventId: last.eventId, lastDeliveredMessageTs: last.messageTs }
        : {}),
      entries: acc.entries,
      omittedCount: acc.omittedCount,
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
    return {
      ...only,
      promptBody: renderCursorDeliveryEnvelope(triggerItem, only.surfaces),
      committed: false,
    };
  }

  const unioned = mergeSurfacePlans(plans);
  let sourceOmitted = 0;
  for (const plan of plans) {
    for (const s of plan.surfaces) sourceOmitted += s.omittedCount;
  }
  type Tagged = ObservedConversationEntry & { _surfaceId: string };
  const tagged: Tagged[] = [];
  for (const surface of unioned) {
    if (surface.establishOnly) continue;
    for (const entry of surface.entries) {
      tagged.push({ ...entry, _surfaceId: surface.surfaceId });
    }
  }
  const totalCandidates = tagged.length + sourceOmitted;
  tagged.sort(compareByConversationTime);
  const selected = selectNewestFittingForEnvelope(tagged, {
    maxMessages: CURSOR_DELIVERY_MAX_MESSAGES,
    maxBytes: CURSOR_DELIVERY_MAX_BYTES,
    triggerItem,
    totalCandidates,
  });
  const raw: SurfaceCandidates[] = unioned.map((s) => ({
    surfaceId: s.surfaceId,
    cursorExpected: s.cursorExpected,
    cursorDeliveredOrdinal:
      s.cursorExpected.status === 'present' ? s.cursorExpected.deliveredOrdinal : 0,
    isResponseThreadEstablish: s.establishOnly,
    candidates: s.entries,
  }));
  const surfaces = assembleSurfacePlansFromSelection(
    raw,
    selected,
    unioned[0]?.surfaceId ?? '',
    totalCandidates,
  );
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
    promptBody: renderCursorDeliveryEnvelope(triggerItem, surfaces),
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
      if (selected.length === 0) {
        // Single oversized row: keep it (clipped lines still may exceed with extras);
        // still include so trigger isn't lost; envelope builder clips message text.
        selected.push(ordered[i]!);
      }
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
  if (Buffer.byteLength(text, 'utf8') > CURSOR_DELIVERY_MAX_MESSAGE_CHARS) {
    text = truncateUtf8(text, CURSOR_DELIVERY_MAX_MESSAGE_CHARS);
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

/** @deprecated Use renderCursorDeliveryEnvelope — same output, full envelope. */
export function renderCursorDeliveryPrompt(
  trigger: SlackInboxItem,
  surfaces: SurfaceDeliveryPlan[],
): string {
  return renderCursorDeliveryEnvelope(trigger, surfaces);
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
    for (const entry of sorted) {
      parts.push(formatObservedLine(entry));
    }
    if (omitted > 0) {
      parts.push(
        `(${omitted} earlier message${omitted === 1 ? '' : 's'} not shown)`,
      );
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
 * Used for per-message clip only — not for post-plan envelope mutation.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'));
  let result = '';
  for (const ch of text) {
    // for...of yields full code points (no lone surrogates).
    const next = result + ch;
    if (Buffer.byteLength(next, 'utf8') > budget) break;
    result = next;
  }
  return `${result}${ellipsis}`;
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
  if (Buffer.byteLength(text, 'utf8') > CURSOR_DELIVERY_MAX_MESSAGE_CHARS) {
    text = truncateUtf8(text, CURSOR_DELIVERY_MAX_MESSAGE_CHARS);
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
