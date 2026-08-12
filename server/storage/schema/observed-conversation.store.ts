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
 * - `deliveredOrdinal: N>0` → delivered through ordinal N inclusive.
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
    // not rewrite continuity.json (avoids a JSON write on every message). A
    // known gap remains fail-closed until explicit repairContinuity().
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
      const recent = await this.journal(surfaceId).readTail(OBSERVED_CONVERSATION_DEDUPE_RECENT);
      const reconciled = reconcileIndexFromJournal(current, recent, surfaceId);
      result = reconciled.tailOrdinal > 0 && reconciled.lastEventId ? reconciled : undefined;
      return reconciled;
    });
    return result;
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
      const recent = await this.journal(input.surfaceId).readTail(OBSERVED_CONVERSATION_DEDUPE_RECENT);
      const reconciled = reconcileIndexFromJournal(index, recent, input.surfaceId);
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

  /**
   * Explicit, auditable repair: clear degraded → ok.
   * Ordinary observe() must never call this — a later successful event does not
   * prove a prior gap was recovered.
   */
  async repairContinuity(input: { note?: string } = {}): Promise<ObservationContinuity> {
    const at = nowIso();
    return this.continuityStore().update((current) => ({
      status: 'ok' as const,
      lastSuccessAt: at,
      updatedAt: at,
      // Keep prior failure breadcrumbs for audit; status is the gate.
      ...(current.lastFailureAt ? { lastFailureAt: current.lastFailureAt } : {}),
      ...(current.lastFailureMessage
        ? {
            lastFailureMessage: input.note
              ? `${current.lastFailureMessage} | repaired: ${input.note}`.slice(0, 500)
              : current.lastFailureMessage,
          }
        : input.note
          ? { lastFailureMessage: `repaired: ${input.note}`.slice(0, 500) }
          : {}),
      ...(current.lastFailureEventId ? { lastFailureEventId: current.lastFailureEventId } : {}),
      ...(current.lastFailureSurfaceId ? { lastFailureSurfaceId: current.lastFailureSurfaceId } : {}),
    }));
  }

  /** @deprecated Prefer repairContinuity — name makes the explicit-repair seam obvious. */
  async markOk(): Promise<ObservationContinuity> {
    return this.repairContinuity();
  }

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
