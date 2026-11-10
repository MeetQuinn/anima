import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';
import { sleep, waitFor } from './helpers/harness.js';
import { allActivities, loadState } from './helpers/state.js';
import type { WakeQueueService } from '../inbox/wake-queue.service.js';
import type { AgentRuntime } from '../providers/contract.js';
import { startActiveRunControl } from '../runtime/active-run-control.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { STALLED_RUN_NOTE } from '../runtime/delivery-notes.js';
import { WakeQueueStore } from '../storage/schema/wake-queue.store.js';
import type { RuntimeWorkerConfig } from '../runtime/types.js';
import {
  WedgedFollowupRuntime,
  enqueueInbox,
  queueFor,
  silentLogger,
  waitForInboxItemAppendedTo,
  waitForInboxItemRemoved,
} from './helpers/runtime-worker.js';

const STALLED_NOTE_START = STALLED_RUN_NOTE.split('\n')[0] ?? '';

function slackMessage(eventId: string, text: string, ts: string) {
  return makeSlackEvent({ channelId: 'D-user', eventId, teamId: 'T-demo', text, ts, userId: 'U1' });
}

async function abortedActivities(): Promise<Array<Record<string, unknown>>> {
  return allActivities(await loadState())
    .filter((activity) => activity.type === 'runtime.aborted')
    .map((activity) => activity.payload ?? {});
}

async function withWorker(
  name: string,
  runtime: WedgedFollowupRuntime,
  timeouts: { idleTimeoutMs: number; stallTimeoutMs: number },
  body: (worker: AgentRuntimeWorker, coordinator: RuntimeWorkerConfig) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), `anima-worker-stall-${name}-`));
  const coordinator: RuntimeWorkerConfig = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        ...timeouts,
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      await body(worker, coordinator);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
}

test('a silent run with an appended follow-up waiting is stopped, and the follow-up runs next with a note', async () => {
  const runtime = new WedgedFollowupRuntime({ outputOnAbort: true });
  await withWorker('appended', runtime, { idleTimeoutMs: 60_000, stallTimeoutMs: 1_500 }, async (worker, coordinator) => {
    const first = await enqueueInbox(slackMessage('evt-stuck', 'find that file', '1770000010.000001'), coordinator);
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    const second = await enqueueInbox(slackMessage('evt-hung', 'are you stuck?', '1770000011.000001'), coordinator);
    await waitForInboxItemAppendedTo('scout', second.ctx.item.id, first.ctx.item.id);
    assert.deepEqual(await abortedActivities(), [], 'the run is not stopped before the stall window');

    await waitFor(() => runtime.calls.length === 2, { description: 'the follow-up to run next', timeoutMs: 5_000 });
    assert.equal(await drain, 2);

    const [aborted] = await abortedActivities();
    assert.equal(aborted?.['reason'], 'stalled');
    assert.equal(aborted?.['itemId'], first.ctx.item.id);
    assert.equal(aborted?.['timeoutMs'], 1_500);
    assert.equal(aborted?.['requeuedFollowups'], 1);
    assert.equal(await queueFor('scout').find(first.ctx.item.id), undefined);
    assert.equal(runtime.calls[1]?.itemId, second.ctx.item.id);
    assert.ok(runtime.calls[1]?.prompt.startsWith(STALLED_NOTE_START), runtime.calls[1]?.prompt);
    assert.match(runtime.calls[1]?.prompt ?? '', /are you stuck\?/);
  });
});

test('a message queued behind a silent run that cannot take it also stops the run', async () => {
  const runtime = new WedgedFollowupRuntime({ acceptFollowups: false });
  await withWorker('queued', runtime, { idleTimeoutMs: 60_000, stallTimeoutMs: 300 }, async (worker, coordinator) => {
    const first = await enqueueInbox(slackMessage('evt-stuck', 'find that file', '1770000010.000001'), coordinator);
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    const second = await enqueueInbox(slackMessage('evt-hung', 'are you stuck?', '1770000011.000001'), coordinator);

    await waitFor(() => runtime.calls.length === 2, { description: 'the queued message to run next', timeoutMs: 5_000 });
    assert.equal(await drain, 2);
    const [aborted] = await abortedActivities();
    assert.equal(aborted?.['reason'], 'stalled');
    assert.equal(aborted?.['requeuedFollowups'], undefined);
    assert.equal(await queueFor('scout').find(first.ctx.item.id), undefined);
    assert.equal(runtime.calls[1]?.itemId, second.ctx.item.id);
    assert.ok(!runtime.calls[1]?.prompt.includes(STALLED_NOTE_START), 'a queued message was never handed to the stopped run');
  });
});

