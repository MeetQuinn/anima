import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  commitCursorDelivery,
  CURSOR_DELIVERY_MAX_BYTES,
  CURSOR_DELIVERY_MAX_MESSAGES,
  formatObservedLine,
  prepareCursorDelivery,
  selectNewestFitting,
  setCursorDeliveryEnabledForTests,
  surfacesForSlackWake,
} from '../runtime/cursor-delivery.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { ObservedConversationStore } from '../storage/schema/observed-conversation.store.js';
import type { SlackInboxItem } from '../../shared/inbox.js';
import { withAnimaHome } from './anima-home.js';
import { defaultAgentConfig, writeAgentConfigs } from './helpers/harness.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { makeSlackEvent } from './helpers/slack.js';

async function withEnabledStore<T>(
  body: (store: ObservedConversationStore, agentId: string, queue: WakeQueueService) => Promise<T>,
): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cursor-del-'));
  setCursorDeliveryEnabledForTests(true);
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    return await withAnimaHome(stateDir, async () => {
      const store = new ObservedConversationStore('anima');
      const queue = new WakeQueueService('anima');
      return body(store, 'anima', queue);
    });
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
    await rm(stateDir, { force: true, recursive: true });
  }
}

function slackItem(partial: {
  channelId: string;
  messageTs: string;
  text: string;
  threadTs?: string;
  teamId?: string;
  userId?: string;
  id?: string;
}): SlackInboxItem {
  const teamId = partial.teamId ?? 'T1';
  const channelId = partial.channelId;
  const messageTs = partial.messageTs;
  const now = new Date().toISOString();
  return {
    id: partial.id ?? `slack:${teamId}:${channelId}:${messageTs}`,
    kind: 'slack',
    teamId,
    channelId,
    messageTs,
    ...(partial.threadTs ? { threadTs: partial.threadTs } : {}),
    text: partial.text,
    receivedAt: now,
    actor: { userId: partial.userId ?? 'U1' },
    handling: {
      createdAt: now,
      queuedAt: now,
      status: 'queued',
      updatedAt: now,
    },
  };
}

test('gate-off: prepare returns disabled; prompt bytes unchanged', async () => {
  setCursorDeliveryEnabledForTests(false);
  try {
    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'hi' });
    const result = await prepareCursorDelivery({ agentId: 'anima', item });
    assert.equal(result.kind, 'disabled');

    const event = makeSlackEvent({
      channelId: 'C-team',
      eventId: 'evt-1',
      teamId: 'T-demo',
      text: 'byte pin',
      ts: '1770000010.000001',
      userId: 'U1',
    });
    // Single-message form (no cursor body) — same path as pre-cut-(b).
    const text = buildCodeAgentDeliveryPrompt(event);
    assert.match(text, /^New Slack message:/);
    assert.doesNotMatch(text, /Slack conversation update:/);
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
  }
});

test('surfacesForSlackWake: channel root includes response-thread; thread/DM do not double', () => {
  const root = slackItem({ channelId: 'C1', messageTs: '10.0', text: 'root' });
  assert.deepEqual(surfacesForSlackWake(root), [
    'slack:T1:C1',
    'slack:T1:C1:thread:10.0',
  ]);

  const reply = slackItem({
    channelId: 'C1',
    messageTs: '11.0',
    threadTs: '10.0',
    text: 'reply',
  });
  assert.deepEqual(surfacesForSlackWake(reply), ['slack:T1:C1:thread:10.0']);

  const dm = slackItem({ channelId: 'D9', messageTs: '1.0', text: 'dm' });
  assert.deepEqual(surfacesForSlackWake(dm), ['slack:T1:D9']);
});

