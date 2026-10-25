// Agent-scoped observed-conversation journal + per-conversation index + cursor.
//
// Cut (a) of send-hold/cursor-view: record every observable Slack message the
// agent process sees at ingress, before wake/subscription filtering. Feature is
// inert (no prompt/hold/queue changes). Key: slackSurfaceId(teamId, channelId, threadTs?).
//
// Layout under agents/<agentId>/:
//   observed-conversations/<safeSurfaceId>.jsonl
//   observed-conversations/<safeSurfaceId>.index.json   — journal-tail metadata
//   observed-conversations/<safeSurfaceId>.cursor.json  — delivered cursor
//   observation-continuity.json  — agent-wide health (ok | degraded); sibling of the
//                                  journal dir so a blocked journal path can still
//                                  record fail-closed continuity
//
// Index updates serialize via JsonStore.update (file lock). Journal append is a
// different lock path. On retry after a journal-append/index-write split, observe
// reconciles the index from the retained journal before assigning a new ordinal.

import { join } from 'node:path';

import { z } from 'zod';

import { nowIso, slackMessageEventId, slackSurfaceId } from '../../ids.js';
import { DEFAULT_JSONL_ROTATE_BYTES, JsonlAppendLog } from '../jsonl-log.js';
import { JsonStore } from '../json-store.js';
import { safeFilename } from '../safe-filename.js';
import { currentWriteRoot, ensureParentDirectory } from '../write-root.js';
import { agentsDir } from './agent.store.js';

/** Bound recent dedupe window inside one conversation journal. */
export const OBSERVED_CONVERSATION_DEDUPE_RECENT = 2_000;

/**
 * Older rows a bounded journal read takes beyond the rows it needs, to check
 * that ordinals still rise in file order.
 *
 * A bounded read takes rows from the live file only (`readLiveTail`), where
 * file order is append order. Archives are named by the clock and can sort out
 * of append order, so when the rows it needs reach an archive, it falls back.
 *
 * observe() numbers each row one past the reconciled tail, so they rise, with
 * one exception: lock.ts takes over a lock held for five minutes even when its
 * holder is alive. When that holder resumes, it appends the ordinal it planned
 * before, which can be no higher than rows appended since. A row older than a
 * bounded read can carry an ordinal the read needed only when every one of
 * these extra rows is such a resumed append, each after its own takeover. When
 * the rows do not rise, the read falls back to the full dedupe window.
 */
export const OBSERVED_CONVERSATION_ORDER_CHECK_ROWS = 8;

/** Cap retained journal archives per conversation (plus the live segment). */
export const OBSERVED_CONVERSATION_MAX_ARCHIVES = 4;

/** Minimal local file descriptor for file-only / file-bearing messages. */
export const ObservedFileDescriptorSchema = z.object({
  id: z.string().min(1),
  mimetype: z.string().optional(),
  name: z.string().optional(),
});

export type ObservedFileDescriptor = z.infer<typeof ObservedFileDescriptorSchema>;

export const ObservedConversationEntrySchema = z
  .object({
    botId: z.string().min(1).optional(),
    channelId: z.string().min(1),
    eventId: z.string().min(1),
    files: z.array(ObservedFileDescriptorSchema).optional(),
    messageTs: z.string().min(1),
    observedAt: z.string().min(1),
    ordinal: z.number().int().positive(),
    receivedAt: z.string().min(1),
    surfaceId: z.string().min(1),
    teamId: z.string().min(1),
    /** May be empty when files are present (file-only posts). */
    text: z.string(),
    threadTs: z.string().optional(),
    userId: z.string().min(1).optional(),
  })
  .refine((row) => Boolean(row.userId || row.botId), {
    message: 'observed entry requires userId and/or botId',
  });

export type ObservedConversationEntry = z.infer<typeof ObservedConversationEntrySchema>;

/** Journal-tail metadata for one conversation (not the delivered cursor). */
export const ConversationIndexSchema = z.object({
  lastEventId: z.string(),
  lastMessageTs: z.string(),
  surfaceId: z.string().min(1),
  tailOrdinal: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
});

export type ConversationIndex = z.infer<typeof ConversationIndexSchema>;