test('a silent run with no message waiting is left for the idle timeout', async () => {
  const runtime = new WedgedFollowupRuntime();
  await withWorker('nothing-waiting', runtime, { idleTimeoutMs: 1_200, stallTimeoutMs: 100 }, async (worker, coordinator) => {
    const first = await enqueueInbox(slackMessage('evt-quiet', 'long quiet task', '1770000010.000001'), coordinator);
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    // fixed delay: several stall windows pass with nothing waiting on the run.
    await sleep(500);
    assert.deepEqual(await abortedActivities(), []);

    await waitForInboxItemRemoved('scout', first.ctx.item.id, 5_000);
    assert.equal(await drain, 1);
    const [aborted] = await abortedActivities();
    assert.equal(aborted?.['reason'], 'idle_timeout');
    assert.equal(aborted?.['timeoutMs'], 1_200);
  });
});

test('accepting follow-ups does not reset the idle watchdog, and the unseen ones are requeued with one note', async () => {
  const runtime = new WedgedFollowupRuntime();
  await withWorker('idle', runtime, { idleTimeoutMs: 1_000, stallTimeoutMs: 60_000 }, async (worker, coordinator) => {
    const first = await enqueueInbox(slackMessage('evt-stuck', 'find that file', '1770000010.000001'), coordinator);
    const startedAt = Date.now();
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    // Keep messages arriving well past the idle timeout. Before the fix each
    // accepted follow-up reset the watchdog, so this run never timed out.
    let sent = 0;
    while ((await abortedActivities()).length === 0 && Date.now() - startedAt < 4_000) {
      sent += 1;
      await enqueueInbox(slackMessage(`evt-ping-${sent}`, `ping ${sent}`, `177000002${sent}.000001`), coordinator);
      // fixed delay: one message every quarter second.
      await sleep(250);
    }
    const abortedAfterMs = Date.now() - startedAt;
    const [aborted] = await abortedActivities();
    assert.equal(aborted?.['reason'], 'idle_timeout');
    assert.ok(abortedAfterMs < 2_500, `idle timeout fired after ${abortedAfterMs}ms`);
    const requeued = aborted?.['requeuedFollowups'];
    assert.ok(typeof requeued === 'number' && requeued >= 1, `requeued ${String(requeued)}`);

    await drain;
    await waitFor(async () => (await queueFor('scout').list()).length === 0, { description: 'every message to run', timeoutMs: 5_000 });
    assert.equal(await queueFor('scout').find(first.ctx.item.id), undefined);
    const firstRunFollowups = runtime.followups.filter((followup) => followup.activeItemId === first.ctx.item.id);
    const laterPrompts = [
      ...runtime.calls.slice(1).map((call) => call.prompt),
      ...runtime.followups.filter((followup) => followup.activeItemId !== first.ctx.item.id).map((followup) => followup.prompt),
    ];
    assert.equal(firstRunFollowups.length, requeued, 'every follow-up the stopped run took is requeued');
    assert.equal(laterPrompts.filter((prompt) => prompt.includes(STALLED_NOTE_START)).length, 1, 'the note shows once');
    for (let index = 1; index <= sent; index += 1) {
      assert.ok(laterPrompts.some((prompt) => prompt.includes(`ping ${index}`)), `ping ${index} was answered`);
    }
  });
});

