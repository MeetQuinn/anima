import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { InboxItem } from '../../shared/inbox.js';
import { isDeferredQueuedInboxItem } from '../../shared/inbox.js';
import { retryDeferredWakeNow } from '../inbox/deferred-wake-retry.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import {
  prepareCursorDelivery,
  setCursorDeliveryEnabledForTests,
} from '../runtime/cursor-delivery.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import {
  WakeQueueStore,
  type WakeQueueFile,
  type WakeQueueSeenMarker,
} from '../storage/schema/wake-queue.store.js';
import { observedConversationStoreForAgent } from '../storage/schema/observed-conversation.store.js';
import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';

function memoryWakeQueueStore(
  initialItems: Record<string, InboxItem> = {},
  initialSeen: Record<string, WakeQueueSeenMarker> = {},
) {
  let state: WakeQueueFile = { items: { ...initialItems }, seen: { ...initialSeen } };
  let previousUpdate = Promise.resolve();
  return {
    async read() {
      return state;
    },
    async update(op: (current: WakeQueueFile) => WakeQueueFile | Promise<WakeQueueFile>) {
      const currentUpdate = previousUpdate.then(async () => {
        state = await op(state);
      });
      previousUpdate = currentUpdate.then(() => undefined, () => undefined);
      await currentUpdate;
      return state;
    },
  };
}

function queueFor(agentId: string): WakeQueueService {
  return new WakeQueueService(
    agentId,
    new WakeQueueStore(agentId, memoryWakeQueueStore()),
    { recordInboxItem: async () => undefined },
  );
}

test('Retry now atomically settles the deferred item and enqueues a unique deferred_retry wake', async () => {
  const agentId = 'scout';
  const queue = queueFor(agentId);
  const event = makeSlackEvent({
    channelId: 'C-team',
    eventId: 'slack:T-demo:C-team:1770000010.000001',
    teamId: 'T-demo',
    text: 'please handle this',
    threadTs: '1770000009.000001',
    ts: '1770000010.000001',
    userId: 'U1',
  });
  assert.equal((await queue.enqueue(event)).queued, true);
  const claimed = await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'w1' });
  assert.equal(claimed?.id, event.id);

  const resumeAt = new Date(Date.now() + 60 * 60_000);
  await queue.requeueDeferred(event.id, { deferrals: 2, notBefore: resumeAt.toISOString() });
  assert.equal(isDeferredQueuedInboxItem((await queue.find(event.id))!), true);

  // Patch service to use this in-memory queue by swapping through store API directly
  // for the atomicity pin, then exercise the public helper against a real home.
  const swap = await queue.swapDeferredForRetry(event.id, (previous, now) => {
    assert.equal(previous.kind, 'slack');
    return {
      ...previous,
      handling: {
        createdAt: now,
        queuedAt: now,
        resumeReason: 'deferred_retry',
        status: 'queued',
        updatedAt: now,
      },
      id: 'slack-deferred-retry_test1',
      receivedAt: now,
    };
  });
  assert.equal(swap.kind, 'ok');
  if (swap.kind !== 'ok') return;

  assert.equal(await queue.find(event.id), undefined, 'deferred item left the active queue');
  const retry = await queue.find(swap.retry.id);
  assert.ok(retry);
  assert.equal(retry?.handling.resumeReason, 'deferred_retry');
  assert.equal(retry?.handling.notBefore, undefined);
  assert.equal(retry?.kind, 'slack');
  if (retry?.kind === 'slack') {
    assert.equal(retry.channelId, 'C-team');
    assert.equal(retry.messageTs, '1770000010.000001');
    assert.equal(retry.threadTs, '1770000009.000001');
    assert.equal(retry.text, 'please handle this');
  }

  // Old item cannot run even after notBefore would have elapsed.
  const late = await queue.takeNextRunnable({
    isWorkerAlive: () => true,
    now: new Date(resumeAt.getTime() + 1_000),
    workerId: 'w1',
  });
  assert.equal(late?.id, swap.retry.id);
  assert.notEqual(late?.id, event.id);

  // Second swap on the settled id fails cleanly (idempotent / 409 path).
  const again = await queue.swapDeferredForRetry(event.id, (previous) => previous);
  assert.equal(again.kind, 'not_found');
});