/**
 * Delivered cursor record.
 *
 * - `deliveredOrdinal: null` → **confirmed absent** (never delivered into this
 *   conversation; "no-cursor lands" applies only to this state).
 * - `deliveredOrdinal: 0` → present at origin (established, nothing past start).
 * - `deliveredOrdinal: N>0` → context watermark through ordinal N inclusive.
 *   Bounded displays can omit rows; this is not proof that every wake was shown.
 *
 * A missing cursor file reads as confirmed absent via empty().
 */
export const ConversationCursorRecordSchema = z.object({
  deliveredOrdinal: z.number().int().nonnegative().nullable(),
  lastDeliveredEventId: z.string().optional(),
  lastDeliveredMessageTs: z.string().optional(),
  surfaceId: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type ConversationCursorRecord = z.infer<typeof ConversationCursorRecordSchema>;

export type ConversationCursorView =
  | { status: 'absent'; surfaceId: string }
  | {
      status: 'present';
      deliveredOrdinal: number;
      lastDeliveredEventId?: string;
      lastDeliveredMessageTs?: string;
      surfaceId: string;
      updatedAt: string;
    };

export type AdvanceCursorExpected =
  | { status: 'absent' }
  | { status: 'present'; deliveredOrdinal: number };

export type AdvanceCursorResult =
  | { advanced: true; cursor: Extract<ConversationCursorView, { status: 'present' }> }
  | {
      advanced: false;
      reason: 'cas_mismatch' | 'regression' | 'beyond_tail';
      cursor: ConversationCursorView;
      /** Reconciled journal tail when reason is beyond_tail (0 if no observations). */
      tailOrdinal?: number;
    };

/** Agent-wide observation continuity (fail-closed signal for later send hold). */
export const ObservationContinuitySchema = z.object({
  lastFailureAt: z.string().optional(),
  lastFailureEventId: z.string().optional(),
  lastFailureMessage: z.string().optional(),
  lastFailureSurfaceId: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  status: z.enum(['ok', 'degraded']),
  updatedAt: z.string().min(1),
});

export type ObservationContinuity = z.infer<typeof ObservationContinuitySchema>;

export interface ObserveSlackMessageInput {
  botId?: string;
  channelId: string;
  files?: ObservedFileDescriptor[];
  messageTs: string;
  /** ISO time derived from Slack ts when available. */
  receivedAt?: string;
  teamId: string;
  text: string;
  /** Thread parent ts for replies only; omit for top-level / DM root. */
  threadTs?: string;
  userId?: string;
}

export type ObserveSlackMessageResult =
  | { appended: true; entry: ObservedConversationEntry }
  | { appended: false; reason: 'duplicate'; entry?: ObservedConversationEntry };

export function observedConversationsDir(agentId: string): string {
  return join(agentsDir(), agentId, 'observed-conversations');
}

/** Stable filesystem key for a surface id (no path separators / nulls). */
export function observedConversationFileStem(surfaceId: string): string {
  return safeFilename(surfaceId.replaceAll(':', '_'));
}

/**
 * Explicit top-level vs thread partition: only true replies (thread_ts set and
 * different from the message ts) join a thread surface. Channel parents and
 * DM roots stay on the unthreaded surface.
 */
export function conversationThreadTs(input: {
  messageTs: string;
  threadTs?: string;
}): string | undefined {
  const threadTs = input.threadTs?.trim();
  if (!threadTs) return undefined;
  if (threadTs === input.messageTs) return undefined;
  return threadTs;
}

export function surfaceIdForObservation(input: {
  channelId: string;
  messageTs: string;
  teamId: string;
  threadTs?: string;
}): string {
  const threadTs = conversationThreadTs({
    messageTs: input.messageTs,
    threadTs: input.threadTs,
  });
  return slackSurfaceId({
    channelId: input.channelId,
    teamId: input.teamId,
    ...(threadTs ? { threadTs } : {}),
  });
}

export function cursorViewFromRecord(
  surfaceId: string,
  record: ConversationCursorRecord,
): ConversationCursorView {
  if (record.deliveredOrdinal === null) {
    return { status: 'absent', surfaceId };
  }
  return {
    status: 'present',
    deliveredOrdinal: record.deliveredOrdinal,
    ...(record.lastDeliveredEventId ? { lastDeliveredEventId: record.lastDeliveredEventId } : {}),
    ...(record.lastDeliveredMessageTs
      ? { lastDeliveredMessageTs: record.lastDeliveredMessageTs }
      : {}),
    surfaceId,
    updatedAt: record.updatedAt,
  };
}

/** True when each row's ordinal is higher than the row before it. */
function ordinalsRise(rows: readonly ObservedConversationEntry[]): boolean {
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i]!.ordinal <= rows[i - 1]!.ordinal) return false;
  }
  return true;
}

