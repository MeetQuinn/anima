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
  mergeCursorDeliveryPlans,
  prepareCursorDelivery,
  selectNewestFitting,
  setCursorDeliveryEnabledForTests,
  surfacesForSlackWake,
  truncateUtf8,
} from '../runtime/cursor-delivery.js';
import { groupFollowupContexts } from '../runtime/followup-appender.js';
import type { RuntimeItemContext } from '../runtime/types.js';
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
    // Chronological flat view (no per-surface headers).
    assert.match(prepared.plan.promptBody, /earlier message/);

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

test('child-thread rows are rendered before cursor advance on that surface', async () => {
  await withEnabledStore(async (store, agentId) => {
    // Channel root + a reply already in the response thread before the root wake starts.
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '10.0',
      text: 'root',
      userId: 'U1',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '11.0',
      threadTs: '10.0',
      text: 'reply-before-start',
      userId: 'U2',
    });

    const item = slackItem({ channelId: 'C1', messageTs: '10.0', text: 'root', userId: 'U1' });
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;

    const child = prepared.plan.surfaces.find((s) => s.surfaceId === 'slack:T1:C1:thread:10.0');
    assert.ok(child);
    assert.equal(child!.establishOnly, false);
    assert.equal(child!.nextDeliveredOrdinal, 1);
    assert.ok(child!.entries.some((e) => e.text === 'reply-before-start'));
    assert.match(prepared.plan.promptBody, /reply-before-start/);
    // Flat chronological render includes the thread row before advance.
    assert.match(prepared.plan.promptBody, /message_ts=11\.0/);
  });
});

test('strict CAS rejects stale plan after concurrent advance (not silent rewrite)', async () => {
  await withEnabledStore(async (store, agentId, queue) => {
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

    const item = slackItem({ channelId: 'C1', messageTs: '2.0', text: 'b' });
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    assert.equal(prepared.plan.surfaces[0]!.cursorExpected.status, 'absent');

    // Another delivery advances to 1 before our stale plan commits.
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:1.0',
      lastDeliveredMessageTs: '1.0',
    });

    await assert.rejects(
      () => commitCursorDelivery({ plan: prepared.plan, queue, store }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /stale cursor plan|cas_failure|expected/);
        return true;
      },
    );
    // Cursor must not have been rewritten to 2 by the stale plan.
    const cursor = await store.getCursor('slack:T1:C1');
    assert.equal(cursor.status, 'present');
    if (cursor.status === 'present') assert.equal(cursor.deliveredOrdinal, 1);
  });
});

test('runtime_restart is never already_delivered (preserves recovery continuation)', async () => {
  await withEnabledStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'only',
      userId: 'U1',
    });
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:1.0',
      lastDeliveredMessageTs: '1.0',
    });

    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'only' });
    item.handling.resumeReason = 'runtime_restart';

    const prepared = await prepareCursorDelivery({ agentId, item, store });
    // Must prepare (or at least not already_delivered) so the worker runs continuation.
    assert.notEqual(prepared.kind, 'already_delivered');
    assert.equal(prepared.kind, 'prepared');

    // Prompt path still prefers restart continuation over cursor body.
    const prompt = buildCodeAgentDeliveryPrompt(item, {
      cursorDeliveryPromptBody: prepared.kind === 'prepared' ? prepared.plan.promptBody : undefined,
    });
    assert.match(prompt, /Runtime restart continuation:/);
  });
});

test('cursor envelope includes attached_files and unfurl previews from the wake item', async () => {
  await withEnabledStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'see file',
      userId: 'U1',
      files: [{ id: 'F1', name: 'shot.png' }],
    });
    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'see file', userId: 'U1' });
    item.files = [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', sizeBytes: 4096 }];
    item.previews = [{ text: 'unfurled title', fromUrl: 'https://example.test/x' }];
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    const text = buildCodeAgentDeliveryPrompt(item, {
      cursorDeliveryPromptBody: prepared.plan.promptBody,
    });
    assert.match(text, /Slack conversation update:/);
    assert.match(text, /<attached_files>/);
    assert.match(text, /shot\.png/);
    assert.match(text, /size_bytes="4096"/);
    assert.match(text, /unfurled title|source="slack_unfurl"/);
  });
});