test('an operator restart requeues follow-ups the provider never reached and fails the ones it did', async () => {
  const runtime = new WedgedFollowupRuntime({ outputOnAbort: true });
  await withWorker('restart', runtime, { idleTimeoutMs: 60_000, stallTimeoutMs: 60_000 }, async (worker, coordinator) => {
    const first = await enqueueInbox(slackMessage('evt-stuck', 'find that file', '1770000010.000001'), coordinator);
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    const seen = await enqueueInbox(slackMessage('evt-seen', 'seen before the hang', '1770000011.000001'), coordinator);
    await waitForInboxItemAppendedTo('scout', seen.ctx.item.id, first.ctx.item.id);
    // fixed delay: keep the provider's activity strictly after the first append.
    await sleep(5);
    await runtime.emitActivity();
    // fixed delay: keep the next append strictly after that activity.
    await sleep(5);
    const unseen = await enqueueInbox(slackMessage('evt-unseen', 'sent after the hang', '1770000012.000001'), coordinator);
    await waitForInboxItemAppendedTo('scout', unseen.ctx.item.id, first.ctx.item.id);

    await worker.close({ abortReason: 'operator_restart' });
    await drain;

    const [aborted] = await abortedActivities();
    assert.equal(aborted?.['reason'], 'operator_restart');
    assert.equal(aborted?.['requeuedFollowups'], 1);
    assert.equal(await queueFor('scout').find(first.ctx.item.id), undefined);
    assert.equal(await queueFor('scout').find(seen.ctx.item.id), undefined);
    const requeued = await queueFor('scout').find(unseen.ctx.item.id);
    assert.equal(requeued?.handling.status, 'queued');
    assert.equal(requeued?.handling.appendedToItemId, undefined);
    assert.equal(requeued?.handling.resumeReason, undefined, 'only no-progress stops add the note');
  });
});

test('a user stop still ends follow-ups appended to the run', async () => {
  const runtime = new WedgedFollowupRuntime();
  await withWorker('user-stop', runtime, { idleTimeoutMs: 60_000, stallTimeoutMs: 60_000 }, async (worker, coordinator) => {
    const first = await enqueueInbox(slackMessage('evt-stuck', 'find that file', '1770000010.000001'), coordinator);
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    const second = await enqueueInbox(slackMessage('evt-second', 'never mind', '1770000011.000001'), coordinator);
    await waitForInboxItemAppendedTo('scout', second.ctx.item.id, first.ctx.item.id);

    await queueFor('scout').requestStop(first.ctx.item.id);
    await waitForInboxItemRemoved('scout', first.ctx.item.id, 5_000);
    assert.equal(await drain, 1);
    const [aborted] = await abortedActivities();
    assert.equal(aborted?.['reason'], 'user_stop');
    assert.equal(aborted?.['requeuedFollowups'], undefined);
    assert.equal(await queueFor('scout').find(second.ctx.item.id), undefined);
    assert.equal(runtime.calls.length, 1);
  });
});

test('a follow-up the provider acted on before its append was recorded ends with the run instead of running again', async () => {
  const runtime = new WedgedFollowupRuntime({ activityDuringAppend: true });
  await withWorker('append-boundary', runtime, { idleTimeoutMs: 60_000, stallTimeoutMs: 60_000 }, async (worker, coordinator) => {
    const first = await enqueueInbox(slackMessage('evt-stuck', 'find that file', '1770000010.000001'), coordinator);
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    const seen = await enqueueInbox(slackMessage('evt-seen', 'answered during the append', '1770000011.000001'), coordinator);
    await waitForInboxItemAppendedTo('scout', seen.ctx.item.id, first.ctx.item.id);

    await worker.close({ abortReason: 'operator_restart' });
    await drain;

    const [aborted] = await abortedActivities();
    assert.equal(aborted?.['reason'], 'operator_restart');
    assert.equal(aborted?.['requeuedFollowups'], undefined);
    assert.equal(await queueFor('scout').find(seen.ctx.item.id), undefined);
    assert.equal(runtime.calls.length, 1);
  });
});