/**
 * Rebuild journal-tail index from retained journal rows when the index lags
 * (append-then-index-write crash recovery).
 */
export function reconcileIndexFromJournal(
  current: ConversationIndex,
  recent: ObservedConversationEntry[],
  surfaceId: string,
): ConversationIndex {
  if (recent.length === 0) return current;
  let maxEntry = recent[0]!;
  for (const row of recent) {
    if (row.ordinal >= maxEntry.ordinal) maxEntry = row;
  }
  if (maxEntry.ordinal <= current.tailOrdinal) return current;
  return {
    lastEventId: maxEntry.eventId,
    lastMessageTs: maxEntry.messageTs,
    surfaceId,
    tailOrdinal: maxEntry.ordinal,
    updatedAt: nowIso(),
  };
}

export interface ObservedConversationStoreOptions {
  /** Journal rotation size; tests may pass a tiny value. */
  maxBytes?: number;
  maxArchives?: number;
}

export class ObservedConversationStore {
  constructor(
    private readonly agentId: string,
    private readonly options: ObservedConversationStoreOptions = {},
  ) {}

  /**
   * Record one Slack message observation. Idempotent on eventId within the
   * conversation. Reconciles a stale index from the journal before assigning
   * a new ordinal (crash recovery).
   */
  async observe(input: ObserveSlackMessageInput): Promise<ObserveSlackMessageResult> {
    if (!input.userId && !input.botId) {
      throw new Error('observe requires userId and/or botId');
    }
    const threadTs = conversationThreadTs({
      messageTs: input.messageTs,
      threadTs: input.threadTs,
    });
    const surfaceId = slackSurfaceId({
      channelId: input.channelId,
      teamId: input.teamId,
      ...(threadTs ? { threadTs } : {}),
    });
    const eventId = slackMessageEventId(input.teamId, input.channelId, input.messageTs);
    const writeRoot = currentWriteRoot();
    const indexStore = this.indexStore(surfaceId);
    const journal = this.journal(surfaceId);

    // Serialize on the index file lock (JsonStore.update). Do not nest
    // withFileLock on the same path — that deadlocks via inProcessLocks.
    let outcome: ObserveSlackMessageResult | undefined;
    try {
      await indexStore.update(async (current) => {
        // The index names an event only after its row is in the journal, so a
        // repeat of the newest event (Slack's message + app_mention pair, the
        // pre-drain backfill) needs no journal read.
        if (current.tailOrdinal > 0 && current.lastEventId === eventId) {
          outcome = { appended: false, reason: 'duplicate' };
          return current;
        }
        const recent = await journal.readTail(OBSERVED_CONVERSATION_DEDUPE_RECENT);
        const reconciled = reconcileIndexFromJournal(current, recent, surfaceId);

        // Fast path: reconciled tail already points at this event.
        if (reconciled.tailOrdinal > 0 && reconciled.lastEventId === eventId) {
          outcome = { appended: false, reason: 'duplicate' };
          return reconciled;
        }
        // Dedupe against journal (covers non-tail duplicates + crash recovery).
        const existing = recent.find((row) => row.eventId === eventId);
        if (existing) {
          // Index may still lag the row we found; keep reconciled (journal max).
          outcome = { appended: false, reason: 'duplicate', entry: existing };
          return reconciled;
        }

        const ordinal = reconciled.tailOrdinal + 1;
        const entry: ObservedConversationEntry = ObservedConversationEntrySchema.parse({
          ...(input.botId ? { botId: input.botId } : {}),
          channelId: input.channelId,
          eventId,
          ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
          messageTs: input.messageTs,
          observedAt: nowIso(),
          ordinal,
          receivedAt: input.receivedAt ?? nowIso(),
          surfaceId,
          teamId: input.teamId,
          text: input.text,
          ...(threadTs ? { threadTs } : {}),
          ...(input.userId ? { userId: input.userId } : {}),
        });

        await ensureParentDirectory(this.journalPath(surfaceId), writeRoot);
        // Journal lock is a different path; safe under the index lock.
        await journal.append(entry);
        outcome = { appended: true, entry };
        return {
          lastEventId: eventId,
          lastMessageTs: input.messageTs,
          surfaceId,
          tailOrdinal: ordinal,
          updatedAt: entry.observedAt,
        };
      });
    } catch (error) {
      await this.markDegradedSafe({
        eventId,
        message: error instanceof Error ? error.message : String(error),
        surfaceId,
      });
      throw error;
    }

    if (!outcome) {
      const err = new Error(`observed-conversation observe produced no result for ${eventId}`);
      await this.markDegradedSafe({ eventId, message: err.message, surfaceId });
      throw err;
    }
    // Continuity is sticky: ordinary success never clears `degraded` and does
    // not rewrite continuity.json. Cut (a) exposes only getContinuity + degrade;
    // authorized repair/reset lands later with an operational seam that can
    // require evidence and record audit activity.
    return outcome;
  }

