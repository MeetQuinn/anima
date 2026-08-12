import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  afterCursorIndexPopulation,
  evaluateSendHold,
  isOwnObservedEntry,
  messageTsFromSlackFileInfo,
  observeOwnOutboundPost,
  SendHoldError,
} from '../runtime/send-hold.js';
import {
  exactEarlierMessagesMarker,
  renderHeldCopy,
  renderHeldCopyZh,
  unknownEarlierMessagesMarker,
} from '../runtime/send-hold-copy.js';
import {
  renderCursorDeliveryEnvelopeFromEntries,
  setCursorDeliveryEnabledForTests,
} from '../runtime/cursor-delivery.js';
import { ObservedConversationStore } from '../storage/schema/observed-conversation.store.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { withAnimaHome } from './anima-home.js';
import { defaultAgentConfig, writeAgentConfigs } from './helpers/harness.js';
import type { SlackInboxItem } from '../../shared/inbox.js';

async function withHoldStore<T>(
  body: (store: ObservedConversationStore, agentId: string) => Promise<T>,
): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-send-hold-'));
  setCursorDeliveryEnabledForTests(true);
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    return await withAnimaHome(stateDir, async () => {
      const store = new ObservedConversationStore('anima');
      return body(store, 'anima');
    });
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
    await rm(stateDir, { force: true, recursive: true });
  }
}

test('held copy EN matches Iris template (message + file noun)', () => {
  const shown = [
    {
      botId: undefined,
      channelId: 'C1',
      eventId: 'slack:T1:C1:1.0',
      messageTs: '1.0',
      observedAt: '2026-01-01T13:44:59.000Z',
      ordinal: 1,
      receivedAt: '2026-01-01T13:44:59.000Z',
      surfaceId: 'slack:T1:C1',
      teamId: 'T1',
      text: '1',
      userId: 'U_MILO',
    },
    {
      channelId: 'C1',
      eventId: 'slack:T1:C1:2.0',
      messageTs: '2.0',
      observedAt: '2026-01-01T13:45:20.000Z',
      ordinal: 2,
      receivedAt: '2026-01-01T13:45:20.000Z',
      surfaceId: 'slack:T1:C1',
      teamId: 'T1',
      text: '2',
      userId: 'U_TESS',
    },
  ] as const;

  const messageCopy = renderHeldCopy({
    totalNewCount: 2,
    shown: [...shown],
    noun: 'message',
  });
  assert.match(messageCopy, /^HELD: the conversation moved while you were composing\. 2 new messages arrived, so your message was not sent:/);
  assert.match(messageCopy, /\[@U_MILO 13:44:59\] 1/);
  assert.match(messageCopy, /\[@U_TESS 13:45:20\] 2/);
  assert.match(messageCopy, /Read them, then resend to post it \(revised or unchanged\)\. To stay silent, do nothing\./);
  assert.doesNotMatch(messageCopy, /blocked|rejected|failed/i);

  const fileCopy = renderHeldCopy({
    totalNewCount: 1,
    shown: [shown[0]],
    noun: 'file',
  });
  assert.match(fileCopy, /1 new message arrived, so your file was not sent:/);

  const zh = renderHeldCopyZh({
    totalNewCount: 2,
    shown: [...shown],
    noun: 'message',
  });
  assert.match(zh, /^HELD:你组稿期间会话有 2 条新消息/);
});

test('truncation markers match Iris exact/unknown forms', () => {
  assert.equal(exactEarlierMessagesMarker(2), '(+2 earlier messages not shown)');
  assert.equal(exactEarlierMessagesMarker(1), '(+1 earlier message not shown)');
  assert.equal(unknownEarlierMessagesMarker(), '(earlier messages not shown)');
});

