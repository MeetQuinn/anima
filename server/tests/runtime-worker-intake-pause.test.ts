import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';
import { waitFor } from './helpers/harness.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { appendQueuedFollowupsUntilFinished } from '../runtime/followup-appender.js';
import { AgentRuntimeBridge } from '../runtime/runtime-bridge.js';
import type { AgentRuntime, AgentRuntimeFollowupInput, AgentRuntimeResult } from '../providers/contract.js';
import type { InboxItem } from '../../shared/inbox.js';
import type { RuntimeItemContext } from '../runtime/types.js';
import {
  ControlledRuntime,
  DeferredPrimaryClaimQueue,
  enqueueInbox,
  queueFor,
  silentLogger,
  waitForInboxItemStatus,
} from './helpers/runtime-worker.js';

test('runtime worker requeues a primary claim when intake pauses mid takeNextRunnable', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-intake-pause-primary-'));
  const runtime = new ControlledRuntime();
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const first = await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-primary-pause',
        teamId: 'T-demo',
        text: 'primary body',
        ts: '1770000100.000001',
        userId: 'U1',
      }), { agentId: 'scout', stateDir });

      const queue = new DeferredPrimaryClaimQueue('scout');
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        pollIntervalMs: 10_000,
        queue,
        stateDir,
        workerId: 'test-worker-primary-pause',
      }, silentLogger);

      const drain = worker.drainOnce();
      await waitFor(() => queue.claimedIds.length === 1, {
        description: 'primary claim held after store take',
        timeoutMs: 2_000,
      });
      assert.deepEqual(queue.claimedIds, [first.ctx.item.id]);
      assert.equal(runtime.calls.length, 0);

      // Config reload pause flips while takeNextRunnable is still awaiting.
      worker.setIntakePaused(true);
      queue.releaseHeldClaim();

      assert.equal(await drain, 0);
      assert.equal(runtime.calls.length, 0, 'must not start primary on old runtime after pause');
      await waitForInboxItemStatus('scout', first.ctx.item.id, 'queued', 2_000);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('follow-up appender requeues a claimed batch when intake pauses mid takeFollowupBatch', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-intake-pause-followup-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const parent = await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-followup-pause-parent',
        teamId: 'T-demo',
        text: 'parent body',
        ts: '1770000200.000001',
        userId: 'U1',
      }), { agentId: 'scout', stateDir });
      const child = await enqueueInbox(makeSlackEvent({
        channelId: 'C-alpha',
        eventId: 'evt-followup-pause-child',
        teamId: 'T-demo',
        text: 'follow-up body',
        threadTs: '1770000200.000001',
        ts: '1770000201.000001',
        userId: 'U2',
      }), { agentId: 'scout', stateDir });

      // Mark parent running so takeFollowupBatch will claim the child.
      const queue = queueFor('scout');
      const claimedParent = await queue.takeNextRunnable({
        currentWorkerId: 'test-worker-followup-pause',
        isWorkerAlive: () => true,
        staleRunningMs: 30 * 60 * 1000,
        workerId: 'test-worker-followup-pause',
      });
      assert.equal(claimedParent?.id, parent.ctx.item.id);

      let releaseBatch!: () => void;
      const batchGate = new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      let held = false;
      const claimedBatches: string[][] = [];
      const originalTake = queue.takeFollowupBatch.bind(queue);
      queue.takeFollowupBatch = async (input) => {
        const items = await originalTake(input);
        if (items.length > 0 && !held) {
          held = true;
          claimedBatches.push(items.map((item) => item.id));
          await batchGate;
        }
        return items;
      };

      let intakePaused = false;
      const appends: AgentRuntimeFollowupInput[] = [];
      const runtime: AgentRuntime = {
        kind: 'followup-pause',
        async run(): Promise<AgentRuntimeResult> {
          return { text: 'parent' };
        },
        async appendToActiveRun(input) {
          appends.push(input);
          return { accepted: true, text: 'appended' };
        },
      };

      const itemDone = new AbortController();
      const loop = appendQueuedFollowupsUntilFinished({
        activeContext: parent.ctx,
        agentRuntime: runtime,
        isIntakePaused: () => intakePaused,
        itemDone: itemDone.signal,
        logger: silentLogger,
        onFollowupAccepted: () => {},
        onFollowupAppended: async () => {},
        onFollowupSettled: async () => {},
        queue,
        runtimeBridge: new AgentRuntimeBridge(runtime),
        runtimeConfig: { agentId: 'scout', stateDir },
        workerId: 'test-worker-followup-pause',
      });

      await waitFor(() => claimedBatches.length === 1, {
        description: 'follow-up batch held after claim',
        timeoutMs: 2_000,
      });
      assert.deepEqual(claimedBatches[0], [child.ctx.item.id]);
      assert.equal(appends.length, 0);

      intakePaused = true;
      releaseBatch();

      await waitForInboxItemStatus('scout', child.ctx.item.id, 'queued', 2_000);
      assert.equal(appends.length, 0, 'must not append follow-up on old runtime after pause');

      itemDone.abort();
      await loop;
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('follow-up appender requeues after context build when pause flips before append', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-intake-pause-preappend-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const parent = await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-preappend-parent',
        teamId: 'T-demo',
        text: 'parent body',
        ts: '1770000300.000001',
        userId: 'U1',
      }), { agentId: 'scout', stateDir });
      const child = await enqueueInbox(makeSlackEvent({
        channelId: 'C-alpha',
        eventId: 'evt-preappend-child',
        teamId: 'T-demo',
        text: 'follow-up body',
        ts: '1770000301.000001',
        userId: 'U2',
      }), { agentId: 'scout', stateDir });

      const queue = queueFor('scout');
      const claimedParent = await queue.takeNextRunnable({
        currentWorkerId: 'test-worker-preappend',
        isWorkerAlive: () => true,
        staleRunningMs: 30 * 60 * 1000,
        workerId: 'test-worker-preappend',
      });
      assert.equal(claimedParent?.id, parent.ctx.item.id);

      let releaseBridge!: () => void;
      const bridgeGate = new Promise<void>((resolve) => {
        releaseBridge = resolve;
      });
      let intakePaused = false;
      const appends: AgentRuntimeFollowupInput[] = [];
      const runtime: AgentRuntime = {
        kind: 'preappend-pause',
        async run(): Promise<AgentRuntimeResult> {
          return { text: 'parent' };
        },
        async appendToActiveRun(input) {
          appends.push(input);
          return { accepted: true, text: 'appended' };
        },
      };

      // Bridge that holds after building followup input so pause can flip pre-append.
      const bridge = new AgentRuntimeBridge(runtime);
      const originalFollowupInput = bridge.followupInput.bind(bridge);
      bridge.followupInput = async (input) => {
        const built = await originalFollowupInput(input);
        await bridgeGate;
        return built;
      };

      const itemDone = new AbortController();
      const loop = appendQueuedFollowupsUntilFinished({
        activeContext: parent.ctx as RuntimeItemContext,
        agentRuntime: runtime,
        isIntakePaused: () => intakePaused,
        itemDone: itemDone.signal,
        logger: silentLogger,
        onFollowupAccepted: () => {},
        onFollowupAppended: async () => {},
        onFollowupSettled: async () => {},
        queue,
        runtimeBridge: bridge,
        runtimeConfig: { agentId: 'scout', stateDir },
        workerId: 'test-worker-preappend',
      });

      // Wait until the bridge hold is active (follow-up claimed for build).
      await waitFor(async () => {
        const items = await queue.list();
        const childItem = items.find((item: InboxItem) => item.id === child.ctx.item.id);
        return childItem?.handling.status === 'running';
      }, { description: 'follow-up claimed for bridge build', timeoutMs: 2_000 });

      // Give bridge a tick to reach the hold after context/input build.
      await new Promise((r) => setTimeout(r, 50));
      intakePaused = true;
      releaseBridge();

      await waitForInboxItemStatus('scout', child.ctx.item.id, 'queued', 2_000);
      assert.equal(appends.length, 0, 'must not append after pre-append pause');

      itemDone.abort();
      await loop;
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker requeues primary when pause flips during deferred restart-drain probe', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-intake-pause-drain-primary-'));
  const runtime = new ControlledRuntime();
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const first = await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-drain-probe-primary',
        teamId: 'T-demo',
        text: 'primary body',
        ts: '1770000400.000001',
        userId: 'U1',
      }), { agentId: 'scout', stateDir });

      let releaseDrain!: () => void;
      const drainGate = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      let drainProbeStarted = 0;
      const queue = new DeferredPrimaryClaimQueue('scout');
      // Claim without hold so we land on the post-claim intake gate.
      queue.releaseHeldClaim();

      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        isRestartDrainActive: async () => {
          drainProbeStarted += 1;
          // Only hold the post-claim probe (after takeNextRunnable).
          if (drainProbeStarted >= 3) {
            await drainGate;
          }
          return false;
        },
        pollIntervalMs: 10_000,
        queue,
        stateDir,
        workerId: 'test-worker-drain-primary',
      }, silentLogger);

      const drain = worker.drainOnce();
      await waitFor(() => drainProbeStarted >= 3, {
        description: 'post-claim restart-drain probe held',
        timeoutMs: 2_000,
      });
      assert.equal(runtime.calls.length, 0);

      // Pause flips while the drain probe is still awaiting — old code sampled
      // pause before that await and would still proceed.
      worker.setIntakePaused(true);
      releaseDrain();

      assert.equal(await drain, 0);
      assert.equal(runtime.calls.length, 0, 'must not run after pause during drain probe');
      await waitForInboxItemStatus('scout', first.ctx.item.id, 'queued', 2_000);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('follow-up appender requeues when pause flips during deferred restart-drain probe before append', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-intake-pause-drain-followup-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const parent = await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-drain-probe-parent',
        teamId: 'T-demo',
        text: 'parent body',
        ts: '1770000500.000001',
        userId: 'U1',
      }), { agentId: 'scout', stateDir });
      const child = await enqueueInbox(makeSlackEvent({
        channelId: 'C-alpha',
        eventId: 'evt-drain-probe-child',
        teamId: 'T-demo',
        text: 'follow-up body',
        ts: '1770000501.000001',
        userId: 'U2',
      }), { agentId: 'scout', stateDir });

      const queue = queueFor('scout');
      const claimedParent = await queue.takeNextRunnable({
        currentWorkerId: 'test-worker-drain-followup',
        isWorkerAlive: () => true,
        staleRunningMs: 30 * 60 * 1000,
        workerId: 'test-worker-drain-followup',
      });
      assert.equal(claimedParent?.id, parent.ctx.item.id);

      let releaseDrain!: () => void;
      const drainGate = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      let drainProbeStarted = 0;
      let intakePaused = false;
      const appends: AgentRuntimeFollowupInput[] = [];
      const runtime: AgentRuntime = {
        kind: 'drain-probe-followup',
        async run(): Promise<AgentRuntimeResult> {
          return { text: 'parent' };
        },
        async appendToActiveRun(input) {
          appends.push(input);
          return { accepted: true, text: 'appended' };
        },
      };

      const itemDone = new AbortController();
      const loop = appendQueuedFollowupsUntilFinished({
        activeContext: parent.ctx,
        agentRuntime: runtime,
        isIntakePaused: () => intakePaused,
        isRestartDrainActive: async () => {
          drainProbeStarted += 1;
          // Hold only the pre-append probe (after batch claim + context/bridge).
          if (drainProbeStarted >= 3) {
            await drainGate;
          }
          return false;
        },
        itemDone: itemDone.signal,
        logger: silentLogger,
        onFollowupAccepted: () => {},
        onFollowupAppended: async () => {},
        onFollowupSettled: async () => {},
        queue,
        runtimeBridge: new AgentRuntimeBridge(runtime),
        runtimeConfig: { agentId: 'scout', stateDir },
        workerId: 'test-worker-drain-followup',
      });

      await waitFor(() => drainProbeStarted >= 3, {
        description: 'pre-append restart-drain probe held',
        timeoutMs: 2_000,
      });
      assert.equal(appends.length, 0);

      intakePaused = true;
      releaseDrain();

      await waitForInboxItemStatus('scout', child.ctx.item.id, 'queued', 2_000);
      assert.equal(appends.length, 0, 'must not append after pause during drain probe');

      itemDone.abort();
      await loop;
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