  async getIndex(surfaceId: string): Promise<ConversationIndex | undefined> {
    const index = await this.indexStore(surfaceId).read();
    if (index.tailOrdinal <= 0 || !index.lastEventId) return undefined;
    return index;
  }

  /**
   * Read journal-tail index, reconciling from the retained journal when the
   * stored index lags (same recovery path as observe).
   */
  async getIndexReconciled(surfaceId: string): Promise<ConversationIndex | undefined> {
    const indexStore = this.indexStore(surfaceId);
    let result: ConversationIndex | undefined;
    await indexStore.update(async (current) => {
      const reconciled = await this.reconcileWithJournal(surfaceId, current);
      result = reconciled.tailOrdinal > 0 && reconciled.lastEventId ? reconciled : undefined;
      return reconciled;
    });
    return result;
  }

  /**
   * Consistent cursor-delivery snapshot for one surface.
   *
   * Runs under the same index lock as `observe`, so a concurrent append cannot
   * land between the captured tail and the journal rows. Candidates are filtered
   * through the captured tail (`afterOrdinal < ordinal <= capturedTail`); the
   * exact candidate population is `capturedTail − afterOrdinal` when the index
   * is present.
   *
   * Bounded read: under the lock it reads only the newest
   * `min(limit, capturedTail − afterOrdinal)` rows plus the order-check rows,
   * and the full dedupe window only when their ordinals do not rise (see
   * OBSERVED_CONVERSATION_ORDER_CHECK_ROWS). Never a full retained-history
   * parse (archives can be tens of MiB per surface).
   */
  async readCursorDeliverySnapshot(
    surfaceId: string,
    options: { afterOrdinal?: number; limit?: number } = {},
  ): Promise<{
    index: ConversationIndex | undefined;
    candidates: ObservedConversationEntry[];
    /** Captured reconciled tail (0 when empty). */
    capturedTailOrdinal: number;
  }> {
    const afterOrdinal = options.afterOrdinal ?? 0;
    const limit = options.limit ?? 100;
    let snapshot: {
      index: ConversationIndex | undefined;
      candidates: ObservedConversationEntry[];
      capturedTailOrdinal: number;
    } | undefined;
    await this.indexStore(surfaceId).update(async (current) => {
      // Bounded reads under the lock. observe() also holds this lock around
      // journal.append + index write, so concurrent appends cannot interleave.
      const { reconciled, recent } = await this.snapshotRows(surfaceId, current, afterOrdinal, limit);
      const capturedTailOrdinal = reconciled.tailOrdinal;
      const index =
        capturedTailOrdinal > 0 && reconciled.lastEventId ? reconciled : undefined;
      if (limit <= 0) {
        snapshot = { index, candidates: [], capturedTailOrdinal };
        return reconciled;
      }
      // Bound both ends: after the delivered cursor, and not past the captured tail.
      // Rows observed after this snapshot (or with ordinal > capturedTail) are excluded.
      const filtered = recent.filter(
        (row) => row.ordinal > afterOrdinal && row.ordinal <= capturedTailOrdinal,
      );
      const candidates = filtered.length <= limit
        ? filtered
        : filtered.slice(filtered.length - limit);
      snapshot = { index, candidates, capturedTailOrdinal };
      return reconciled;
    });
    return snapshot ?? {
      index: undefined,
      candidates: [],
      capturedTailOrdinal: 0,
    };
  }

