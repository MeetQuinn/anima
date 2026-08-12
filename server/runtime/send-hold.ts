// Cut (c): pre-commit send hold on the three irreversible Slack post paths.
//
// Same flag as cursor delivery (`cursorDelivery.enabled`) so view + hold enable
// atomically. Hold runs outside withToolActivity(effectType) — HELD is a local
// completed activity with status:held, never an external.effect / outbox row.
// Confirmed-absent cursor lands without hold; store errors fail closed.
//
// Delivery before consume: stdout is written before cursor advance so a failed
// outcome never proves the delta was delivered.

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
 * After-cursor index population that the retained window must fully cover
 * before we can claim "no foreign movement" / exact non-own counts.
 */
export function afterCursorIndexPopulation(
  afterOrdinal: number,
  tailOrdinal: number,
): number {
  return Math.max(0, tailOrdinal - afterOrdinal);
}

/**
 * Compare cursor vs local observed ledger for one outbound Slack post surface.
 * Does not perform the irreversible Slack op.
 *
 * On held: writes stdout first, then records activity, then advances cursor —
 * a failed write/outcome never consumes the undelivered delta.
 */
export async function evaluateSendHold(input: {
  agentId: string;
  teamId: string;
  channelId: string;
  threadTs?: string;
  tool: SendHoldTool;
  botUserId?: string;
  botId?: string;
  store?: ObservedConversationStore;
  writeOutput?: (line: string) => void;
}): Promise<EvaluateSendHoldResult> {
  const enabled = await resolveCursorDeliveryEnabled();
  if (enabled.kind === 'disabled') return { kind: 'disabled' };
  if (enabled.kind === 'error') {
    throw new SendHoldError('store_error', enabled.error.message);
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
    // One locked snapshot: candidates + captured tail must not be paired with a
    // separate earlier getIndexReconciled() observation (concurrent append race).
    const snapshot = await store.readCursorDeliverySnapshot(surfaceId, {
      afterOrdinal,
      limit: 5_000,
    });
    const tail = snapshot.index?.tailOrdinal ?? snapshot.capturedTailOrdinal;
    if (cursor.deliveredOrdinal > tail) {
      throw new SendHoldError(
        'store_error',
        `cursor deliveredOrdinal ${cursor.deliveredOrdinal} beyond reconciled tail ${tail} on ${surfaceId}`,
      );
    }

    const indexAfter = afterCursorIndexPopulation(afterOrdinal, tail);
    // Capped/archived retained window must cover every after-cursor ordinal
    // against *this* captured tail; otherwise ownership of omitted slots is
    // unknown → never false-allow.
    if (indexAfter > 0 && snapshot.candidates.length < indexAfter) {
      throw new SendHoldError(
        'store_error',
        `send-hold retained window incomplete on ${surfaceId}: index after-cursor population ${indexAfter}, retained ${snapshot.candidates.length}`,
      );
    }

    const self = { botUserId: input.botUserId, botId: input.botId };
    const nonOwn = snapshot.candidates
      .filter((row) => !isOwnObservedEntry(row, self))
      .sort(compareByConversationTime);

    if (nonOwn.length === 0) return { kind: 'allow' };

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

    const last = nonOwn[nonOwn.length - 1]!;
    const advancedToOrdinal = last.ordinal;

    // 1) Deliver HELD copy first — failed write must not consume the delta.
    const write = input.writeOutput ?? console.log;
    write(stdout);

    // 2) Local completed activity only — never external.effect / outbox.
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

    // 3) Advance cursor only after the agent has received the HELD outcome.
    const advance = await store.advanceCursor({
      surfaceId,
      expected: { status: 'present', deliveredOrdinal: cursor.deliveredOrdinal },
      nextDeliveredOrdinal: advancedToOrdinal,
      lastDeliveredEventId: last.eventId,
      lastDeliveredMessageTs: last.messageTs,
    });
    if (!advance.advanced) {
      const live = await store.getCursor(surfaceId);
      if (
        !(
          live.status === 'present'
          && live.deliveredOrdinal >= advancedToOrdinal
        )
      ) {
        throw new SendHoldError(
          'cas_failure',
          `send-hold cursor advance failed for ${surfaceId}: ${advance.reason}`,
        );
      }
    }

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
    // writeOutput / unexpected throws: do not wrap as if we held successfully.
    if (error instanceof Error && !(error instanceof SendHoldError)) {
      // Preserve original error for stdout failures so callers see the real cause.
      throw error;
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
 * Call immediately after the irreversible Slack response returns a ts.
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
    console.warn(
      `observeOwnOutboundPost failed for agent=${input.agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Best-effort message ts from Slack files.info `shares` (channel share stamp).
 * completeUploadExternal does not return a conversation message_ts.
 */
export function messageTsFromSlackFileInfo(
  info: {
    shares?: {
      public?: Record<string, Array<{ ts?: string }>>;
      private?: Record<string, Array<{ ts?: string }>>;
    };
  } | undefined,
  channelId: string,
): string | undefined {
  if (!info?.shares) return undefined;
  const from = (bucket?: Record<string, Array<{ ts?: string }>>) => {
    const rows = bucket?.[channelId];
    if (!rows?.length) return undefined;
    for (const row of rows) {
      if (row.ts && row.ts.trim()) return row.ts.trim();
    }
    return undefined;
  };
  return from(info.shares.public) ?? from(info.shares.private);
}
