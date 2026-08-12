import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';
import { waitFor } from './helpers/harness.js';
import {
  ControlledRuntime,
  enqueueInbox,
  ensureTestAgentConfig,
  queueFor,
  silentLogger,
  waitForInboxItemRemoved,
} from './helpers/runtime-worker.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import {
  prepareCursorDelivery,
  setCursorDeliveryEnabledForTests,
} from '../runtime/cursor-delivery.js';
import {
  backfillActiveSlackWakeJournal,
  compareSlackWakesForBackfill,
  eventIdForSlackWake,
} from '../runtime/cursor-wake-journal-backfill.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import {
  ObservedConversationStore,
  surfaceIdForObservation,
} from '../storage/schema/observed-conversation.store.js';
import type { SlackInboxItem } from '../../shared/inbox.js';

async function withHome<T>(body: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wake-backfill-'));
  try {
    return await withAnimaHome(stateDir, async () => body(stateDir));
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
}

function wake(partial: {
  channelId: string;
  messageTs: string;
  text: string;
  threadTs?: string;
  teamId?: string;
  userId?: string;
  id?: string;
  resumeReason?: 'runtime_restart';
}): SlackInboxItem {
  const teamId = partial.teamId ?? 'T1';
  const item = makeSlackEvent({
    channelId: partial.channelId,
    teamId,
    text: partial.text,
    ts: partial.messageTs,
    userId: partial.userId ?? 'U1',
    ...(partial.id ? { eventId: partial.id } : {}),
    ...(partial.threadTs ? { threadTs: partial.threadTs } : {}),
  });
  if (partial.resumeReason) {
    item.handling.resumeReason = partial.resumeReason;
  }
  return item;
}

test('compareSlackWakesForBackfill: surface then messageTs then id', () => {
  const a = wake({ channelId: 'C1', messageTs: '2.0', text: 'later' });
  const b = wake({ channelId: 'C1', messageTs: '1.0', text: 'earlier' });
  const c = wake({ channelId: 'C2', messageTs: '1.0', text: 'other' });
  const ordered = [a, c, b].sort(compareSlackWakesForBackfill);
  assert.deepEqual(
    ordered.map((item) => `${item.channelId}:${item.messageTs}`),
    ['C1:1.0', 'C1:2.0', 'C2:1.0'],
  );
});

test('backfill plants missing wakes in conversation order via normal observe; second pass is dedupe', async () => {
  await withHome(async (stateDir) => {
    await ensureTestAgentConfig({ agentId: 'scout', stateDir });
    const queue = new WakeQueueService('scout');
    const store = new ObservedConversationStore('scout');

    // Enqueue out of chronological order on the same surface.
    await queue.enqueue(wake({
      channelId: 'C1',
      messageTs: '20.0',
      text: 'second',
      id: 'slack:T1:C1:20.0',
    }));
    await queue.enqueue(wake({
      channelId: 'C1',
      messageTs: '10.0',
      text: 'first',
      id: 'slack:T1:C1:10.0',
    }));
    await queue.enqueue(wake({
      channelId: 'C1',
      messageTs: '30.0',
      text: 'third',
      id: 'slack:T1:C1:30.0',
    }));

    const first = await backfillActiveSlackWakeJournal({
      agentId: 'scout',
      queue,
      store,
      logger: silentLogger,
    });
    assert.equal(first.examined, 3);
    assert.equal(first.appended, 3);
    assert.equal(first.skipped, 0);
    assert.equal(first.failed, 0);

    const surfaceId = surfaceIdForObservation({
      channelId: 'C1',
      messageTs: '10.0',
      teamId: 'T1',
    });
    const rows = await store.readJournal(surfaceId, { limit: 100 });
    assert.deepEqual(
      rows.map((row) => ({ ordinal: row.ordinal, ts: row.messageTs, text: row.text })),
      [
        { ordinal: 1, ts: '10.0', text: 'first' },
        { ordinal: 2, ts: '20.0', text: 'second' },
        { ordinal: 3, ts: '30.0', text: 'third' },
      ],
    );

    const second = await backfillActiveSlackWakeJournal({
      agentId: 'scout',
      queue,
      store,
      logger: silentLogger,
    });
    assert.equal(second.appended, 0);
    assert.equal(second.skipped, 3);
    assert.equal(second.failed, 0);
  });
});

test('without backfill prepare fails missing_trigger; after backfill prepare succeeds (fail-closed preserved)', async () => {
  await withHome(async (stateDir) => {
    await ensureTestAgentConfig({ agentId: 'scout', stateDir });
    setCursorDeliveryEnabledForTests(true);
    try {
      const queue = new WakeQueueService('scout');
      const store = new ObservedConversationStore('scout');
      const item = wake({
        channelId: 'C1',
        messageTs: '42.0',
        text: 'pre-journal wake',
        id: 'slack:T1:C1:42.0',
      });
      await queue.enqueue(item);

      const missing = await prepareCursorDelivery({ agentId: 'scout', item, store });
      assert.equal(missing.kind, 'failed');
      if (missing.kind === 'failed') {
        assert.equal(missing.error.reason, 'missing_trigger_observation');
      }

      const backfill = await backfillActiveSlackWakeJournal({
        agentId: 'scout',
        queue,
        store,
        logger: silentLogger,
      });
      assert.equal(backfill.appended, 1);

      const prepared = await prepareCursorDelivery({ agentId: 'scout', item, store });
      assert.equal(prepared.kind, 'prepared');

      // Ghost wake never in the active queue still fails closed.
      const ghost = wake({
        channelId: 'C1',
        messageTs: '99.0',
        text: 'not queued',
        id: 'slack:T1:C1:99.0',
      });
      const ghostPrep = await prepareCursorDelivery({ agentId: 'scout', item: ghost, store });
      assert.equal(ghostPrep.kind, 'failed');
      if (ghostPrep.kind === 'failed') {
        assert.equal(ghostPrep.error.reason, 'missing_trigger_observation');
      }
    } finally {
      setCursorDeliveryEnabledForTests(undefined);
    }
  });
});

test('pin: restart-before-journal → restart → recovered wake runs and later queue drains', async () => {
  await withHome(async (stateDir) => {
    const agentId = 'scout';
    const coordinator = { agentId, stateDir };
    await ensureTestAgentConfig(coordinator);
    setCursorDeliveryEnabledForTests(true);

    let worker: AgentRuntimeWorker | undefined;
    try {
      // Active wake created before any journal row existed (canary shape).
      // Quiet-requeue path already cleared resumeReason — must not rely on it.
      const recovered = wake({
        channelId: 'D-user',
        messageTs: '1770000010.000001',
        text: 'recovered pre-journal wake',
        teamId: 'T-demo',
        id: 'slack:T-demo:D-user:1770000010.000001',
      });
      // Simulate a prior prepare-fail quiet requeue: queued, no resumeReason.
      assert.equal(recovered.handling.resumeReason, undefined);

      await enqueueInbox(recovered, coordinator);

      // Later wake enqueued after restart (still pre-journal until backfill).
      const later = wake({
        channelId: 'D-user',
        messageTs: '1770000011.000001',
        text: 'later wake after recovered',
        teamId: 'T-demo',
        id: 'slack:T-demo:D-user:1770000011.000001',
      });
      await enqueueInbox(later, coordinator);

      // Prove journal empty before worker start.
      const store = new ObservedConversationStore(agentId);
      const surfaceId = surfaceIdForObservation({
        channelId: 'D-user',
        messageTs: recovered.messageTs,
        teamId: 'T-demo',
      });
      assert.equal((await store.readJournal(surfaceId, { limit: 10 })).length, 0);

      // Without backfill, prepare would fail closed.
      const before = await prepareCursorDelivery({
        agentId,
        item: recovered,
        store,
      });
      assert.equal(before.kind, 'failed');
      if (before.kind === 'failed') {
        assert.equal(before.error.reason, 'missing_trigger_observation');
      }

      const runtime = new ControlledRuntime();
      worker = new AgentRuntimeWorker({
        agentId,
        agentRuntime: runtime,
        pollIntervalMs: 60_000,
        queue: queueFor(agentId),
        stateDir,
        workerId: 'resume-worker',
      }, silentLogger);

      // drainOnce awaits pre-drain backfill then claims.
      const drain = worker.drainOnce();
      await waitFor(() => runtime.calls.length === 1, { timeoutMs: 5_000 });
      assert.match(runtime.calls[0]?.prompt ?? '', /recovered pre-journal wake/);
      // Journal now holds both (backfill ran before claim).
      const rows = await store.readJournal(surfaceId, { limit: 10 });
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.messageTs), [
        recovered.messageTs,
        later.messageTs,
      ]);
      assert.equal(eventIdForSlackWake(recovered), rows[0]?.eventId);

      runtime.finishNext();
      await waitFor(() => runtime.calls.length === 2, { timeoutMs: 5_000 });
      assert.match(runtime.calls[1]?.prompt ?? '', /later wake after recovered/);
      runtime.finishNext();
      assert.equal(await drain, 2);

      await waitForInboxItemRemoved(agentId, recovered.id);
      await waitForInboxItemRemoved(agentId, later.id);
      // Queue fully drained — not stuck on quiet-requeue head.
      assert.equal((await queueFor(agentId).list()).length, 0);
    } finally {
      setCursorDeliveryEnabledForTests(undefined);
      await worker?.close();
    }
  });
});

