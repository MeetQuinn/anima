// Agent-scoped observed-conversation journal + per-conversation index.
//
// Cut (a) of send-hold/cursor-view: record every routable Slack message the
// agent process sees at ingress, before wake/subscription filtering. Feature is
// inert (no prompt/hold/queue changes). Key: slackSurfaceId(teamId, channelId, threadTs?).
//
// Layout under agents/<agentId>/observed-conversations/:
//   <safeSurfaceId>.jsonl   — append-only journal for one conversation
//   <safeSurfaceId>.index.json — { surfaceId, tailOrdinal, lastEventId, ... }
//
// Each observation is locked on the index path so ordinal/tail and journal
// append stay consistent.

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

export const ObservedConversationEntrySchema = z.object({
  botId: z.string().optional(),
  channelId: z.string().min(1),
  eventId: z.string().min(1),
  messageTs: z.string().min(1),
  observedAt: z.string().min(1),
  ordinal: z.number().int().positive(),
  receivedAt: z.string().min(1),
  surfaceId: z.string().min(1),
  teamId: z.string().min(1),
  text: z.string(),
  threadTs: z.string().optional(),
  userId: z.string().min(1),
});

export type ObservedConversationEntry = z.infer<typeof ObservedConversationEntrySchema>;

export const ConversationIndexSchema = z.object({
  // Empty strings are valid for a never-written index (JsonStore.empty).
  lastEventId: z.string(),
  lastMessageTs: z.string(),
  surfaceId: z.string().min(1),
  tailOrdinal: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
});

export type ConversationIndex = z.infer<typeof ConversationIndexSchema>;

export interface ObserveSlackMessageInput {
  botId?: string;
  channelId: string;
  messageTs: string;
  /** ISO time derived from Slack ts when available. */
  receivedAt?: string;
  teamId: string;
  text: string;
  /** Thread parent ts for replies only; omit for top-level / DM root. */
  threadTs?: string;
  userId: string;
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
   * conversation. Returns whether a new ordinal was assigned.
   */
  async observe(input: ObserveSlackMessageInput): Promise<ObserveSlackMessageResult> {
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
    await indexStore.update(async (current) => {
      // Fast path: last written event matches.
      if (current.tailOrdinal > 0 && current.lastEventId === eventId) {
        outcome = { appended: false, reason: 'duplicate' };
        return current;
      }
      // Dedupe against recent journal (covers non-tail duplicates after rotation).
      const recent = await journal.readTail(OBSERVED_CONVERSATION_DEDUPE_RECENT);
      const existing = recent.find((row) => row.eventId === eventId);
      if (existing) {
        outcome = { appended: false, reason: 'duplicate', entry: existing };
        return current;
      }

      const ordinal = current.tailOrdinal + 1;
      const entry: ObservedConversationEntry = ObservedConversationEntrySchema.parse({
        ...(input.botId ? { botId: input.botId } : {}),
        channelId: input.channelId,
        eventId,
        messageTs: input.messageTs,
        observedAt: nowIso(),
        ordinal,
        receivedAt: input.receivedAt ?? nowIso(),
        surfaceId,
        teamId: input.teamId,
        text: input.text,
        ...(threadTs ? { threadTs } : {}),
        userId: input.userId,
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

    if (!outcome) {
      throw new Error(`observed-conversation observe produced no result for ${eventId}`);
    }
    return outcome;
  }

  async getIndex(surfaceId: string): Promise<ConversationIndex | undefined> {
    const index = await this.indexStore(surfaceId).read();
    if (index.tailOrdinal <= 0 || !index.lastEventId) return undefined;
    return index;
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

  private journalPath(surfaceId: string): string {
    return join(observedConversationsDir(this.agentId), `${observedConversationFileStem(surfaceId)}.jsonl`);
  }

  private indexPath(surfaceId: string): string {
    return join(observedConversationsDir(this.agentId), `${observedConversationFileStem(surfaceId)}.index.json`);
  }
}

export function observedConversationStoreForAgent(agentId: string): ObservedConversationStore {
  return new ObservedConversationStore(agentId);
}