test('held copy places earlier-omitted marker above shown rows', () => {
  const older = {
    channelId: 'C1',
    eventId: 'slack:T1:C1:1.0',
    messageTs: '1.0',
    observedAt: '2026-01-01T13:40:00.000Z',
    ordinal: 1,
    receivedAt: '2026-01-01T13:40:00.000Z',
    surfaceId: 'slack:T1:C1',
    teamId: 'T1',
    text: 'old',
    userId: 'U_A',
  };
  const newer = {
    channelId: 'C1',
    eventId: 'slack:T1:C1:2.0',
    messageTs: '2.0',
    observedAt: '2026-01-01T13:45:00.000Z',
    ordinal: 2,
    receivedAt: '2026-01-01T13:45:00.000Z',
    surfaceId: 'slack:T1:C1',
    teamId: 'T1',
    text: 'new',
    userId: 'U_B',
  };
  // Shown is newest-fitting only; totalNewCount includes omitted earlier.
  const en = renderHeldCopy({
    totalNewCount: 5,
    shown: [newer],
    noun: 'message',
  });
  const enLines = en.split('\n');
  const markerIdx = enLines.findIndex((l) => l.includes('earlier message'));
  const rowIdx = enLines.findIndex((l) => l.includes('] new'));
  assert.ok(markerIdx >= 0 && rowIdx >= 0);
  assert.ok(markerIdx < rowIdx, `marker should be above shown rows: ${en}`);

  const zh = renderHeldCopyZh({
    totalNewCount: 5,
    shown: [newer],
    noun: 'message',
  });
  const zhLines = zh.split('\n');
  const zhMarker = zhLines.findIndex((l) => l.includes('更早消息'));
  const zhRow = zhLines.findIndex((l) => l.includes('] new'));
  assert.ok(zhMarker >= 0 && zhRow >= 0);
  assert.ok(zhMarker < zhRow, `ZH marker above rows: ${zh}`);
  void older;
});

test('gate-off: evaluateSendHold returns disabled / allow without comparing', async () => {
  setCursorDeliveryEnabledForTests(false);
  try {
    const result = await evaluateSendHold({
      agentId: 'anima',
      teamId: 'T1',
      channelId: 'C1',
      tool: 'anima.message.send',
    });
    assert.equal(result.kind, 'disabled');
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
  }
});

test('absent cursor lands without hold', async () => {
  await withHoldStore(async (store, agentId) => {
    const result = await evaluateSendHold({
      agentId,
      teamId: 'T1',
      channelId: 'C1',
      tool: 'anima.message.send',
      botUserId: 'U_BOT',
      store,
    });
    assert.equal(result.kind, 'allow');
  });
});

test('stale room holds, advances cursor, sole stdout is HELD copy', async () => {
  await withHoldStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '10.0',
      text: 'topic',
      userId: 'U_ROOT',
    });
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:10.0',
      lastDeliveredMessageTs: '10.0',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '11.0',
      text: '1',
      userId: 'U_MILO',
      receivedAt: '2026-01-01T13:44:59.000Z',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '12.0',
      text: '2',
      userId: 'U_TESS',
      receivedAt: '2026-01-01T13:45:20.000Z',
    });

    const lines: string[] = [];
    const result = await evaluateSendHold({
      agentId,
      teamId: 'T1',
      channelId: 'C1',
      tool: 'anima.message.send',
      botUserId: 'U_BOT',
      store,
      writeOutput: (line) => lines.push(line),
    });
    assert.equal(result.kind, 'held');
    if (result.kind !== 'held') return;
    assert.equal(result.deltaCount, 2);
    assert.equal(result.advancedToOrdinal, 3);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], result.stdout);
    assert.match(result.stdout, /^HELD:/);
    assert.match(result.stdout, /your message was not sent/);

    const cursor = await store.getCursor('slack:T1:C1');
    assert.equal(cursor.status, 'present');
    if (cursor.status === 'present') {
      assert.equal(cursor.deliveredOrdinal, 3);
    }

    // Held activity recorded locally (no draft text).
    const activities = await activityServiceForAgent(agentId).readLastN(5);
    const held = activities.find((a) => a.payload?.['status'] === 'held');
    assert.ok(held, 'expected held activity');
    assert.equal(held!.type, 'tool.call.completed');
    assert.equal(held!.payload?.['tool'], 'anima.message.send');
    assert.equal(held!.payload?.['text'], undefined);

    // Retry after hold with no further room movement → allow.
    const again = await evaluateSendHold({
      agentId,
      teamId: 'T1',
      channelId: 'C1',
      tool: 'anima.message.send',
      botUserId: 'U_BOT',
      store,
    });
    assert.equal(again.kind, 'allow');
  });
});