test('first wake: bounded context + trigger retained; child thread established present@0', async () => {
  await withEnabledStore(async (store, agentId, queue) => {
    // Seed journal with more than the bound so omittedCount > 0.
    for (let i = 1; i <= 25; i += 1) {
      await store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: `${100 + i}.0`,
        text: `msg-${i}-${'x'.repeat(20)}`,
        userId: 'U1',
      });
    }
    const triggerTs = '125.0';
    const item = slackItem({
      channelId: 'C1',
      messageTs: triggerTs,
      text: 'msg-25-xxxxxxxxxxxxxxxxxxxx',
      userId: 'U1',
    });

    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;

    const primary = prepared.plan.surfaces[0]!;
    assert.equal(primary.surfaceId, 'slack:T1:C1');
    assert.ok(primary.entries.length <= CURSOR_DELIVERY_MAX_MESSAGES);
    assert.ok(primary.entries.some((e) => e.messageTs === triggerTs), 'trigger retained');
    assert.ok(primary.omittedCount >= 1, 'bound omits older rows');

    const child = prepared.plan.surfaces[1]!;
    assert.equal(child.surfaceId, 'slack:T1:C1:thread:125.0');
    assert.equal(child.establishOnly, true);
    assert.equal(child.nextDeliveredOrdinal, 0);

    assert.match(prepared.plan.promptBody, /Slack conversation update:/);
    assert.match(prepared.plan.promptBody, /Latest wake:/);
    assert.match(prepared.plan.promptBody, /msg-25/);

    const committed = await commitCursorDelivery({ plan: prepared.plan, queue, store });
    assert.ok(committed.advanced.includes('slack:T1:C1'));
    assert.ok(committed.advanced.includes('slack:T1:C1:thread:125.0'));

    const rootCursor = await store.getCursor('slack:T1:C1');
    assert.equal(rootCursor.status, 'present');
    if (rootCursor.status === 'present') {
      assert.equal(rootCursor.deliveredOrdinal, primary.nextDeliveredOrdinal);
    }
    const childCursor = await store.getCursor('slack:T1:C1:thread:125.0');
    assert.equal(childCursor.status, 'present');
    if (childCursor.status === 'present') {
      assert.equal(childCursor.deliveredOrdinal, 0);
    }

    // Idempotent re-commit (provider retry).
    const again = await commitCursorDelivery({ plan: prepared.plan, queue, store });
    assert.deepEqual(again.advanced, []);
  });
});

test('ignored bot and human rows appear in snapshot when journaled', async () => {
  await withEnabledStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'human noise',
      userId: 'U99',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'bot chatter',
      botId: 'B1',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '3.0',
      text: 'wake me',
      userId: 'U1',
    });

    const item = slackItem({ channelId: 'C1', messageTs: '3.0', text: 'wake me', userId: 'U1' });
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    const texts = prepared.plan.surfaces[0]!.entries.map((e) => e.text);
    assert.deepEqual(texts, ['human noise', 'bot chatter', 'wake me']);
    assert.match(prepared.plan.promptBody, /human noise/);
    assert.match(prepared.plan.promptBody, /bot chatter/);
  });
});

test('same-surface covered wake coalesced once; other/later/staged/non-Slack untouched', async () => {
  await withEnabledStore(async (store, agentId, queue) => {
    // Snapshot window at prepare time is only ordinals 1–2.
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'a',
      userId: 'U1',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'b',
      userId: 'U2',
    });
    // Other surface
    await store.observe({
      teamId: 'T1',
      channelId: 'C2',
      messageTs: '1.0',
      text: 'other',
      userId: 'U1',
    });

    const trigger = slackItem({
      id: 'wake-trigger',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'b',
      userId: 'U2',
    });
    // Covered same surface (ordinal 1 ≤ tail 2)
    await queue.enqueue(slackItem({
      id: 'wake-covered',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'a',
      userId: 'U1',
    }));
    // Other surface
    await queue.enqueue(slackItem({
      id: 'wake-other',
      channelId: 'C2',
      messageTs: '1.0',
      text: 'other',
      userId: 'U1',
    }));
    // Staged — not claimable
    await queue.enqueueStaged(slackItem({
      id: 'wake-staged',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'a',
      userId: 'U1',
    }));
    // Non-Slack
    const now = new Date().toISOString();
    await queue.enqueue({
      id: 'reminder-1',
      kind: 'reminder',
      reminderId: 'r1',
      receivedAt: now,
      handling: {
        createdAt: now,
        queuedAt: now,
        status: 'queued',
        updatedAt: now,
      },
    });

    const prepared = await prepareCursorDelivery({ agentId, item: trigger, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    assert.equal(prepared.plan.surfaces[0]!.nextDeliveredOrdinal, 2);

    // After prepare (tail frozen at 2), a later journal row + wake must not be coalesced.
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '3.0',
      text: 'c',
      userId: 'U3',
    });
    await queue.enqueue(slackItem({
      id: 'wake-later',
      channelId: 'C1',
      messageTs: '3.0',
      text: 'c',
      userId: 'U3',
    }));

    const { coalescedItemIds } = await commitCursorDelivery({
      plan: prepared.plan,
      queue,
      store,
      excludeItemIds: [trigger.id],
    });
    assert.ok(coalescedItemIds.includes('wake-covered'));
    assert.ok(!coalescedItemIds.includes('wake-later'));
    assert.ok(!coalescedItemIds.includes('wake-other'));
    assert.ok(!coalescedItemIds.includes('wake-staged'));
    assert.ok(!coalescedItemIds.includes('reminder-1'));

    const remaining = await queue.list();
    const ids = remaining.map((i) => i.id).sort();
    assert.ok(ids.includes('wake-later'));
    assert.ok(ids.includes('wake-other'));
    assert.ok(ids.includes('wake-staged'));
    assert.ok(ids.includes('reminder-1'));
    assert.ok(!ids.includes('wake-covered'));
  });
});