  async readJournal(
    surfaceId: string,
    options: { afterOrdinal?: number; limit?: number } = {},
  ): Promise<ObservedConversationEntry[]> {
    const limit = options.limit ?? 100;
    if (limit <= 0) return [];
    const all = await this.journal(surfaceId).readAll();
    const filtered = options.afterOrdinal === undefined
      ? all
      : all.filter((row) => row.ordinal > options.afterOrdinal!);
    if (filtered.length <= limit) return filtered;
    return filtered.slice(filtered.length - limit);
  }

  async readTail(surfaceId: string, limit: number): Promise<ObservedConversationEntry[]> {
    if (limit <= 0) return [];
    return this.journal(surfaceId).readTail(limit);
  }

  /**
   * The row for `eventId` among the newest `newest` journal rows. Undefined
   * when it is not there, when those rows and the order-check rows reach an
   * archive, or when their ordinals do not rise; the caller then searches a
   * wider window. A second row for an event comes from an observer that missed
   * the first, so the rows between break the rise, and a hit is the row a
   * wider search finds first. The exception is a resumed append that lands in
   * an archive after newer rows: then the hit is the event's later row, whose
   * ordinal is higher.
   */
  async findAmongNewest(
    surfaceId: string,
    eventId: string,
    newest: number,
  ): Promise<ObservedConversationEntry | undefined> {
    const count = newest + OBSERVED_CONVERSATION_ORDER_CHECK_ROWS;
    const rows = await this.journal(surfaceId).readLiveTail(count);
    if (!rows || !ordinalsRise(rows)) return undefined;
    // Fewer rows than asked for is the whole journal: no older row exists.
    const searched = rows.length < count ? rows : rows.slice(OBSERVED_CONVERSATION_ORDER_CHECK_ROWS);
    return searched.find((row) => row.eventId === eventId);
  }

  // --- Delivered cursor (independent of journal tail) ---

  async getCursor(surfaceId: string): Promise<ConversationCursorView> {
    const record = await this.cursorStore(surfaceId).read();
    return cursorViewFromRecord(surfaceId, record);
  }

  /**
   * Monotonic CAS advance of the delivered cursor.
   *
   * - `expected` must match the current absent/present+ordinal view.
   * - `nextDeliveredOrdinal` must be >= 0; if current is present, next must be
   *   >= current.deliveredOrdinal (regression otherwise).
   * - Fail-closed against the journal: next must be <= reconciled journal tail.
   *   The only allowed advance with no observed rows is present@0 (thread-root
   *   establishment). Anything above tail returns `beyond_tail`.
   */
  async advanceCursor(input: {
    expected: AdvanceCursorExpected;
    lastDeliveredEventId?: string;
    lastDeliveredMessageTs?: string;
    nextDeliveredOrdinal: number;
    surfaceId: string;
  }): Promise<AdvanceCursorResult> {
    if (!Number.isInteger(input.nextDeliveredOrdinal) || input.nextDeliveredOrdinal < 0) {
      throw new Error(`nextDeliveredOrdinal must be a non-negative integer, got ${input.nextDeliveredOrdinal}`);
    }
    const store = this.cursorStore(input.surfaceId);
    let result: AdvanceCursorResult | undefined;
    await store.update(async (current) => {
      const view = cursorViewFromRecord(input.surfaceId, current);
      if (!cursorExpectationMatches(view, input.expected)) {
        result = { advanced: false, reason: 'cas_mismatch', cursor: view };
        return current;
      }
      if (view.status === 'present' && input.nextDeliveredOrdinal < view.deliveredOrdinal) {
        result = { advanced: false, reason: 'regression', cursor: view };
        return current;
      }

      // Cap against reconciled journal tail (index + retained journal rows).
      const index = await this.indexStore(input.surfaceId).read();
      const reconciled = await this.reconcileWithJournal(input.surfaceId, index);
      const tailOrdinal = reconciled.tailOrdinal;
      // present@0 is the only establishment with an empty journal.
      if (input.nextDeliveredOrdinal > tailOrdinal) {
        result = {
          advanced: false,
          reason: 'beyond_tail',
          cursor: view,
          tailOrdinal,
        };
        return current;
      }

      const updatedAt = nowIso();
      const next: ConversationCursorRecord = {
        deliveredOrdinal: input.nextDeliveredOrdinal,
        surfaceId: input.surfaceId,
        updatedAt,
        ...(input.lastDeliveredEventId
          ? { lastDeliveredEventId: input.lastDeliveredEventId }
          : current.lastDeliveredEventId
            ? { lastDeliveredEventId: current.lastDeliveredEventId }
            : {}),
        ...(input.lastDeliveredMessageTs
          ? { lastDeliveredMessageTs: input.lastDeliveredMessageTs }
          : current.lastDeliveredMessageTs
            ? { lastDeliveredMessageTs: current.lastDeliveredMessageTs }
            : {}),
      };
      const present = cursorViewFromRecord(input.surfaceId, next) as Extract<
        ConversationCursorView,
        { status: 'present' }
      >;
      result = { advanced: true, cursor: present };
      return next;
    });
    if (!result) {
      throw new Error(`advanceCursor produced no result for ${input.surfaceId}`);
    }
    return result;
  }