test('failed HELD write does not consume cursor (delta undelivered)', async () => {
  await withHoldStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'root',
      userId: 'U1',
    });
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:1.0',
      lastDeliveredMessageTs: '1.0',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'foreign',
      userId: 'U2',
    });

    await assert.rejects(
      () =>
        evaluateSendHold({
          agentId,
          teamId: 'T1',
          channelId: 'C1',
          tool: 'anima.message.send',
          botUserId: 'U_BOT',
          store,
          writeOutput: () => {
            throw new Error('stdout failed');
          },
        }),
      /stdout failed/,
    );

    const cursor = await store.getCursor('slack:T1:C1');
    assert.equal(cursor.status, 'present');
    if (cursor.status === 'present') {
      assert.equal(cursor.deliveredOrdinal, 1, 'cursor must stay at 1 when HELD write fails');
    }
  });
});

test('incomplete retained window fails closed (no false-allow on capped read)', async () => {
  // Cursor 0, captured tail 5001, retained only 2..5001 all own → missing ordinal 1.
  await withHoldStore(async (_store, agentId) => {
    const surfaceId = 'slack:T1:C1';
    const retained: Array<{
      channelId: string;
      eventId: string;
      messageTs: string;
      observedAt: string;
      ordinal: number;
      receivedAt: string;
      surfaceId: string;
      teamId: string;
      text: string;
      userId: string;
    }> = [];
    for (let ord = 2; ord <= 5_001; ord += 1) {
      retained.push({
        channelId: 'C1',
        eventId: `slack:T1:C1:${ord}.0`,
        messageTs: `${ord}.0`,
        observedAt: '2026-01-01T00:00:00.000Z',
        ordinal: ord,
        receivedAt: '2026-01-01T00:00:00.000Z',
        surfaceId,
        teamId: 'T1',
        text: `own-${ord}`,
        userId: 'U_BOT',
      });
    }
    class GapStore extends ObservedConversationStore {
      override async getContinuity() {
        return { status: 'ok' as const, updatedAt: '2026-01-01T00:00:00.000Z' };
      }
      override async getCursor() {
        return {
          status: 'present' as const,
          deliveredOrdinal: 0,
          surfaceId,
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      override async readCursorDeliverySnapshot(
        _sid: string,
        options: { afterOrdinal?: number; limit?: number } = {},
      ) {
        const after = options.afterOrdinal ?? 0;
        const limit = options.limit ?? 100;
        const filtered = retained.filter((r) => r.ordinal > after);
        const candidates = filtered.length <= limit
          ? filtered
          : filtered.slice(filtered.length - limit);
        return {
          index: {
            lastEventId: 'slack:T1:C1:5001.0',
            lastMessageTs: '5001.0',
            surfaceId,
            tailOrdinal: 5_001,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          candidates,
          capturedTailOrdinal: 5_001,
        };
      }
    }

    assert.equal(afterCursorIndexPopulation(0, 5_001), 5_001);
    assert.equal(retained.length, 5_000);

    await assert.rejects(
      () =>
        evaluateSendHold({
          agentId,
          teamId: 'T1',
          channelId: 'C1',
          tool: 'anima.message.send',
          botUserId: 'U_BOT',
          store: new GapStore(agentId),
        }),
      (err: unknown) => {
        assert.ok(err instanceof SendHoldError);
        assert.equal(err.reason, 'store_error');
        assert.match(err.message, /retained window incomplete/);
        return true;
      },
    );
  });
});

test('completeness uses captured snapshot tail, not a prior unlocked index read', async () => {
  // Red control: stale unlocked tail 5000, then own append → locked snapshot tail
  // 5001 with retained 2..5001 all own. Must use captured 5001 (not 5000) so the
  // incomplete window fails closed (ordinal 1 unknown) rather than false-allow.
  await withHoldStore(async (_store, agentId) => {
    const surfaceId = 'slack:T1:C1';
    const retained: Array<{
      channelId: string;
      eventId: string;
      messageTs: string;
      observedAt: string;
      ordinal: number;
      receivedAt: string;
      surfaceId: string;
      teamId: string;
      text: string;
      userId: string;
    }> = [];
    for (let ord = 2; ord <= 5_001; ord += 1) {
      retained.push({
        channelId: 'C1',
        eventId: `slack:T1:C1:${ord}.0`,
        messageTs: `${ord}.0`,
        observedAt: '2026-01-01T00:00:00.000Z',
        ordinal: ord,
        receivedAt: '2026-01-01T00:00:00.000Z',
        surfaceId,
        teamId: 'T1',
        text: `own-${ord}`,
        userId: 'U_BOT',
      });
    }
    let getIndexCalls = 0;
    class RaceStore extends ObservedConversationStore {
      override async getContinuity() {
        return { status: 'ok' as const, updatedAt: '2026-01-01T00:00:00.000Z' };
      }
      override async getCursor() {
        return {
          status: 'present' as const,
          deliveredOrdinal: 0,
          surfaceId,
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      /** If evaluateSendHold still called this, it would see the stale tail. */
      override async getIndexReconciled() {
        getIndexCalls += 1;
        return {
          lastEventId: 'slack:T1:C1:5000.0',
          lastMessageTs: '5000.0',
          surfaceId,
          tailOrdinal: 5_000,
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      override async readCursorDeliverySnapshot() {
        // Locked observation after own append: tail 5001, retained 2..5001.
        return {
          index: {
            lastEventId: 'slack:T1:C1:5001.0',
            lastMessageTs: '5001.0',
            surfaceId,
            tailOrdinal: 5_001,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          candidates: retained,
          capturedTailOrdinal: 5_001,
        };
      }
    }

    await assert.rejects(
      () =>
        evaluateSendHold({
          agentId,
          teamId: 'T1',
          channelId: 'C1',
          tool: 'anima.message.send',
          botUserId: 'U_BOT',
          store: new RaceStore(agentId),
        }),
      /retained window incomplete.*5001/,
    );
    // Must not consult a separate unlocked index (pairing race).
    assert.equal(getIndexCalls, 0);
  });
});

test('messageTsFromSlackFileInfo reads share stamp for own observation', () => {
  assert.equal(
    messageTsFromSlackFileInfo(
      {
        shares: {
          private: {
            C1: [{ ts: '1770000999.000111' }],
          },
        },
      },
      'C1',
    ),
    '1770000999.000111',
  );
  assert.equal(messageTsFromSlackFileInfo(undefined, 'C1'), undefined);
});

test('wake-time cursor view places earlier-omitted marker above shown rows', () => {
  const now = new Date().toISOString();
  const entries = [1, 2].map((ord) => ({
    channelId: 'C1',
    eventId: `e${ord}`,
    messageTs: `${ord}.0`,
    observedAt: now,
    ordinal: ord,
    receivedAt: now,
    surfaceId: 'slack:T1:C1',
    teamId: 'T1',
    text: `row-${ord}`,
    userId: 'U1',
  }));
  const trigger = {
    id: 'wake',
    kind: 'slack',
    teamId: 'T1',
    channelId: 'C1',
    messageTs: '3.0',
    text: 'wake',
    receivedAt: now,
    actor: { userId: 'U1' },
    handling: {
      createdAt: now,
      queuedAt: now,
      status: 'queued',
      updatedAt: now,
    },
  } as SlackInboxItem;
  const body = renderCursorDeliveryEnvelopeFromEntries(trigger, entries, 5);
  const lines = body.split('\n');
  const markerIdx = lines.findIndex((l) => l.includes('earlier message'));
  const rowIdx = lines.findIndex((l) => l.includes('row-1'));
  assert.ok(markerIdx >= 0 && rowIdx >= 0);
  assert.ok(markerIdx < rowIdx, `cursor view marker above rows:\n${body}`);
  assert.match(body, /\(\+5 earlier messages not shown\)/);
});

test('own posts after cursor do not hold', async () => {
  await withHoldStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'seen',
      userId: 'U1',
    });
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:1.0',
      lastDeliveredMessageTs: '1.0',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'my prior',
      userId: 'U_BOT',
    });
    const result = await evaluateSendHold({
      agentId,
      teamId: 'T1',
      channelId: 'C1',
      tool: 'anima.message.send',
      botUserId: 'U_BOT',
      store,
    });
    assert.equal(result.kind, 'allow');
  });
});

test('file send noun in held copy', async () => {
  await withHoldStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'root',
      userId: 'U1',
    });
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:1.0',
      lastDeliveredMessageTs: '1.0',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'moved',
      userId: 'U2',
    });
    const lines: string[] = [];
    const result = await evaluateSendHold({
      agentId,
      teamId: 'T1',
      channelId: 'C1',
      tool: 'anima.file.send',
      botUserId: 'U_BOT',
      store,
      writeOutput: (line) => lines.push(line),
    });
    assert.equal(result.kind, 'held');
    if (result.kind !== 'held') return;
    assert.match(result.stdout, /your file was not sent/);
  });
});

