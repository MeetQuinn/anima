// Cut (c): pre-commit send hold on the three irreversible Slack post paths.
//
// Same flag as cursor delivery (`cursorDelivery.enabled`) so view + hold enable
// atomically. Hold runs outside withToolActivity(effectType) — HELD is a local
// completed activity with status:held, never an external.effect / outbox row.
// Confirmed-absent cursor lands without hold; store errors fail closed.

import { activityServiceForAgent } from '../activities/activity.service.js';
import { slackSurfaceId } from '../ids.js';
import {
  observedConversationStoreForAgent,
  type ObservedConversationEntry,
  type ObservedConversationStore,
} from '../storage/schema/observed-conversation.store.js';
import {
  CURSOR_DELIVERY_MAX_BYTES,
  CURSOR_DELIVERY_MAX_MESSAGES,
  compareByConversationTime,
  resolveCursorDeliveryEnabled,
  selectNewestFittingForEnvelope,
  CursorDeliveryError,
} from './cursor-delivery.js';
import {
  type HeldNoun,
  renderHeldCopy,
} from './send-hold-copy.js';

export type SendHoldTool = 'anima.message.send' | 'anima.ask' | 'anima.file.send';

export type EvaluateSendHoldResult =
  | { kind: 'disabled' }
  | { kind: 'allow' }
  | {
      kind: 'held';
      /** Sole stdout outcome (Iris EN copy). */
      stdout: string;
      surfaceId: string;
      deltaCount: number;
      advancedToOrdinal: number;
    };

export class SendHoldError extends Error {
  readonly reason: 'store_error' | 'continuity_degraded' | 'cas_failure';
  constructor(reason: SendHoldError['reason'], message: string) {
    super(message);
    this.name = 'SendHoldError';
    this.reason = reason;
  }
}

function nounForTool(tool: SendHoldTool): HeldNoun {
  return tool === 'anima.file.send' ? 'file' : 'message';
}

/** True when the journal row is this agent's own bot identity. */
export function isOwnObservedEntry(
  entry: ObservedConversationEntry,
  self: { botUserId?: string; botId?: string },
): boolean {
  if (self.botUserId && entry.userId && entry.userId === self.botUserId) return true;
  if (self.botId && entry.botId && entry.botId === self.botId) return true;
  // Some journaled bot posts only carry userId = bot user id.
  if (self.botUserId && entry.botId && entry.botId === self.botUserId) return true;
  return false;
}

export function surfaceIdForOutbound(input: {
  teamId: string;
  channelId: string;
  threadTs?: string;
}): string {
  return slackSurfaceId({
    teamId: input.teamId,
    channelId: input.channelId,
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
  });
}

/**
 * Compare cursor vs local observed ledger for one outbound Slack post surface.
 * Does not perform the irreversible Slack op. On held: advances cursor to the
 * full non-own after-cursor tail and records a local held activity (no draft).
 */
