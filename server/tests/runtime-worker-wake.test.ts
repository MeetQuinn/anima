import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';
import { sleep, waitFor } from './helpers/harness.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { onWake } from '../inbox/wake-signal.js';
import { allActivities, loadState } from './helpers/state.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { clearRestartDrain, requestRestartDrain } from '../services/restart-drain.js';
import { findActiveRuntimeItem } from '../runtime/active-item.js';
import { removeProcessingReactions } from '../runtime/processing-reactions.js';
import {
  AbortableRuntime,
  CloseOptionsRuntime,
  ControlledRuntime,
  DrainableRuntime,
  NullReadEnqueueQueue,
  enqueueInbox,
  ensureTestAgentConfig,
  queueFor,
  silentLogger,
  waitForInboxItemRemoved,
  waitForInboxItemStatus,
} from './helpers/runtime-worker.js';

test('runtime worker wakes on enqueue without waiting for poll interval', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-wake-signal-test-'));
  const runtime = new ControlledRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        pollIntervalMs: 60_000,
        queue: queueFor('scout'),
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      worker.start();

      const decision = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-user',
          eventId: 'evt-wake-signal',
          teamId: 'T-demo',
          text: 'wake now',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );

      await waitFor(() => runtime.calls.length === 1);
      assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'running');
      runtime.finishNext();
      await waitForInboxItemRemoved('scout', decision.ctx.item.id);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker re-drains when a wake arrives before active drain clears', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-pending-redrain-test-'));
  const runtime = new ControlledRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  const second = makeSlackEvent({
    channelId: 'D-user',
    eventId: 'evt-pending-redrain-second',
    teamId: 'T-demo',
    text: 'second prompt',
    ts: '1770000011.000001',
    userId: 'U1',
  });
  const queue = new NullReadEnqueueQueue('scout', () => runtime.completed === 1, second);
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        pollIntervalMs: 60_000,
        queue,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      worker.start();

      await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-user',
          eventId: 'evt-pending-redrain-first',
          teamId: 'T-demo',
          text: 'first prompt',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );

      await waitFor(() => runtime.calls.length === 1);
      runtime.finishNext();
      await waitFor(() => runtime.calls.length === 2);
      assert.match(runtime.calls[1]?.prompt ?? '', /second prompt/);
      runtime.finishNext();
      await waitFor(() => runtime.completed === 2);
      await waitForInboxItemRemoved('scout', second.id);
      // settle window: asserting absence of an extra redrain runtime call.
      await sleep(50);
      assert.equal(runtime.calls.length, 2);
      assert.equal(queue.redrainEmptyChecks, 1);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker duplicate enqueue does not emit a wake signal', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-duplicate-wake-test-'));
  const coordinator = { agentId: 'scout', stateDir };
  let wakes = 0;
  let unsubscribe: (() => void) | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig(coordinator);
      unsubscribe = onWake('scout', () => {
        wakes += 1;
      });
      const event = makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-duplicate-wake',
        teamId: 'T-demo',
        text: 'dedupe me',
        ts: '1770000010.000001',
        userId: 'U1',
      });

      assert.equal((await new WakeQueueService('scout').enqueue(event)).queued, true);
      assert.equal(wakes, 1);
      assert.equal((await new WakeQueueService('scout').enqueue(event)).duplicate, true);
      assert.equal(wakes, 1);
    });
  } finally {
    unsubscribe?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker close unsubscribes from wake signals', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-wake-close-test-'));
  const runtime = new ControlledRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        pollIntervalMs: 60_000,
        queue: queueFor('scout'),
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      worker.start();
      await worker.close();
      worker = undefined;

      await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-user',
          eventId: 'evt-after-close',
          teamId: 'T-demo',
          text: 'after close',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );
      // settle window: asserting absence of runtime calls after the worker unsubscribes.
      await sleep(50);
      assert.equal(runtime.calls.length, 0);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker wake signals are isolated by agent id', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-wake-isolation-test-'));
  const alphaRuntime = new ControlledRuntime();
  const bravoRuntime = new ControlledRuntime();
  let alphaWorker: AgentRuntimeWorker | undefined;
  let bravoWorker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const alpha = { agentId: 'alpha', stateDir };
      const bravo = { agentId: 'bravo', stateDir };
      await ensureTestAgentConfig(alpha);
      await ensureTestAgentConfig(bravo);
      alphaWorker = new AgentRuntimeWorker({
        agentId: 'alpha',
        agentRuntime: alphaRuntime,
        pollIntervalMs: 60_000,
        queue: queueFor('alpha'),
        stateDir,
        workerId: 'alpha-worker',
      }, silentLogger);
      bravoWorker = new AgentRuntimeWorker({
        agentId: 'bravo',
        agentRuntime: bravoRuntime,
        pollIntervalMs: 60_000,
        queue: queueFor('bravo'),
        stateDir,
        workerId: 'bravo-worker',
      }, silentLogger);
      alphaWorker.start();
      bravoWorker.start();

      await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-alpha',
          eventId: 'evt-alpha-wake',
          teamId: 'T-demo',
          text: 'alpha only',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        alpha,
      );

      await waitFor(() => alphaRuntime.calls.length === 1);
      // settle window: asserting absence of wake handling by the other agent.
      await sleep(50);
      assert.equal(bravoRuntime.calls.length, 0);
      alphaRuntime.finishNext();
      await waitFor(() => alphaRuntime.completed === 1);
    });
  } finally {
    await alphaWorker?.close();
    await bravoWorker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('queued Slack listener persists work for a separate runtime worker', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-queued-worker-test-'));
  const runtime = new ControlledRuntime();
  const reactionCalls: string[] = [];
  const reactionClient = {
    add: async (reaction: { channel: string; name: string; timestamp: string }) => {
      reactionCalls.push(`add:${reaction.channel}:${reaction.timestamp}:${reaction.name}`);
    },
    remove: async (reaction: { channel: string; name: string; timestamp: string }) => {
      reactionCalls.push(`remove:${reaction.channel}:${reaction.timestamp}:${reaction.name}`);
    },
  };
  const coordinator = ({ agentId: 'scout', stateDir });
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      onItemSettled: (context) => removeProcessingReactions({ context, reactionClient }),
      stateDir,
      workerId: 'test-worker',
    }, silentLogger);
    const decision = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-queued',
        teamId: 'T-demo',
        text: 'queued',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    assert.equal(decision.queued, true);
    assert.equal((await queueFor('scout').list())[0]?.handling.status, 'queued');

    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    assert.match(runtime.calls[0]?.prompt ?? '', /queued/);
    assert.equal((await queueFor('scout').list())[0]?.handling.status, 'running');
    runtime.finishNext();
    assert.equal(await drain, 1);

    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
    assert.equal(
      allActivities(await loadState()).some((activity) =>
        activity.type === 'runtime.event'
        && activity.payload?.['eventType'] === 'runtime.restart_resumed'
      ),
      false,
    );
    assert.deepEqual(reactionCalls, ['remove:D-user:1770000010.000001:eyes']);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker drain close lets active item finish before clearing audit pointer', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-drain-close-test-'));
  const runtime = new ControlledRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const decision = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-user',
          eventId: 'evt-drain-close',
          teamId: 'T-demo',
          text: 'finish before recycle',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );
      const drain = worker.drainOnce();
      await waitFor(() => runtime.calls.length === 1);
      assert.equal((await findActiveRuntimeItem('scout'))?.itemId, decision.ctx.item.id);

      const close = worker.close({ drainActive: true });
      // settle window: asserting absence of active-item cleanup while drainActive close is waiting.
      await sleep(30);
      assert.equal((await findActiveRuntimeItem('scout'))?.itemId, decision.ctx.item.id);
      assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'running');

      runtime.finishNext();
      await close;
      await drain;
      assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
      assert.equal(await findActiveRuntimeItem('scout'), undefined);
      worker = undefined;
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker forwards force timeout when closing after drain', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-drain-close-force-test-'));
  const runtime = new CloseOptionsRuntime();
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);

      await worker.close({ drainActive: true, forceAfterMs: 123 });
      assert.deepEqual(runtime.closeOptions, [{ forceAfterMs: 123 }]);
      worker = undefined;
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker leaves queued work untouched while a restart drain marker is active', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-restart-drain-marker-test-'));
  const runtime = new ControlledRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await requestRestartDrain(60_000);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const decision = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-user',
          eventId: 'evt-restart-drain-marker',
          teamId: 'T-demo',
          text: 'stay queued',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );

      assert.equal(await worker.drainOnce(), 0);
      assert.equal(runtime.calls.length, 0);
      assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'queued');
    });
  } finally {
    await withAnimaHome(stateDir, async () => clearRestartDrain().catch(() => undefined));
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker drains a running item for restart without marking it failed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-restart-drain-test-'));
  const runtime = new DrainableRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        idleTimeoutMs: 1_000,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const decision = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-user',
          eventId: 'evt-restart-drain',
          teamId: 'T-demo',
          text: 'drain me',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );
      const drain = worker.drainOnce();
      await waitFor(() => runtime.calls.length === 1);

      await requestRestartDrain(60_000);
      await queueFor('scout').requestDrain({ itemId: decision.ctx.item.id, timeoutMs: 1_000 });
      await waitForInboxItemStatus('scout', decision.ctx.item.id, 'queued', 3_000);
      assert.equal(await drain, 1);

      const item = await queueFor('scout').find(decision.ctx.item.id);
      assert.equal(item?.handling.status, 'queued');
      assert.equal(item?.handling.drainRequestedAt, undefined);
      assert.equal(item?.handling.drainTimeoutMs, undefined);
      assert.equal(item?.handling.resumeReason, 'runtime_restart');
      assert.equal(runtime.drainCalls.length, 1);
      assert.equal(runtime.drainCalls[0]?.activeItemId, decision.ctx.item.id);
      let activities = allActivities(await loadState());
      assert.equal(activities.some((activity) => activity.type === 'runtime.failed'), false);
      const aborted = activities.find((activity) => activity.type === 'runtime.aborted');
      assert.equal(aborted?.payload?.['reason'], 'restart_drain');

      await worker?.close();
      worker = undefined;
      await clearRestartDrain();

      const resumedRuntime = new ControlledRuntime();
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: resumedRuntime,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'resumed-worker',
      }, silentLogger);
      const resumeDrain = worker.drainOnce();
      await waitFor(() => resumedRuntime.calls.length === 1);
      assert.equal(resumedRuntime.calls[0]?.itemId, decision.ctx.item.id);
      const resumedPrompt = resumedRuntime.calls[0]?.prompt ?? '';
      assert.match(resumedPrompt, new RegExp(`^Runtime restart continuation:\\n\\n\\[item=${decision.ctx.item.id} time=[^\\]]+\\]\\n\\nAnima note: the runtime restarted while this task was in progress\\.`));
      assert.match(resumedPrompt, /Check `anima outbox` for what you already sent and `anima inbox` for what arrived before re-sending anything\./);
      assert.doesNotMatch(resumedPrompt, /Anima system/);
      assert.doesNotMatch(resumedRuntime.calls[0]?.prompt ?? '', /drain me/);
      resumedRuntime.finishNext();
      assert.equal(await resumeDrain, 1);

      activities = allActivities(await loadState());
      assert.equal(activities.some((activity) => activity.type === 'runtime.failed'), false);
      const resumeEvents = activities.filter((activity) =>
        activity.type === 'runtime.event'
        && activity.payload?.['eventType'] === 'runtime.restart_resumed'
      );
      assert.equal(resumeEvents.length, 1);
      assert.equal(resumeEvents[0]?.payload?.['message'], 'Resumed after restart');
      assert.equal(resumeEvents[0]?.payload?.['itemId'], decision.ctx.item.id);
    });
  } finally {
    await withAnimaHome(stateDir, async () => clearRestartDrain().catch(() => undefined));
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker stops a item when queue requestStop sets stopRequestedAt', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-stop-test-'));
  const runtime = new AbortableRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      idleTimeoutMs: 60_000,
      pollIntervalMs: 10_000,
      stateDir,
      workerId: 'test-worker',
    }, silentLogger);
    const decision = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-stop',
        teamId: 'T-demo',
        text: 'stop me',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);

    const stopping = await queueFor('scout').requestStop(decision.ctx.item.id);
    assert.ok(stopping.handling.stopRequestedAt, 'expected stopRequestedAt to be set');
    await waitForInboxItemRemoved('scout', decision.ctx.item.id, 5_000);
    await drain;

    const activities = allActivities(await loadState());
    const aborted = activities.find((activity) => activity.type === 'runtime.aborted');
    assert.equal(aborted?.payload?.['reason'], 'user_stop');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});