test('degraded continuity fails closed (not silent allow)', async () => {
  await withHoldStore(async (store, agentId) => {
    await store.markDegraded({ message: 'gap', surfaceId: 'slack:T1:C1' });
    await assert.rejects(
      () =>
        evaluateSendHold({
          agentId,
          teamId: 'T1',
          channelId: 'C1',
          tool: 'anima.message.send',
          store,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SendHoldError);
        assert.equal(err.reason, 'continuity_degraded');
        return true;
      },
    );
  });
});

test('cursor beyond tail fails closed before hold', async () => {
  await withHoldStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'a',
      userId: 'U1',
    });
    await store.writeCursorForTest({
      surfaceId: 'slack:T1:C1',
      deliveredOrdinal: 9,
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(
      () =>
        evaluateSendHold({
          agentId,
          teamId: 'T1',
          channelId: 'C1',
          tool: 'anima.message.send',
          botUserId: 'U_BOT',
          store,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SendHoldError);
        assert.equal(err.reason, 'store_error');
        assert.match(err.message, /beyond reconciled tail/);
        return true;
      },
    );
  });
});

test('observeOwnOutboundPost journals own send for later hold exclusion', async () => {
  await withHoldStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'prior',
      userId: 'U1',
    });
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:1.0',
      lastDeliveredMessageTs: '1.0',
    });
    await observeOwnOutboundPost({
      agentId,
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'i sent this',
      botUserId: 'U_BOT',
      store,
    });
    const result = await evaluateSendHold({
      agentId,
      teamId: 'T1',
      channelId: 'C1',
      tool: 'anima.message.send',
      botUserId: 'U_BOT',
      store,
    });
    assert.equal(result.kind, 'allow');
    assert.equal(
      isOwnObservedEntry(
        {
          channelId: 'C1',
          eventId: 'x',
          messageTs: '2.0',
          observedAt: 't',
          ordinal: 2,
          receivedAt: 't',
          surfaceId: 'slack:T1:C1',
          teamId: 'T1',
          text: 'i sent this',
          userId: 'U_BOT',
        },
        { botUserId: 'U_BOT' },
      ),
      true,
    );
  });
});