  // --- Continuity (agent-wide observation health) ---

  async getContinuity(): Promise<ObservationContinuity> {
    return this.continuityStore().read();
  }

  // No public clear/repair on cut (a). Degraded sticks until a later operational
  // seam can require evidence and emit audit activity. Tests plant state via
  // markDegraded only.

  async markDegraded(input: {
    eventId?: string;
    message: string;
    surfaceId?: string;
  }): Promise<ObservationContinuity> {
    const at = nowIso();
    return this.continuityStore().update((current) => ({
      status: 'degraded' as const,
      updatedAt: at,
      lastFailureAt: at,
      lastFailureMessage: input.message.slice(0, 500),
      ...(input.eventId ? { lastFailureEventId: input.eventId } : {}),
      ...(input.surfaceId ? { lastFailureSurfaceId: input.surfaceId } : {}),
      ...(current.lastSuccessAt ? { lastSuccessAt: current.lastSuccessAt } : {}),
    }));
  }

  /** Best-effort: never mask the observation error with a continuity write error. */
  private async markDegradedSafe(input: {
    eventId?: string;
    message: string;
    surfaceId?: string;
  }): Promise<void> {
    try {
      await this.markDegraded(input);
    } catch (error) {
      console.warn(
        `observed-conversation continuity markDegraded failed for agent=${this.agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Test/recovery helper: force-write journal-tail index without observing. */
  async writeIndexForTest(index: ConversationIndex): Promise<void> {
    await this.indexStore(index.surfaceId).write(index);
  }

  /** Test/recovery helper: force-write delivered cursor without advanceCursor CAS. */
  async writeCursorForTest(record: ConversationCursorRecord): Promise<void> {
    await this.cursorStore(record.surfaceId).write(record);
  }

  /**
   * The newest `needed` journal rows plus the order-check rows. Undefined when
   * they reach an archive, their ordinals do not rise, or the newest is behind
   * the index; the caller then reads the full dedupe window.
   */
  private async newestRowsInOrder(
    surfaceId: string,
    index: ConversationIndex,
    needed: number,
  ): Promise<ObservedConversationEntry[] | undefined> {
    const rows = await this.journal(surfaceId).readLiveTail(needed + OBSERVED_CONVERSATION_ORDER_CHECK_ROWS);
    if (!rows || !ordinalsRise(rows)) return undefined;
    if ((rows.at(-1)?.ordinal ?? 0) < index.tailOrdinal) return undefined;
    return rows;
  }

  /** Reconcile `index` from the newest rows, or from the full dedupe window when they do not rise. */
  private async reconcileWithJournal(surfaceId: string, index: ConversationIndex): Promise<ConversationIndex> {
    const rows = await this.newestRowsInOrder(surfaceId, index, 0)
      ?? await this.journal(surfaceId).readTail(OBSERVED_CONVERSATION_DEDUPE_RECENT);
    return reconcileIndexFromJournal(index, rows, surfaceId);
  }

  /**
   * Rows for a cursor snapshot and the tail they reconcile to. While ordinals
   * rise, the newest `min(limit, tail − afterOrdinal)` rows hold every
   * candidate. Otherwise read `max(limit, dedupe window)` rows, as before.
   */
  private async snapshotRows(
    surfaceId: string,
    current: ConversationIndex,
    afterOrdinal: number,
    limit: number,
  ): Promise<{ reconciled: ConversationIndex; recent: ObservedConversationEntry[] }> {
    const needed = (tail: number) => Math.max(0, Math.min(limit, tail - afterOrdinal));
    let want = needed(current.tailOrdinal);
    // Reconcile can raise the tail above the index (an append whose index write
    // did not land). Then read again for the wider window.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recent = await this.newestRowsInOrder(surfaceId, current, want);
      if (!recent) break;
      const reconciled = reconcileIndexFromJournal(current, recent, surfaceId);
      const wholeJournal = recent.length < want + OBSERVED_CONVERSATION_ORDER_CHECK_ROWS;
      if (wholeJournal || needed(reconciled.tailOrdinal) <= want) return { reconciled, recent };
      want = needed(reconciled.tailOrdinal);
    }
    const recent = await this.journal(surfaceId).readTail(Math.max(limit, OBSERVED_CONVERSATION_DEDUPE_RECENT));
    const reconcileWindow = recent.length <= OBSERVED_CONVERSATION_DEDUPE_RECENT
      ? recent
      : recent.slice(recent.length - OBSERVED_CONVERSATION_DEDUPE_RECENT);
    return { reconciled: reconcileIndexFromJournal(current, reconcileWindow, surfaceId), recent };
  }

  private journal(surfaceId: string): JsonlAppendLog<ObservedConversationEntry> {
    const path = this.journalPath(surfaceId);
    const root = observedConversationsDir(this.agentId);
    return new JsonlAppendLog<ObservedConversationEntry>(path, {
      archiveDir: join(root, 'archive', observedConversationFileStem(surfaceId)),
      maxArchives: this.options.maxArchives ?? OBSERVED_CONVERSATION_MAX_ARCHIVES,
      maxBytes: this.options.maxBytes ?? DEFAULT_JSONL_ROTATE_BYTES,
    });
  }

  private indexStore(surfaceId: string): JsonStore<ConversationIndex> {
    return new JsonStore<ConversationIndex>({
      empty: () => ({
        lastEventId: '',
        lastMessageTs: '',
        surfaceId,
        tailOrdinal: 0,
        updatedAt: nowIso(),
      }),
      parse: (value) => ConversationIndexSchema.parse(value),
      path: () => this.indexPath(surfaceId),
    });
  }

  private cursorStore(surfaceId: string): JsonStore<ConversationCursorRecord> {
    return new JsonStore<ConversationCursorRecord>({
      empty: () => ({
        deliveredOrdinal: null,
        surfaceId,
        updatedAt: nowIso(),
      }),
      parse: (value) => ConversationCursorRecordSchema.parse(value),
      path: () => this.cursorPath(surfaceId),
    });
  }

  private continuityStore(): JsonStore<ObservationContinuity> {
    return new JsonStore<ObservationContinuity>({
      empty: () => ({
        status: 'ok',
        updatedAt: nowIso(),
      }),
      parse: (value) => ObservationContinuitySchema.parse(value),
      path: () => this.continuityPath(),
    });
  }

  private journalPath(surfaceId: string): string {
    return join(observedConversationsDir(this.agentId), `${observedConversationFileStem(surfaceId)}.jsonl`);
  }

  private indexPath(surfaceId: string): string {
    return join(observedConversationsDir(this.agentId), `${observedConversationFileStem(surfaceId)}.index.json`);
  }

  private cursorPath(surfaceId: string): string {
    return join(observedConversationsDir(this.agentId), `${observedConversationFileStem(surfaceId)}.cursor.json`);
  }

  private continuityPath(): string {
    // Sibling of observed-conversations/ so a blocked journal directory still
    // allows fail-closed continuity to be recorded and queried after restart.
    return join(agentsDir(), this.agentId, 'observation-continuity.json');
  }
}

function cursorExpectationMatches(
  view: ConversationCursorView,
  expected: AdvanceCursorExpected,
): boolean {
  if (expected.status === 'absent') return view.status === 'absent';
  return view.status === 'present' && view.deliveredOrdinal === expected.deliveredOrdinal;
}

export function observedConversationStoreForAgent(agentId: string): ObservedConversationStore {
  return new ObservedConversationStore(agentId);
}