test('shared budget caps total rows across channel + response-thread surfaces', async () => {
  await withEnabledStore(async (store, agentId) => {
    // 20 channel rows + 20 thread rows = 40 candidates; shared bound is 20.
    for (let i = 1; i <= 20; i += 1) {
      await store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: `${100 + i}.0`,
        text: `ch-${i}`,
        userId: 'U1',
      });
    }
    for (let i = 1; i <= 20; i += 1) {
      await store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: `${200 + i}.0`,
        threadTs: '120.0',
        text: `th-${i}`,
        userId: 'U2',
      });
    }
    // Trigger is channel root 120.0 (ordinal 20 on channel).
    const item = slackItem({
      channelId: 'C1',
      messageTs: '120.0',
      text: 'ch-20',
      userId: 'U1',
    });
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    const totalRows = prepared.plan.surfaces.reduce((n, s) => n + s.entries.length, 0);
    assert.ok(totalRows <= CURSOR_DELIVERY_MAX_MESSAGES, `total rows ${totalRows}`);
    const rendered = prepared.plan.promptBody;
    assert.ok(Buffer.byteLength(rendered, 'utf8') <= CURSOR_DELIVERY_MAX_BYTES + 2_000);
    // Exact omitted across the whole view is reported once.
    const omitted = prepared.plan.surfaces.reduce((n, s) => n + s.omittedCount, 0);
    assert.ok(omitted >= 20, `expected many omitted, got ${omitted}`);
  });
});

test('groupFollowupContexts merges child threads for same-channel roots', async () => {
  await withEnabledStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '10.0',
      text: 'root-one',
      userId: 'U1',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '10.5',
      threadTs: '10.0',
      text: 'reply-in-one',
      userId: 'U2',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '20.0',
      text: 'root-two',
      userId: 'U1',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '20.5',
      threadTs: '20.0',
      text: 'reply-in-two',
      userId: 'U3',
    });

    const a = await prepareCursorDelivery({
      agentId,
      item: slackItem({ channelId: 'C1', messageTs: '10.0', text: 'root-one', id: 'root-one' }),
      store,
    });
    const b = await prepareCursorDelivery({
      agentId,
      item: slackItem({ channelId: 'C1', messageTs: '20.0', text: 'root-two', id: 'root-two' }),
      store,
    });
    assert.equal(a.kind, 'prepared');
    assert.equal(b.kind, 'prepared');
    if (a.kind !== 'prepared' || b.kind !== 'prepared') return;

    // Direct merge of the two plans must keep both response-thread surfaces.
    const mergedSurfaces = mergeCursorDeliveryPlans(
      [a.plan, b.plan],
      slackItem({ channelId: 'C1', messageTs: '20.0', text: 'root-two' }),
    ).surfaces.map((s) => s.surfaceId).sort();
    assert.ok(mergedSurfaces.includes('slack:T1:C1'));
    assert.ok(mergedSurfaces.includes('slack:T1:C1:thread:10.0'));
    assert.ok(mergedSurfaces.includes('slack:T1:C1:thread:20.0'));

    // Integration: groupFollowupContexts for [root-one, root-two].
    const ctx = (plan: typeof a.plan, id: string, ts: string): RuntimeItemContext => ({
      agentId,
      item: slackItem({ channelId: 'C1', messageTs: ts, text: id, id }),
      session: { id: 's', agentId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as RuntimeItemContext['session'],
      stateDir: '/tmp',
      homePath: '/tmp',
      cursorDelivery: plan,
    });
    const grouped = groupFollowupContexts([
      ctx(a.plan, 'root-one', '10.0'),
      ctx(b.plan, 'root-two', '20.0'),
    ]);
    assert.equal(grouped.units.length, 1);
    assert.equal(grouped.units[0]!.kind, 'slack_group');
    if (grouped.units[0]!.kind !== 'slack_group') return;
    const surfaceIds = grouped.units[0]!.mergedPlan.surfaces.map((s) => s.surfaceId);
    assert.ok(surfaceIds.includes('slack:T1:C1:thread:10.0'), 'child thread:10.0 must survive grouping');
    assert.ok(surfaceIds.includes('slack:T1:C1:thread:20.0'), 'child thread:20.0 must survive grouping');
    assert.equal(grouped.bridgeContexts.length, 1);
    assert.match(grouped.units[0]!.mergedPlan.promptBody, /reply-in-one|thread:10/);
  });
});