for (const order of ['started', 'requested'] as const) {
  test(`a stall check does not stop a run whose restart drain was ${order} while it read the queue`, async () => {
    const drainRequestedAt = '2026-11-10T00:00:00.000Z';
    const running = { id: 'parent', kind: 'slack', handling: { status: 'running' } };
    const draining = { ...running, handling: { ...running.handling, drainRequestedAt, drainTimeoutMs: 5_000 } };
    const waiting = { id: 'child', kind: 'slack', handling: { status: 'queued' } };
    let drainWritten = false;
    let drainCalls = 0;
    let listing = false;
    let releaseList!: (items: unknown[]) => void;
    let releaseDrain!: () => void;
    const listed = new Promise<unknown[]>((resolve) => { releaseList = resolve; });
    const drained = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const abortController = new AbortController();
    const handle = startActiveRunControl({
      abortController,
      agentRuntime: { requestDrain: async () => { drainCalls += 1; await drained; } } as unknown as AgentRuntime,
      idleTimeoutMs: 60_000,
      itemId: 'parent',
      logger: silentLogger,
      queue: {
        find: async () => (drainWritten ? draining : running),
        list: async () => { listing = true; return listed; },
      } as unknown as WakeQueueService,
      stallTimeoutMs: 100,
    });
    try {
      await waitFor(() => listing, { description: 'the stall check to read the queue' });
      drainWritten = true;
      if (order === 'started') {
        await waitFor(() => drainCalls === 1, { description: 'the drain to start during the read' });
        releaseList([waiting]);
      } else {
        // The read already returns the drain request; this run has not started it yet.
        releaseList([draining, waiting]);
      }
      // fixed delay: several watchdog ticks after the read returned.
      await sleep(200);
      assert.equal(abortController.signal.aborted, false, 'the stall check left the run to the drain');
      assert.equal(drainCalls, 1);
      releaseDrain();
      await waitFor(() => abortController.signal.aborted, { description: 'the drain to stop the run' });
      assert.equal(abortController.signal.reason, 'restart_drain');
    } finally {
      handle.release();
      releaseDrain();
    }
  });
}

test('requeueAppendedSince requeues only appends after the cut and marks the earliest one', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wake-queue-appended-since-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const coordinator: RuntimeWorkerConfig = { agentId: 'scout', stateDir };
      const store = new WakeQueueStore('scout');
      const parent = await enqueueInbox(slackMessage('evt-parent', 'parent', '1770000010.000001'), coordinator);
      const early = await enqueueInbox(slackMessage('evt-early', 'early', '1770000011.000001'), coordinator);
      const atCut = await enqueueInbox(slackMessage('evt-at-cut', 'at the cut', '1770000011.500001'), coordinator);
      const late = await enqueueInbox(slackMessage('evt-late', 'late', '1770000012.000001'), coordinator);
      const later = await enqueueInbox(slackMessage('evt-later', 'later', '1770000013.000001'), coordinator);
      await store.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'w' });
      const appendNow = async (itemId: string, appendedAt: string) => {
        await store.takeQueuedBatch({ activeItemId: parent.ctx.item.id, itemIds: [itemId], workerId: 'w' });
        await store.markAppendedBatch({ appendedAt, itemIds: [itemId], parentItemId: parent.ctx.item.id, workerId: 'w' });
      };
      const since = '2026-11-10T00:00:00.000Z';
      await appendNow(early.ctx.item.id, '2026-11-09T23:59:59.999Z');
      await appendNow(atCut.ctx.item.id, since);
      await appendNow(late.ctx.item.id, '2026-11-10T00:00:00.001Z');
      await appendNow(later.ctx.item.id, '2026-11-10T00:00:00.002Z');

      const requeued = await store.requeueAppendedSince(parent.ctx.item.id, since, { resumeReason: 'stalled_run' });
      assert.deepEqual(requeued.map((item) => item.id), [late.ctx.item.id, later.ctx.item.id]);
      assert.equal((await store.find(early.ctx.item.id))?.handling.appendedToItemId, parent.ctx.item.id);
      assert.equal((await store.find(atCut.ctx.item.id))?.handling.appendedToItemId, parent.ctx.item.id, 'activity at the delivery time may have answered it');
      assert.equal((await store.find(late.ctx.item.id))?.handling.resumeReason, 'stalled_run');
      assert.equal((await store.find(later.ctx.item.id))?.handling.resumeReason, undefined);
      assert.equal((await store.find(later.ctx.item.id))?.handling.status, 'queued');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});