test('crash between cursor and queue: later claim self-heals without provider (already_delivered)', async () => {
  await withEnabledStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'only',
      userId: 'U1',
    });
    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'only', userId: 'U1' });

    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;

    // Simulate: cursor committed, process died before queue settle of the trigger itself.
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:1.0',
      lastDeliveredMessageTs: '1.0',
    });
    // Child thread establish
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1:thread:1.0',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 0,
    });

    const again = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(again.kind, 'already_delivered');
  });
});

test('degraded continuity and missing trigger are fail-closed (not absent)', async () => {
  await withEnabledStore(async (store, agentId) => {
    await store.markDegraded({ message: 'gap', surfaceId: 'slack:T1:C1' });
    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'x' });
    const degraded = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(degraded.kind, 'failed');
    if (degraded.kind === 'failed') {
      assert.equal(degraded.error.reason, 'continuity_degraded');
    }

    // Fresh agent without degrade — missing observation
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-cursor-miss-'));
    setCursorDeliveryEnabledForTests(true);
    try {
      await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
      await withAnimaHome(stateDir, async () => {
        const clean = new ObservedConversationStore('anima');
        const missing = await prepareCursorDelivery({
          agentId: 'anima',
          item: slackItem({ channelId: 'C1', messageTs: '9.0', text: 'ghost' }),
          store: clean,
        });
        assert.equal(missing.kind, 'failed');
        if (missing.kind === 'failed') {
          assert.equal(missing.error.reason, 'missing_trigger_observation');
        }
      });
    } finally {
      setCursorDeliveryEnabledForTests(undefined);
      await rm(stateDir, { force: true, recursive: true });
    }
  });
});

test('selectNewestFitting: newest-fitting chronological with exact omitted count', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    channelId: 'C1',
    eventId: `slack:T1:C1:${i + 1}.0`,
    messageTs: `${i + 1}.0`,
    observedAt: new Date().toISOString(),
    ordinal: i + 1,
    receivedAt: new Date().toISOString(),
    surfaceId: 'slack:T1:C1',
    teamId: 'T1',
    text: `line-${i + 1}`,
    userId: 'U1',
  }));
  const { entries, omittedCount } = selectNewestFitting(rows, {
    maxMessages: 3,
    maxBytes: CURSOR_DELIVERY_MAX_BYTES,
  });
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.ordinal), [8, 9, 10]);
  assert.equal(omittedCount, 7);

  // Must include older trigger when it would fall outside the newest window.
  const withTrigger = selectNewestFitting(rows, {
    maxMessages: 3,
    maxBytes: CURSOR_DELIVERY_MAX_BYTES,
    mustIncludeEventId: 'slack:T1:C1:2.0',
  });
  assert.ok(withTrigger.entries.some((e) => e.eventId === 'slack:T1:C1:2.0'));
});

test('formatObservedLine marks file-only rows', () => {
  const line = formatObservedLine({
    channelId: 'C1',
    eventId: 'slack:T1:C1:1.0',
    messageTs: '1.0',
    observedAt: new Date().toISOString(),
    ordinal: 1,
    receivedAt: new Date().toISOString(),
    surfaceId: 'slack:T1:C1',
    teamId: 'T1',
    text: '',
    userId: 'U1',
    files: [{ id: 'F1', name: 'doc.pdf' }],
  });
  assert.match(line, /\[file: doc\.pdf\]/);
});

test('follow-up accept advances cursor; reject does not (unit of commit semantics)', async () => {
  await withEnabledStore(async (store, agentId, queue) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'first',
      userId: 'U1',
    });
    // Establish cursor at 0 via a prior delivery of nothing (present@0), then
    // deliver first message as a follow-up accept path.
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 0,
    });

    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'first' });
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;

    // Simulate reject: do not commit — cursor stays at 0.
    const cursorBefore = await store.getCursor('slack:T1:C1');
    assert.equal(cursorBefore.status, 'present');
    if (cursorBefore.status === 'present') assert.equal(cursorBefore.deliveredOrdinal, 0);

    // Accept path:
    await commitCursorDelivery({ plan: prepared.plan, queue, store });
    const cursorAfter = await store.getCursor('slack:T1:C1');
    assert.equal(cursorAfter.status, 'present');
    if (cursorAfter.status === 'present') {
      assert.equal(cursorAfter.deliveredOrdinal, 1);
    }
  });
});