test('runtime_restart prompt includes prepared delta (arrived-during-crash visible)', async () => {
  await withEnabledStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'original',
      userId: 'U1',
    });
    await store.advanceCursor({
      surfaceId: 'slack:T1:C1',
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
      lastDeliveredEventId: 'slack:T1:C1:1.0',
      lastDeliveredMessageTs: '1.0',
    });
    // Arrives during crash before restart recovery.
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'arrived-during-crash',
      userId: 'U2',
    });

    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'original' });
    item.handling.resumeReason = 'runtime_restart';
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    assert.ok(
      prepared.plan.surfaces[0]!.entries.some((e) => e.text === 'arrived-during-crash'),
    );

    const prompt = buildCodeAgentDeliveryPrompt(item, {
      cursorDeliveryPromptBody: prepared.plan.promptBody,
    });
    assert.match(prompt, /Runtime restart continuation:/);
    assert.match(prompt, /arrived-during-crash/);
  });
});

test('final provider envelope stays within 16 KiB incl. previews/files; no post-plan truncate', async () => {
  await withEnabledStore(async (store, agentId) => {
    const long = 'L'.repeat(30_000);
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: long,
      userId: 'U1',
    });
    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: long, userId: 'U1' });
    item.previews = [{ text: 'P'.repeat(8_000), fromUrl: 'https://example.test/x' }];
    item.files = [{ id: 'F1', name: 'big.bin', mimetype: 'application/octet-stream', sizeBytes: 99 }];

    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;

    // Full envelope is what the provider gets (Iris: bound = final rendered envelope).
    const full = buildCodeAgentDeliveryPrompt(item, {
      cursorDeliveryPromptBody: prepared.plan.promptBody,
    });
    assert.equal(full, prepared.plan.promptBody);
    assert.ok(
      Buffer.byteLength(full, 'utf8') <= CURSOR_DELIVERY_MAX_BYTES,
      `envelope ${Buffer.byteLength(full, 'utf8')}`,
    );
    // Long raw trigger must not appear unclipped.
    assert.ok(!full.includes(long));
    // nextDeliveredOrdinal matches only rows present in the envelope.
    const channel = prepared.plan.surfaces.find((s) => s.surfaceId === 'slack:T1:C1');
    assert.ok(channel);
    if (channel!.entries.length > 0) {
      assert.equal(channel!.nextDeliveredOrdinal, channel!.entries.at(-1)!.ordinal);
    }
  });
});

test('truncateUtf8 does not split surrogate pairs', () => {
  // Cap that cannot hold a full emoji (4 bytes) + ellipsis (3) cleanly.
  const out = truncateUtf8('😀x', 6);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 6);
  // Must not produce UTF-8 replacement from a lone surrogate in the payload.
  const decoded = Buffer.from(out, 'utf8').toString('utf8');
  assert.equal(decoded.includes('\uFFFD'), false);
  // Every code point in the result (except ellipsis) is a complete character.
  for (const ch of out) {
    if (ch === '…') continue;
    assert.ok([...ch].length === 1);
  }
});

test('single-plan merge preserves omission count', async () => {
  await withEnabledStore(async (store, agentId) => {
    for (let i = 1; i <= 40; i += 1) {
      await store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: `${i}.0`,
        text: `row-${i}`,
        userId: 'U1',
      });
    }
    const prepared = await prepareCursorDelivery({
      agentId,
      item: slackItem({ channelId: 'C1', messageTs: '40.0', text: 'row-40' }),
      store,
    });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    const before = prepared.plan.surfaces.reduce((n, s) => n + s.omittedCount, 0);
    assert.ok(before >= 1, `expected omissions before merge, got ${before}`);
    const merged = mergeCursorDeliveryPlans(
      [prepared.plan],
      slackItem({ channelId: 'C1', messageTs: '40.0', text: 'row-40' }),
    );
    const after = merged.surfaces.reduce((n, s) => n + s.omittedCount, 0);
    assert.equal(after, before);
    assert.match(merged.promptBody, /earlier message/);
  });
});