export async function evaluateSendHold(input: {
  agentId: string;
  teamId: string;
  channelId: string;
  threadTs?: string;
  tool: SendHoldTool;
  /** Bot user id (U…) for excluding own posts from the stale set. */
  botUserId?: string;
  botId?: string;
  store?: ObservedConversationStore;
  writeOutput?: (line: string) => void;
}): Promise<EvaluateSendHoldResult> {
  const enabled = await resolveCursorDeliveryEnabled();
  if (enabled.kind === 'disabled') return { kind: 'disabled' };
  if (enabled.kind === 'error') {
    throw new SendHoldError(
      'store_error',
      enabled.error.message,
    );
  }

  const store = input.store ?? observedConversationStoreForAgent(input.agentId);
  const surfaceId = surfaceIdForOutbound({
    teamId: input.teamId,
    channelId: input.channelId,
    threadTs: input.threadTs,
  });

  try {
    const continuity = await store.getContinuity();
    if (continuity.status === 'degraded') {
      throw new SendHoldError(
        'continuity_degraded',
        `observation continuity is degraded for agent=${input.agentId}; send hold cannot run`,
      );
    }

    const cursor = await store.getCursor(surfaceId);
    // Confirmed-absent only: no view to be stale relative to → land.
    if (cursor.status === 'absent') return { kind: 'allow' };

    const afterOrdinal = cursor.deliveredOrdinal;
    // Fail closed if cursor is past the reconciled tail (same invariant as prepare).
    const index = await store.getIndexReconciled(surfaceId);
    const tail = index?.tailOrdinal ?? 0;
    if (cursor.deliveredOrdinal > tail) {
      throw new SendHoldError(
        'store_error',
        `cursor deliveredOrdinal ${cursor.deliveredOrdinal} beyond reconciled tail ${tail} on ${surfaceId}`,
      );
    }

    const snapshot = await store.readCursorDeliverySnapshot(surfaceId, {
      afterOrdinal,
      limit: 5_000,
    });
    const self = { botUserId: input.botUserId, botId: input.botId };
    const nonOwn = snapshot.candidates
      .filter((row) => !isOwnObservedEntry(row, self))
      .sort(compareByConversationTime);

    if (nonOwn.length === 0) return { kind: 'allow' };

    // Exact population for the HELD copy = non-own retained after cursor.
    // (Index population may include own posts; hold staleness is non-own only.)
    const totalNewCount = nonOwn.length;
    const selected = selectNewestFittingForEnvelope(nonOwn, {
      maxMessages: CURSOR_DELIVERY_MAX_MESSAGES,
      maxBytes: CURSOR_DELIVERY_MAX_BYTES,
      totalCandidates: totalNewCount,
    });
    const shown = selected.entries.sort(compareByConversationTime);
    const stdout = renderHeldCopy({
      totalNewCount,
      shown,
      noun: nounForTool(input.tool),
    });

    // Advance to the full non-own after-cursor tail (not only shown rows) so a
    // retry is a plain re-check; omitted rows were still "delivered" via marker.
    const last = nonOwn[nonOwn.length - 1]!;
    const advancedToOrdinal = last.ordinal;
    const advance = await store.advanceCursor({
      surfaceId,
      expected: { status: 'present', deliveredOrdinal: cursor.deliveredOrdinal },
      nextDeliveredOrdinal: advancedToOrdinal,
      lastDeliveredEventId: last.eventId,
      lastDeliveredMessageTs: last.messageTs,
    });
    if (!advance.advanced) {
      // Concurrent advance to same/later target is ok; anything else fails closed.
      const live = await store.getCursor(surfaceId);
      if (
        live.status === 'present'
        && live.deliveredOrdinal >= advancedToOrdinal
      ) {
        // proceed to held outcome
      } else {
        throw new SendHoldError(
          'cas_failure',
          `send-hold cursor advance failed for ${surfaceId}: ${advance.reason}`,
        );
      }
    }

    // Local completed activity only — never external.effect / outbox.
    await activityServiceForAgent(input.agentId).record({
      type: 'tool.call.completed',
      payload: {
        status: 'held',
        tool: input.tool,
        surfaceId,
        deltaCount: totalNewCount,
        advancedToOrdinal,
        // No draft text in storage (PRD).
      },
    });

    const write = input.writeOutput ?? console.log;
    write(stdout);

    return {
      kind: 'held',
      stdout,
      surfaceId,
      deltaCount: totalNewCount,
      advancedToOrdinal,
    };
  } catch (error) {
    if (error instanceof SendHoldError) throw error;
    if (error instanceof CursorDeliveryError) {
      throw new SendHoldError('store_error', error.message);
    }
    throw new SendHoldError(
      'store_error',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Append the agent's own successful post into the observed journal so a later
 * hold does not treat it as foreign room movement (ingress uses ignoreSelf).
 */
export async function observeOwnOutboundPost(input: {
  agentId: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  text: string;
  botUserId?: string;
  botId?: string;
  store?: ObservedConversationStore;
}): Promise<void> {
  if (!input.botUserId && !input.botId) {
    // Cannot journal without an actor id; skip rather than crash a successful send.
    console.warn(
      `observeOwnOutboundPost skipped: no bot identity for agent=${input.agentId}`,
    );
    return;
  }
  const store = input.store ?? observedConversationStoreForAgent(input.agentId);
  try {
    await store.observe({
      teamId: input.teamId,
      channelId: input.channelId,
      messageTs: input.messageTs,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      text: input.text,
      ...(input.botUserId ? { userId: input.botUserId } : {}),
      ...(input.botId ? { botId: input.botId } : {}),
    });
  } catch (error) {
    // Landing already succeeded; journal failure is diagnostic, not a rollback.
    console.warn(
      `observeOwnOutboundPost failed for agent=${input.agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
