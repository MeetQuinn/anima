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

    // Build raw per-surface candidates, then allocate ONE shared 20/16KiB budget
    // across the whole cursor view (not per surface).
    const surfaces = await buildSharedBudgetSurfacePlans(store, surfaceIds, {
      triggerEventId: eventId,
      triggerSurfaceId,
      triggerOrdinal: triggerEntry.ordinal,
    });

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

  // Tagged candidates for shared selection (establish-only surfaces contribute none).
  type Tagged = ObservedConversationEntry & { _surfaceId: string };
  const tagged: Tagged[] = [];
  for (const surface of raw) {
    if (surface.isResponseThreadEstablish) continue;
    for (const entry of surface.candidates) {
      tagged.push({ ...entry, _surfaceId: surface.surfaceId });
    }
  }

  // Sort by conversation time (messageTs), not surface order / per-surface ordinal.
  tagged.sort(compareByConversationTime);

  const mustInclude =
    tagged.some((t) => t.eventId === opts.triggerEventId)
      ? opts.triggerEventId
      : undefined;

  // Reserve rendered budget for prompt chrome + clipped Latest wake so the
  // final cursor view (snapshot + Latest wake) stays within 16 KiB.
  const reservedLatest = CURSOR_DELIVERY_MAX_MESSAGE_CHARS + 256;
  const chromeBytes = 128;
  const contextBudget = Math.max(
    512,
    CURSOR_DELIVERY_MAX_BYTES - reservedLatest - chromeBytes,
  );

  const selected = selectNewestFitting(tagged, {
    maxMessages: CURSOR_DELIVERY_MAX_MESSAGES,
    maxBytes: contextBudget,
    mustIncludeEventId: mustInclude,
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
 * Merge multiple delivery plans by exact surface id, then re-apply the global
 * 20/16 KiB window so a union of individually bounded plans cannot exceed the
 * contract (e.g. 15+15 → 30 without re-window).
 */
export function mergeSurfacePlans(plans: CursorDeliveryPlan[]): SurfaceDeliveryPlan[] {
  // Union raw entries per surface (before re-window).
  type Acc = {
    surfaceId: string;
    cursorExpected: AdvanceCursorExpected;
    cursorFloor: number;
    establishOnly: boolean;
    entries: ObservedConversationEntry[];
  };
  const bySurface = new Map<string, Acc>();
  for (const plan of plans) {
    for (const surface of plan.surfaces) {
      const existing = bySurface.get(surface.surfaceId);
      if (!existing) {
        bySurface.set(surface.surfaceId, {
          surfaceId: surface.surfaceId,
          cursorExpected: surface.cursorExpected,
          cursorFloor: surface.establishOnly
            ? 0
            : Math.max(0, surface.nextDeliveredOrdinal - (surface.entries.at(-1)?.ordinal ?? surface.nextDeliveredOrdinal)),
          establishOnly: surface.establishOnly,
          entries: [...surface.entries],
        });
        // cursorFloor fallback: if we have entries, floor is min ordinal - 1 conceptually;
        // for CAS we keep the earliest (lowest present) expectation when merging.
        continue;
      }
      // Prefer absent→present: use the more advanced expected only if equal epoch;
      // when batching concurrent prepares both start from the same cursorExpected.
      if (
        existing.cursorExpected.status === 'absent'
        && surface.cursorExpected.status === 'present'
      ) {
        // Keep existing absent if still valid for both; concurrent batch same epoch.
      }
      const entryById = new Map<string, ObservedConversationEntry>();
      for (const e of existing.entries) entryById.set(e.eventId, e);
      for (const e of surface.entries) entryById.set(e.eventId, e);
      existing.entries = [...entryById.values()];
      existing.establishOnly = existing.establishOnly && surface.establishOnly && existing.entries.length === 0;
      // Keep the lower cursor expected (more conservative CAS) when both present.
      if (
        existing.cursorExpected.status === 'present'
        && surface.cursorExpected.status === 'present'
        && surface.cursorExpected.deliveredOrdinal < existing.cursorExpected.deliveredOrdinal
      ) {
        existing.cursorExpected = surface.cursorExpected;
      }
    }
  }

  // Re-window under one global budget by conversation time.
  type Tagged = ObservedConversationEntry & { _surfaceId: string };
  const tagged: Tagged[] = [];
  for (const acc of bySurface.values()) {
    if (acc.establishOnly) continue;
    for (const entry of acc.entries) {
      tagged.push({ ...entry, _surfaceId: acc.surfaceId });
    }
  }
  tagged.sort(compareByConversationTime);
  const selected = selectNewestFitting(tagged, {
    maxMessages: CURSOR_DELIVERY_MAX_MESSAGES,
    maxBytes: CURSOR_DELIVERY_MAX_BYTES,
  });

  const selectedBySurface = new Map<string, ObservedConversationEntry[]>();
  for (const entry of selected.entries) {
    const sid = (entry as Tagged)._surfaceId;
    const list = selectedBySurface.get(sid) ?? [];
    const { _surfaceId: _, ...rest } = entry as Tagged;
    list.push(rest);
    selectedBySurface.set(sid, list);
  }
  for (const [sid, list] of selectedBySurface) {
    list.sort((a, b) => a.ordinal - b.ordinal);
    selectedBySurface.set(sid, list);
  }

  const totalOmitted = selected.omittedCount;
  const plansOut: SurfaceDeliveryPlan[] = [];
  let omittedAssigned = false;
  for (const acc of bySurface.values()) {
    if (acc.establishOnly) {
      plansOut.push({
        surfaceId: acc.surfaceId,
        cursorExpected: acc.cursorExpected,
        nextDeliveredOrdinal: 0,
        entries: [],
        omittedCount: 0,
        establishOnly: true,
      });
      continue;
    }
    const entries = selectedBySurface.get(acc.surfaceId) ?? [];
    const last = entries[entries.length - 1];
    let floor = 0;
    if (acc.cursorExpected.status === 'present') {
      floor = acc.cursorExpected.deliveredOrdinal;
    }
    const nextDeliveredOrdinal = last ? last.ordinal : floor;
    const assignOmitted = !omittedAssigned;
    if (assignOmitted) omittedAssigned = true;
    plansOut.push({
      surfaceId: acc.surfaceId,
      cursorExpected: acc.cursorExpected,
      nextDeliveredOrdinal,
      ...(last
        ? { lastDeliveredEventId: last.eventId, lastDeliveredMessageTs: last.messageTs }
        : {}),
      entries,
      omittedCount: assignOmitted ? totalOmitted : 0,
      establishOnly: false,
    });
  }
  return plansOut;
}

/** Merge plans, re-window globally, rebuild prompt. */
export function mergeCursorDeliveryPlans(
  plans: CursorDeliveryPlan[],
  triggerItem: SlackInboxItem,
): CursorDeliveryPlan {
  if (plans.length === 0) {
    throw new Error('mergeCursorDeliveryPlans requires at least one plan');
  }
  const surfaces = mergeSurfacePlans(plans);
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
    promptBody: renderCursorDeliveryPrompt(triggerItem, surfaces),
    committed: false,
  };
}

/**
 * Newest-fitting selection by conversation time: sort by messageTs, walk from
 * newest backward until message/byte caps, return chronological. Ensures
 * mustIncludeEventId stays in the window (time-based, not per-surface ordinal).
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

  const ordered = [...candidates].sort(compareByConversationTime);
  const selected: ObservedConversationEntry[] = [];
  let bytes = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const row = ordered[i]!;
    const line = formatObservedLine(row);
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
    if (selected.length >= options.maxMessages) break;
    if (selected.length > 0 && bytes + lineBytes > options.maxBytes) break;
    if (selected.length === 0 && lineBytes > options.maxBytes) {
      selected.push(row);
      bytes = Math.min(lineBytes, options.maxBytes);
      break;
    }
    selected.push(row);
    bytes += lineBytes;
  }
  selected.reverse();

  if (options.mustIncludeEventId) {
    const has = selected.some((r) => r.eventId === options.mustIncludeEventId);
    if (!has) {
      const trigger = ordered.find((r) => r.eventId === options.mustIncludeEventId);
      if (trigger) {
        // Include everything at or after the trigger in conversation time.
        const fromTrigger = ordered.filter(
          (r) => compareByConversationTime(r, trigger) >= 0,
        );
        const rewindowed = selectNewestFitting(fromTrigger, {
          maxMessages: options.maxMessages,
          maxBytes: options.maxBytes,
        });
        if (!rewindowed.entries.some((r) => r.eventId === options.mustIncludeEventId)) {
          const rest = rewindowed.entries
            .filter((r) => r.eventId !== trigger.eventId)
            .slice(-(options.maxMessages - 1));
          const forced = [trigger, ...rest].sort(compareByConversationTime);
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

  return {
    entries: selected,
    omittedCount: Math.max(0, candidates.length - selected.length),
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
  // Chronological flat list (not surface-order) so the rendered window matches
  // conversation-time newest-fitting selection.
  const allEntries: ObservedConversationEntry[] = [];
  let omitted = 0;
  for (const surface of surfaces) {
    if (surface.establishOnly) continue;
    allEntries.push(...surface.entries);
    omitted += surface.omittedCount;
  }
  allEntries.sort(compareByConversationTime);

  const parts: string[] = ['Slack conversation update:'];
  if (allEntries.length > 0) {
    parts.push('');
    for (const entry of allEntries) {
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

  // Latest wake is always clipped — never re-expand a long trigger past the
  // per-message clip that selectNewestFitting already applied to snapshot rows.
  const latest = buildLatestWakeLine(trigger);
  parts.push('', 'Latest wake:', latest);
  if (trigger.attentionSuggestion) {
    parts.push('', trigger.attentionSuggestion);
  }
  let body = parts.join('\n');
  // Hard cap: entire cursor view ≤ 16 KiB rendered UTF-8.
  if (Buffer.byteLength(body, 'utf8') > CURSOR_DELIVERY_MAX_BYTES) {
    body = truncateUtf8(body, CURSOR_DELIVERY_MAX_BYTES);
  }
  return body;
}

/** Truncate a string to at most maxBytes UTF-8, appending an ellipsis if cut. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > budget) {
    end = Math.floor(end * 0.9);
  }
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > budget) {
    end -= 1;
  }
  return `${text.slice(0, end)}${ellipsis}`;
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
  if (text.length > CURSOR_DELIVERY_MAX_MESSAGE_CHARS) {
    text = `${text.slice(0, CURSOR_DELIVERY_MAX_MESSAGE_CHARS)}…`;
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