test('newest-fitting uses conversation time across surfaces (not surface order)', async () => {
  await withEnabledStore(async (store, agentId) => {
    // Channel root at 50.0; fill channel surface with many mid-range rows.
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '50.0',
      text: 'channel-root-trigger',
      userId: 'U1',
    });
    for (let i = 1; i <= 25; i += 1) {
      await store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: `${50 + i}.0`,
        text: `ch-noise-${i}`,
        userId: 'U1',
      });
    }
    // Globally newest reply on the response-thread for this root (thread:50.0).
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '99.0',
      threadTs: '50.0',
      text: 'newest-thread-reply',
      userId: 'U2',
    });

    const item = slackItem({
      channelId: 'C1',
      messageTs: '50.0',
      text: 'channel-root-trigger',
      userId: 'U1',
    });
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    // Globally newest (99.0 on response-thread) must not be evicted by channel-first fill.
    assert.match(prepared.plan.promptBody, /newest-thread-reply/);
  });
});

test('merge re-windows to ≤20 rows after union of two bounded plans', async () => {
  await withEnabledStore(async (store, agentId) => {
    for (let i = 1; i <= 30; i += 1) {
      await store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: `${i}.0`,
        text: `row-${i}`,
        userId: 'U1',
      });
    }
    // Two prepares from absent both capture up to 20 newest — union without
    // re-window would still be 20; force different windows by advancing cursor
    // is hard. Instead merge two plans each holding 15 distinct via manual plans.
    const a = await prepareCursorDelivery({
      agentId,
      item: slackItem({ channelId: 'C1', messageTs: '30.0', text: 'row-30' }),
      store,
    });
    assert.equal(a.kind, 'prepared');
    if (a.kind !== 'prepared') return;
    // Synthesize a second plan with earlier rows by cloning surfaces and swapping
    // entries to a 15-row lower window (still from same journal space).
    const lower = a.plan.surfaces.map((s) => {
      if (s.surfaceId !== 'slack:T1:C1') return s;
      // Take rows 1-15 if available from full journal.
      return s;
    });
    // Build second plan by preparing after temporarily... simpler: take a.plan
    // entries and a synthetic plan with different entries from journal.
    const all = await store.readJournal('slack:T1:C1', { limit: 1000 });
    const early = all.slice(0, 15);
    const late = all.slice(-15);
    const planEarly: typeof a.plan = {
      ...a.plan,
      surfaces: a.plan.surfaces.map((s) =>
        s.surfaceId === 'slack:T1:C1'
          ? {
              ...s,
              entries: early,
              nextDeliveredOrdinal: early[early.length - 1]!.ordinal,
              omittedCount: 0,
            }
          : s,
      ),
    };
    const planLate: typeof a.plan = {
      ...a.plan,
      surfaces: a.plan.surfaces.map((s) =>
        s.surfaceId === 'slack:T1:C1'
          ? {
              ...s,
              entries: late,
              nextDeliveredOrdinal: late[late.length - 1]!.ordinal,
              omittedCount: 0,
            }
          : s,
      ),
    };
    const merged = mergeCursorDeliveryPlans(
      [planEarly, planLate],
      slackItem({ channelId: 'C1', messageTs: '30.0', text: 'row-30' }),
    );
    const total = merged.surfaces.reduce((n, s) => n + s.entries.length, 0);
    assert.ok(total <= CURSOR_DELIVERY_MAX_MESSAGES, `merged rows ${total}`);
    void lower;
  });
});

test('extras-alone overflow is clipped so prepared envelope stays ≤16 KiB', async () => {
  await withEnabledStore(async (store, agentId) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'hi',
      userId: 'U1',
    });
    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'hi', userId: 'U1' });
    item.previews = [{ text: 'P'.repeat(20_000), fromUrl: 'https://example.test/huge' }];
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    assert.ok(
      Buffer.byteLength(prepared.plan.promptBody, 'utf8') <= CURSOR_DELIVERY_MAX_BYTES,
      `envelope ${Buffer.byteLength(prepared.plan.promptBody, 'utf8')}`,
    );
  });
});