test('Retry now rejects non-deferred and concurrent claim races', async () => {
  const queue = queueFor('scout');
  const event = makeSlackEvent({
    channelId: 'C-team',
    eventId: 'slack:T-demo:C-team:1770000020.000001',
    teamId: 'T-demo',
    text: 'plain',
    ts: '1770000020.000001',
    userId: 'U1',
  });
  await queue.enqueue(event);
  assert.equal(
    (await queue.swapDeferredForRetry(event.id, (p) => p)).kind,
    'not_deferred',
  );

  await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'w1' });
  const claimed = await queue.find(event.id);
  assert.equal(claimed?.handling.status, 'running');
  // Post-claim swap must report race (workerId present), not silently no-op.
  assert.equal(
    (await queue.swapDeferredForRetry(event.id, (p) => p)).kind,
    'race',
  );
});

test('Retry now CAS: only one of two parallel swaps wins', async () => {
  const queue = queueFor('scout');
  const event = makeSlackEvent({
    channelId: 'C-team',
    eventId: 'slack:T-demo:C-team:1770000021.000001',
    teamId: 'T-demo',
    text: 'double click',
    ts: '1770000021.000001',
    userId: 'U1',
  });
  await queue.enqueue(event);
  await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'w1' });
  await queue.requeueDeferred(event.id, {
    deferrals: 1,
    notBefore: new Date(Date.now() + 3_600_000).toISOString(),
  });

  let buildCount = 0;
  const build = (previous: InboxItem, now: string): InboxItem => {
    buildCount += 1;
    assert.equal(previous.kind, 'slack');
    return {
      ...previous,
      handling: {
        createdAt: now,
        queuedAt: now,
        resumeReason: 'deferred_retry',
        status: 'queued',
        updatedAt: now,
      },
      id: `slack-deferred-retry_parallel_${buildCount}`,
      receivedAt: now,
    };
  };

  const [first, second] = await Promise.all([
    queue.swapDeferredForRetry(event.id, build),
    queue.swapDeferredForRetry(event.id, build),
  ]);
  const kinds = [first.kind, second.kind].sort();
  assert.deepEqual(kinds, ['not_found', 'ok']);
  const winner = first.kind === 'ok' ? first : second.kind === 'ok' ? second : undefined;
  assert.ok(winner && winner.kind === 'ok');
  if (!winner || winner.kind !== 'ok') return;
  assert.equal(await queue.find(event.id), undefined);
  assert.ok(await queue.find(winner.retry.id));
});