/**
 * Red-control for the removed boolean-helper hop.
 *
 * Schedule the pause flip from the final `isIntakePaused` read when it returns
 * false. Record pause when the guarded action starts:
 * - old `await isBlockedHelper()`: caller resume is a second microtask → flip
 *   already ran → start sees pause true
 * - inlined drain + sync pause + start: action starts in the same continuation
 *   while pause is still false
 */
test('intake gate red-control: inlined start sees pause false; old helper hop sees true', async () => {
  let paused = false;
  const readPauseSchedulingFlip = (): boolean => {
    const value = paused;
    if (!value) {
      queueMicrotask(() => {
        paused = true;
      });
    }
    return value;
  };

  // --- Old pattern (removed): await helper that already sampled pause ---
  paused = false;
  let pauseAtOldActionStart: boolean | undefined;
  {
    async function oldIsIntakeBlocked(drain: () => Promise<boolean>): Promise<boolean> {
      const drainActive = await drain();
      if (readPauseSchedulingFlip()) return true;
      return drainActive;
    }
    const blocked = await oldIsIntakeBlocked(async () => false);
    // Caller resume after await helper — flip microtask has already run.
    pauseAtOldActionStart = paused;
    assert.equal(blocked, false);
  }
  assert.equal(
    pauseAtOldActionStart,
    true,
    'old helper hop: pause flip runs before caller starts the action',
  );

  // --- New pattern (production): drain await, sync pause, start immediately ---
  paused = false;
  let pauseAtNewActionStart: boolean | undefined;
  {
    const drainActive = await (async () => false)();
    if (readPauseSchedulingFlip() || drainActive) {
      assert.fail('inlined path must not block on first false read');
    }
    // processClaimedItem / appendToActiveRun would start here, same continuation.
    pauseAtNewActionStart = paused;
  }
  assert.equal(
    pauseAtNewActionStart,
    false,
    'inlined path: action starts synchronously while pause still false',
  );
  // Flip runs after this turn.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(paused, true);
});