test('pin: start() path also backfills before first automatic drain', async () => {
  await withHome(async (stateDir) => {
    const agentId = 'scout';
    const coordinator = { agentId, stateDir };
    await ensureTestAgentConfig(coordinator);
    setCursorDeliveryEnabledForTests(true);
    let worker: AgentRuntimeWorker | undefined;
    try {
      const item = wake({
        channelId: 'D-user',
        messageTs: '1770000020.000001',
        text: 'start-path pre-journal',
        teamId: 'T-demo',
        id: 'slack:T-demo:D-user:1770000020.000001',
      });
      await enqueueInbox(item, coordinator);

      const runtime = new ControlledRuntime();
      worker = new AgentRuntimeWorker({
        agentId,
        agentRuntime: runtime,
        pollIntervalMs: 60_000,
        queue: queueFor(agentId),
        stateDir,
        workerId: 'start-path-worker',
      }, silentLogger);
      worker.start();

      await waitFor(() => runtime.calls.length === 1, { timeoutMs: 5_000 });
      assert.match(runtime.calls[0]?.prompt ?? '', /start-path pre-journal/);
      runtime.finishNext();
      await waitForInboxItemRemoved(agentId, item.id);
    } finally {
      setCursorDeliveryEnabledForTests(undefined);
      await worker?.close();
    }
  });
});