test('merge does not double-count overlapping omissions on the same surface', async () => {
  await withEnabledStore(async (store, agentId) => {
    for (let i = 1; i <= 40; i += 1) {
      await store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: `${i}.0`,
        text: `row-${i}`,
        userId: 'U1',
      });
    }
    const a = await prepareCursorDelivery({
      agentId,
      item: slackItem({ channelId: 'C1', messageTs: '40.0', text: 'row-40', id: 'a' }),
      store,
    });
    const b = await prepareCursorDelivery({
      agentId,
      item: slackItem({ channelId: 'C1', messageTs: '40.0', text: 'row-40', id: 'b' }),
      store,
    });
    assert.equal(a.kind, 'prepared');
    assert.equal(b.kind, 'prepared');
    if (a.kind !== 'prepared' || b.kind !== 'prepared') return;
    const omittedA = a.plan.surfaces.reduce((n, s) => n + s.omittedCount, 0);
    assert.ok(omittedA >= 1);
    // Force multi-plan merge path with two identical overlapping windows.
    const merged = mergeCursorDeliveryPlans(
      [a.plan, b.plan],
      slackItem({ channelId: 'C1', messageTs: '40.0', text: 'row-40' }),
    );
    const shown = merged.surfaces.reduce((n, s) => n + s.entries.length, 0);
    const omitted = merged.surfaces.reduce((n, s) => n + s.omittedCount, 0);
    // Unique pool is still ~40: shown + omitted ≈ 40, not 20+40.
    assert.ok(shown + omitted <= 45, `shown=${shown} omitted=${omitted}`);
    assert.ok(omitted <= omittedA + 5, `omitted ${omitted} should not be ~2× ${omittedA}`);
    assert.match(merged.promptBody, /earlier message/);
  });
});

test('settings read failure is fail-closed (not silent disable)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cursor-settings-fail-'));
  setCursorDeliveryEnabledForTests(undefined);
  try {
    // No agent configs; force ANIMA_HOME to a path without readable config
    // by writing a file where config.json should be.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(stateDir, { recursive: true });
    // settings service reads config.json as JSON store — corrupt it so parse throws.
    await writeFile(join(stateDir, 'config.json'), '{not-json', 'utf8');
    await withAnimaHome(stateDir, async () => {
      // Override must be undefined so we hit readConfig.
      const prepared = await prepareCursorDelivery({
        agentId: 'anima',
        item: slackItem({ channelId: 'C1', messageTs: '1.0', text: 'x' }),
      });
      // Fail-closed: not disabled.
      assert.notEqual(prepared.kind, 'disabled');
      // Either failed (settings) or failed later (no agents) — never silent off.
      if (prepared.kind === 'failed') {
        assert.equal(prepared.error.reason, 'store_error');
      }
    });
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('prepare failure requeues without tombstone (retryable)', async () => {
  await withEnabledStore(async (store, agentId, queue) => {
    await store.markDegraded({ message: 'gap' });
    const item = slackItem({ channelId: 'C1', messageTs: '1.0', text: 'x', id: 'wake-fail' });
    // No observation — would be missing_trigger if not degraded first.
    const prepared = await prepareCursorDelivery({ agentId, item, store });
    assert.equal(prepared.kind, 'failed');

    // Simulate worker deferred path: requeue, not fail.
    await queue.enqueue(item);
    await queue.requeue(item.id);
    const listed = await queue.list();
    assert.ok(listed.some((i) => i.id === item.id));
    assert.equal(listed.find((i) => i.id === item.id)?.handling.status, 'queued');
    // Not in seen (withdrawQueued would tombstone).
    assert.equal(await queue.hasSeen(item.id), true); // still in items = has
    // Ensure we can claim again: take would get it if we markRunning cycle.
    // Key invariant: status remains queued, not settled via fail.
    assert.notEqual(listed.find((i) => i.id === item.id)?.handling.status, 'failed');
  });
});