test('retryDeferredWakeNow rejects deferred reminder (unsupported kind)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-deferred-retry-reminder-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const agentId = 'anima';
      const queue = new WakeQueueService(agentId);
      const now = new Date().toISOString();
      const notBefore = new Date(Date.now() + 3_600_000).toISOString();
      const reminder: InboxItem = {
        id: 'reminder:penny:fire:1',
        kind: 'reminder',
        receivedAt: now,
        reminderId: 'penny',
        title: 'Penny deferred',
        handling: {
          createdAt: now,
          queuedAt: now,
          status: 'queued',
          updatedAt: now,
          deferrals: 1,
          notBefore,
        },
      };
      assert.equal((await queue.enqueue(reminder)).queued, true);
      assert.equal(isDeferredQueuedInboxItem((await queue.find(reminder.id))!), true);

      const result = await retryDeferredWakeNow(agentId, reminder.id);
      assert.equal(result.kind, 'conflict');
      if (result.kind === 'conflict') assert.equal(result.reason, 'unsupported_kind');
      // Reminder stays deferred and actionable UI must not surface it.
      assert.equal(isDeferredQueuedInboxItem((await queue.find(reminder.id))!), true);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('deferred_retry bypasses cursor already_delivered and frames the missed request', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-deferred-retry-'));
  try {
    await withAnimaHome(stateDir, async () => {
      setCursorDeliveryEnabledForTests(true);
      const agentId = 'anima';
      const store = observedConversationStoreForAgent(agentId);
      await store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: '1.0',
        text: 'missed request',
        userId: 'U1',
      });
      await store.advanceCursor({
        surfaceId: 'slack:T1:C1',
        expected: { status: 'absent' },
        nextDeliveredOrdinal: 1,
        lastDeliveredEventId: 'slack:T1:C1:1.0',
        lastDeliveredMessageTs: '1.0',
      });

      const item = makeSlackEvent({
        channelId: 'C1',
        eventId: 'slack-deferred-retry_cursor',
        teamId: 'T1',
        text: 'missed request',
        ts: '1.0',
        userId: 'U1',
      });
      item.handling.resumeReason = 'deferred_retry';

      const prepared = await prepareCursorDelivery({ agentId, item, store });
      assert.notEqual(prepared.kind, 'already_delivered');
      assert.equal(prepared.kind, 'prepared');

      const prompt = buildCodeAgentDeliveryPrompt(item, {
        cursorDeliveryPromptBody: prepared.kind === 'prepared' ? prepared.plan.promptBody : undefined,
      });
      assert.match(prompt, /Deferred wake retry:/);
      assert.match(prompt, /Retry now|rate-limit|missed request/i);
      assert.match(prompt, /channel_id=C1/);
      assert.match(prompt, /message_ts=1\.0/);
    });
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('retryDeferredWakeNow end-to-end against a real agent home queue', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-deferred-retry-e2e-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const agentId = 'anima';
      const queue = new WakeQueueService(agentId);
      const event = makeSlackEvent({
        channelId: 'C-retry',
        eventId: 'slack:T-demo:C-retry:1770000030.000001',
        teamId: 'T-demo',
        text: 'celery path',
        threadTs: '1770000029.000001',
        ts: '1770000030.000001',
        userId: 'U1',
      });
      assert.equal((await queue.enqueue(event)).queued, true);
      await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'w1' });
      await queue.requeueDeferred(event.id, {
        deferrals: 1,
        notBefore: new Date(Date.now() + 3_600_000).toISOString(),
      });

      const result = await retryDeferredWakeNow(agentId, event.id);
      assert.equal(result.kind, 'retried');
      if (result.kind !== 'retried') return;
      assert.equal(result.previousItemId, event.id);
      assert.notEqual(result.retryItemId, event.id);
      assert.match(result.retryItemId, /^slack-deferred-retry_/);

      assert.equal(await queue.find(event.id), undefined);
      const retry = await queue.find(result.retryItemId);
      assert.equal(retry?.handling.resumeReason, 'deferred_retry');
      assert.equal(isDeferredQueuedInboxItem(retry!), false);

      // True unknown after settle → not_found (HTTP 404). Lost-CAS uses `gone`.
      const conflict = await retryDeferredWakeNow(agentId, event.id);
      assert.equal(conflict.kind, 'conflict');
      if (conflict.kind === 'conflict') assert.equal(conflict.reason, 'not_found');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('parallel retryDeferredWakeNow: loser is gone, not not_found', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-deferred-retry-cas-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const agentId = 'anima';
      const queue = new WakeQueueService(agentId);
      const event = makeSlackEvent({
        channelId: 'C-cas',
        eventId: 'slack:T-demo:C-cas:1770000040.000001',
        teamId: 'T-demo',
        text: 'double click http',
        ts: '1770000040.000001',
        userId: 'U1',
      });
      assert.equal((await queue.enqueue(event)).queued, true);
      await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'w1' });
      await queue.requeueDeferred(event.id, {
        deferrals: 1,
        notBefore: new Date(Date.now() + 3_600_000).toISOString(),
      });

      const [a, b] = await Promise.all([
        retryDeferredWakeNow(agentId, event.id),
        retryDeferredWakeNow(agentId, event.id),
      ]);
      const kinds = [a.kind, b.kind].sort();
      assert.deepEqual(kinds, ['conflict', 'retried']);
      const loser = a.kind === 'conflict' ? a : b.kind === 'conflict' ? b : undefined;
      assert.ok(loser && loser.kind === 'conflict');
      if (!loser || loser.kind !== 'conflict') return;
      assert.equal(loser.reason, 'gone');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});
