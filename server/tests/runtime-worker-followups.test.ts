import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';
import { makeReminderInboxItem } from './helpers/inbox.js';
import { waitFor } from './helpers/harness.js';
import { allActivities, loadState } from './helpers/state.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { addProcessingReaction, removeProcessingReactions } from '../runtime/processing-reactions.js';
import {
  ControlledRuntime,
  FailingFollowupRuntime,
  FollowupRuntime,
  NotReadyFollowupRuntime,
  RejectingFollowupRuntime,
  ThrowingFollowupRuntime,
  enqueueInbox,
  makeMemoryCoherenceInboxItem,
  queueFor,
  seedReminder,
  silentLogger,
  waitForInboxItemAppendedTo,
  waitForInboxItemStatus,
} from './helpers/runtime-worker.js';

test('runtime worker appends one ordered snapshot across Slack surfaces', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-followup-batch-test-'));
  const runtime = new FollowupRuntime();
  const appendedIds: string[] = [];
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const coordinator = { agentId: 'scout', stateDir };
      const first = await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-batch-first',
        teamId: 'T-demo',
        text: 'active body sentinel',
        ts: '1770000010.000001',
        userId: 'U1',
      }), coordinator);
      const second = await enqueueInbox(makeSlackEvent({
        channelId: 'C-alpha',
        eventId: 'evt-batch-second',
        teamId: 'T-demo',
        text: 'alpha body sentinel',
        threadTs: '1770000001.000001',
        ts: '1770000011.000001',
        userId: 'U2',
      }), coordinator);
      const third = await enqueueInbox(makeSlackEvent({
        channelId: 'C-beta',
        eventId: 'evt-batch-third',
        teamId: 'T-demo',
        text: 'beta body sentinel',
        ts: '1770000012.000001',
        userId: 'U3',
      }), coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        onItemFollowupAppended: async (_active, context) => {
          appendedIds.push(context.item.id);
        },
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);

      const drain = worker.drainOnce();
      await waitFor(() => runtime.followups.length === 1);
      const followup = runtime.followups[0];
      assert.deepEqual(followup?.itemIds, [second.ctx.item.id, third.ctx.item.id]);
      assert.ok(followup);
      assert.equal(
        followup.prompt,
        [
          buildCodeAgentDeliveryPrompt(second.ctx.item),
          buildCodeAgentDeliveryPrompt(third.ctx.item),
        ].join('\n\n'),
      );
      await waitFor(() => appendedIds.length === 2);
      assert.deepEqual(appendedIds, [second.ctx.item.id, third.ctx.item.id]);
      await waitForInboxItemAppendedTo('scout', second.ctx.item.id, first.ctx.item.id);
      await waitForInboxItemAppendedTo('scout', third.ctx.item.id, first.ctx.item.id);

      runtime.finishNext();
      assert.equal(await drain, 1);
      assert.equal(await queueFor('scout').find(second.ctx.item.id), undefined);
      assert.equal(await queueFor('scout').find(third.ctx.item.id), undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker follow-up snapshots enforce the item-count limit', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-followup-batch-limits-test-'));
  const runtime = new FollowupRuntime();
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const coordinator = { agentId: 'scout', stateDir };
      await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-limits-active',
        teamId: 'T-demo',
        text: 'active',
        ts: '1770000010.000001',
        timestamp: '2026-07-27T00:00:00.000Z',
        userId: 'U1',
      }), coordinator);
      for (let index = 0; index < 17; index += 1) {
        await enqueueInbox(makeSlackEvent({
          channelId: `C-${index}`,
          eventId: `evt-count-${index}`,
          teamId: 'T-demo',
          text: `count-${index}`,
          ts: `17700001${String(index + 11).padStart(2, '0')}.000001`,
          userId: 'U2',
        }), coordinator);
      }
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const drain = worker.drainOnce();
      await waitFor(() => runtime.followups.length === 2);
      assert.equal(runtime.followups[0]?.itemIds.length, 16);
      assert.equal(runtime.followups[1]?.itemIds.length, 1);
      runtime.finishNext();
      await drain;
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker follow-up snapshots enforce the prompt-size limit', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-followup-batch-size-limit-test-'));
  const runtime = new FollowupRuntime();
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const coordinator = { agentId: 'scout', stateDir };
      await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-size-active',
        teamId: 'T-demo',
        text: 'active',
        ts: '1770000010.000001',
        timestamp: '2026-07-27T00:00:00.000Z',
        userId: 'U1',
      }), coordinator);
      await enqueueInbox(makeSlackEvent({
        channelId: 'C-large',
        eventId: 'evt-size-large',
        teamId: 'T-demo',
        text: `large-${'x'.repeat(70 * 1024)}`,
        ts: '1770000011.000001',
        userId: 'U2',
      }), coordinator);
      await enqueueInbox(makeSlackEvent({
        channelId: 'C-after-large',
        eventId: 'evt-size-after',
        teamId: 'T-demo',
        text: 'after-large',
        ts: '1770000012.000001',
        userId: 'U3',
      }), coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const drain = worker.drainOnce();
      await waitFor(() => runtime.followups.length === 2);
      assert.equal(runtime.followups[0]?.itemIds.length, 1);
      assert.match(runtime.followups[0]?.prompt ?? '', /large-/);
      assert.equal(runtime.followups[1]?.itemIds.length, 1);
      assert.match(runtime.followups[1]?.prompt ?? '', /after-large/);
      runtime.finishNext();
      await drain;
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker appends queued follow-up messages into an active runtime', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-followup-test-'));
  const runtime = new FollowupRuntime();
  const reactionCalls: string[] = [];
  const settledTurnIds: string[] = [];
  const reactionClient = {
    add: async (reaction: { channel: string; name: string; timestamp: string }) => {
      reactionCalls.push(`add:${reaction.channel}:${reaction.timestamp}:${reaction.name}`);
    },
    remove: async (reaction: { channel: string; name: string; timestamp: string }) => {
      reactionCalls.push(`remove:${reaction.channel}:${reaction.timestamp}:${reaction.name}`);
    },
  };
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      onItemStarted: async (context) => {
        await addProcessingReaction({ context, reactionClient });
      },
      onItemFollowupAppended: async (_activeContext, context) => {
        await addProcessingReaction({ context, reactionClient });
      },
      onItemSettled: async (context) => {
        await removeProcessingReactions({ context, reactionClient });
        settledTurnIds.push(context.item.id);
      },
      pollIntervalMs: 10_000,
      stateDir,
      workerId: 'test-worker',
    }, silentLogger);
    const first = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-first',
        teamId: 'T-demo',
        text: 'first',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);

    const second = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-second',
        teamId: 'T-demo',
        text: 'second',
        ts: '1770000011.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    await waitFor(() => runtime.followups.length === 1);
    assert.equal(runtime.followups[0]?.activeItemId, first.ctx.item.id);
    assert.deepEqual(runtime.followups[0]?.itemIds, [second.ctx.item.id]);
    assert.match(runtime.followups[0]?.prompt ?? '', /second/);
    await waitForInboxItemAppendedTo('scout', second.ctx.item.id, first.ctx.item.id);
    await waitFor(() => reactionCalls.includes('add:D-user:1770000011.000001:eyes'));
    assert.deepEqual(reactionCalls, [
      'add:D-user:1770000010.000001:eyes',
      'add:D-user:1770000011.000001:eyes',
    ]);
    assert.deepEqual(settledTurnIds, []);

    const third = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-third',
        teamId: 'T-demo',
        text: 'third',
        ts: '1770000012.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    await waitFor(() => runtime.followups.length === 2);
    assert.equal(runtime.followups[1]?.activeItemId, first.ctx.item.id);
    assert.deepEqual(runtime.followups[1]?.itemIds, [third.ctx.item.id]);
    assert.match(runtime.followups[1]?.prompt ?? '', /third/);
    await waitForInboxItemAppendedTo('scout', third.ctx.item.id, first.ctx.item.id);
    await waitFor(() => reactionCalls.includes('add:D-user:1770000012.000001:eyes'));
    assert.deepEqual(reactionCalls, [
      'add:D-user:1770000010.000001:eyes',
      'add:D-user:1770000011.000001:eyes',
      'add:D-user:1770000012.000001:eyes',
    ]);
    assert.deepEqual(settledTurnIds, []);

    runtime.finishNext();
    assert.equal(await drain, 1);
    assert.equal(await queueFor('scout').find(first.ctx.item.id), undefined);
    assert.equal(await queueFor('scout').find(second.ctx.item.id), undefined);
    assert.equal(await queueFor('scout').find(third.ctx.item.id), undefined);
    await waitFor(() => settledTurnIds.length === 3);
    assert.deepEqual(reactionCalls, [
      'add:D-user:1770000010.000001:eyes',
      'add:D-user:1770000011.000001:eyes',
      'add:D-user:1770000012.000001:eyes',
      'remove:D-user:1770000010.000001:eyes',
      'remove:D-user:1770000011.000001:eyes',
      'remove:D-user:1770000012.000001:eyes',
    ]);
    assert.deepEqual(settledTurnIds, [first.ctx.item.id, second.ctx.item.id, third.ctx.item.id]);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker appends newly queued inbound follow-ups into an active runtime', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-immediate-followup-test-'));
  const runtime = new FollowupRuntime();
  const followupSignals: string[] = [];
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      onItemFollowupAppended: async (activeContext, context) => {
        followupSignals.push(`${activeContext.item.id}:${context.item.id}`);
      },
      pollIntervalMs: 10_000,
      stateDir,
      workerId: 'test-worker',
    }, silentLogger);
    const first = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-immediate-first',
        teamId: 'T-demo',
        text: 'first',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    assert.equal(first.queued, true);
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);

    const second = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-immediate-second',
        teamId: 'T-demo',
        text: 'second',
        ts: '1770000011.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    assert.equal(second.queued, true);
    await waitFor(() => runtime.followups.length === 1);
    assert.equal(runtime.followups[0]?.activeItemId, first.ctx.item.id);
    assert.deepEqual(runtime.followups[0]?.itemIds, [second.ctx.item.id]);
    await waitFor(() => followupSignals.length === 1);
    assert.deepEqual(followupSignals, [`${first.ctx.item.id}:${second.ctx.item.id}`]);
    await waitForInboxItemAppendedTo('scout', second.ctx.item.id, first.ctx.item.id);

    runtime.finishNext();
    assert.equal(await drain, 1);
    assert.equal(await queueFor('scout').find(first.ctx.item.id), undefined);
    assert.equal(await queueFor('scout').find(second.ctx.item.id), undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker queues inbound work while active when follow-up append is rejected', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-no-followup-test-'));
  const runtime = new ControlledRuntime();
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
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
    const first = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-no-followup-first',
        teamId: 'T-demo',
        text: 'first',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);

    const second = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-no-followup-second',
        teamId: 'T-demo',
        text: 'second',
        ts: '1770000011.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    assert.equal(second.queued, true);
    assert.equal((await queueFor('scout').find(second.ctx.item.id))?.handling.status, 'queued');

    runtime.finishNext();
    await waitFor(() => runtime.calls.length === 2);
    runtime.finishNext();
    assert.equal(await drain, 2);
    assert.equal(await queueFor('scout').find(first.ctx.item.id), undefined);
    assert.equal(await queueFor('scout').find(second.ctx.item.id), undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker requeues appended follow-ups when the parent turn fails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-followup-parent-failure-test-'));
  const runtime = new FailingFollowupRuntime();
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
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
    const first = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-followup-failure-first',
        teamId: 'T-demo',
        text: 'first',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);

    const second = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-followup-failure-second',
        teamId: 'T-demo',
        text: 'second',
        ts: '1770000011.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    await waitFor(() => runtime.followups.length === 1);
    await waitForInboxItemAppendedTo('scout', second.ctx.item.id, first.ctx.item.id);

    runtime.failNext();
    assert.equal(await drain, 2);
    assert.equal(await queueFor('scout').find(first.ctx.item.id), undefined);
    assert.equal(runtime.calls[1]?.itemId, second.ctx.item.id);
    assert.equal(await queueFor('scout').find(second.ctx.item.id), undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker records pending when follow-up append is rejected', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-followup-reject-test-'));
  const runtime = new RejectingFollowupRuntime();
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
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
    await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-reject-first',
        teamId: 'T-demo',
        text: 'first',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);

    const second = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-reject-second',
        teamId: 'T-demo',
        text: 'second',
        ts: '1770000011.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const third = await enqueueInbox(
      makeSlackEvent({
        channelId: 'C-other',
        eventId: 'evt-reject-third',
        teamId: 'T-demo',
        text: 'third',
        ts: '1770000012.000001',
        userId: 'U2',
      }),
      coordinator,
    );

    assert.equal(second.queued, true);
    assert.equal(third.queued, true);
    await waitFor(() => runtime.followups.length === 1);
    assert.deepEqual(runtime.followups[0]?.itemIds, [second.ctx.item.id, third.ctx.item.id]);
    await waitForInboxItemStatus('scout', second.ctx.item.id, 'queued');
    await waitForInboxItemStatus('scout', third.ctx.item.id, 'queued');
    await waitFor(async () => allActivities(await loadState()).some((activity) => activity.type === 'runtime.pending'));
    const pending = allActivities(await loadState()).find((activity) => activity.type === 'runtime.pending');
    assert.equal(pending?.payload?.['reason'], 'followup_rejected');

    runtime.finishNext();
    await waitFor(() => runtime.calls.length === 2);
    runtime.finishNext();
    await waitFor(() => runtime.calls.length === 3);
    runtime.finishNext();
    assert.equal(await drain, 3);
    assert.equal(await queueFor('scout').find(second.ctx.item.id), undefined);
    assert.equal(await queueFor('scout').find(third.ctx.item.id), undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker retries follow-ups quietly until the provider turn is ready', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-followup-not-ready-test-'));
  const runtime = new NotReadyFollowupRuntime();
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
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
    await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-not-ready-first',
        teamId: 'T-demo',
        text: 'first',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);

    const second = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-not-ready-second',
        teamId: 'T-demo',
        text: 'second',
        ts: '1770000011.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const third = await enqueueInbox(
      makeSlackEvent({
        channelId: 'C-other',
        eventId: 'evt-not-ready-third',
        teamId: 'T-demo',
        text: 'third',
        ts: '1770000012.000001',
        userId: 'U2',
      }),
      coordinator,
    );

    await waitFor(() => runtime.attempts >= 2);
    await waitForInboxItemStatus('scout', second.ctx.item.id, 'queued');
    await waitForInboxItemStatus('scout', third.ctx.item.id, 'queued');
    assert.equal(
      allActivities(await loadState()).some((activity) =>
        activity.type === 'runtime.followup_failed' || activity.type === 'runtime.pending'),
      false,
    );

    runtime.ready = true;
    await waitFor(() => runtime.followups.length === 1);
    assert.deepEqual(runtime.followups[0]?.itemIds, [second.ctx.item.id, third.ctx.item.id]);
    await waitForInboxItemAppendedTo('scout', second.ctx.item.id, runtime.calls[0]?.itemId ?? '');
    await waitForInboxItemAppendedTo('scout', third.ctx.item.id, runtime.calls[0]?.itemId ?? '');
    runtime.finishNext();
    assert.equal(await drain, 1);
    assert.equal(await queueFor('scout').find(second.ctx.item.id), undefined);
    assert.equal(await queueFor('scout').find(third.ctx.item.id), undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker requeues an entire follow-up batch when append throws', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-followup-batch-throw-test-'));
  const runtime = new ThrowingFollowupRuntime();
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const coordinator = { agentId: 'scout', stateDir };
      await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-throw-active',
        teamId: 'T-demo',
        text: 'active',
        ts: '1770000010.000001',
        userId: 'U1',
      }), coordinator);
      const second = await enqueueInbox(makeSlackEvent({
        channelId: 'C-one',
        eventId: 'evt-throw-second',
        teamId: 'T-demo',
        text: 'second',
        ts: '1770000011.000001',
        userId: 'U2',
      }), coordinator);
      const third = await enqueueInbox(makeSlackEvent({
        channelId: 'C-two',
        eventId: 'evt-throw-third',
        teamId: 'T-demo',
        text: 'third',
        ts: '1770000012.000001',
        userId: 'U3',
      }), coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);

      const drain = worker.drainOnce();
      await waitFor(() => runtime.followups.length === 1);
      assert.deepEqual(runtime.followups[0]?.itemIds, [second.ctx.item.id, third.ctx.item.id]);
      await waitForInboxItemStatus('scout', second.ctx.item.id, 'queued');
      await waitForInboxItemStatus('scout', third.ctx.item.id, 'queued');
      await waitFor(async () => allActivities(await loadState()).some(
        (activity) => activity.type === 'runtime.followup_failed',
      ));
      await worker.close();
      worker = undefined;
      assert.equal(await drain, 1);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker requeues an entire follow-up batch when prompt construction fails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-followup-batch-context-failure-test-'));
  const runtime = new FollowupRuntime();
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const coordinator = { agentId: 'scout', stateDir };
      await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-context-active',
        teamId: 'T-demo',
        text: 'active',
        ts: '1770000010.000001',
        timestamp: '2026-07-27T00:00:00.000Z',
        userId: 'U1',
      }), coordinator);
      const missingReminder = await enqueueInbox(makeReminderInboxItem({
        eventId: 'evt-context-missing-reminder',
        reminderId: 'missing-reminder',
        timestamp: '2026-07-28T00:00:00.000Z',
      }), coordinator);
      const slack = await enqueueInbox(makeSlackEvent({
        channelId: 'C-after-reminder',
        eventId: 'evt-context-slack',
        teamId: 'T-demo',
        text: 'must remain queued too',
        ts: '1770000012.000001',
        userId: 'U2',
      }), coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);

      const drain = worker.drainOnce();
      await waitFor(async () => allActivities(await loadState()).some(
        (activity) => activity.type === 'runtime.followup_failed',
      ));
      assert.deepEqual(runtime.followups, []);
      await waitForInboxItemStatus('scout', missingReminder.ctx.item.id, 'queued');
      await waitForInboxItemStatus('scout', slack.ctx.item.id, 'queued');
      await worker.close();
      worker = undefined;
      assert.equal(await drain, 1);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker excludes memory coherence from a message follow-up batch', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-followup-batch-memory-exclusion-test-'));
  const runtime = new FollowupRuntime();
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const coordinator = { agentId: 'scout', stateDir };
      await enqueueInbox(makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-memory-active',
        teamId: 'T-demo',
        text: 'active',
        ts: '1770000010.000001',
        timestamp: '2026-07-27T00:00:00.000Z',
        userId: 'U1',
      }), coordinator);
      const memory = makeMemoryCoherenceInboxItem({
        scheduledSlotAt: '2026-07-28T00:00:00.000Z',
        timestamp: '2026-07-28T00:00:00.000Z',
      });
      await queueFor('scout').enqueue(memory);
      const slack = await enqueueInbox(makeSlackEvent({
        channelId: 'C-after-memory',
        eventId: 'evt-memory-slack',
        teamId: 'T-demo',
        text: 'append this message',
        ts: '1770000012.000001',
        timestamp: '2026-07-28T00:00:01.000Z',
        userId: 'U2',
      }), coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);

      const drain = worker.drainOnce();
      await waitFor(() => runtime.followups.length === 1);
      assert.deepEqual(runtime.followups[0]?.itemIds, [slack.ctx.item.id]);
      await waitForInboxItemStatus('scout', memory.id, 'queued');
      await waitForInboxItemAppendedTo('scout', slack.ctx.item.id, runtime.calls[0]?.itemId ?? '');
      await worker.close();
      worker = undefined;
      assert.equal(await drain, 1);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker appends queued reminder wakes into an active runtime', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-reminder-followup-test-'));
  const runtime = new FollowupRuntime();
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
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
    const first = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-reminder-followup-first',
        teamId: 'T-demo',
        text: 'first',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);

    await seedReminder('scout', 'reminder-followup', '2026-05-18T17:00:00.000Z');
    const reminder = await enqueueInbox(
      makeReminderInboxItem({
        eventId: 'evt-reminder-followup-second',
        reminderId: 'reminder-followup',
        timestamp: '2026-05-18T17:00:00.000Z',
      }),
      coordinator,
    );

    assert.equal(reminder.queued, true);
    await waitFor(() => runtime.followups.length === 1);
    assert.equal(runtime.followups[0]?.activeItemId, first.ctx.item.id);
    assert.deepEqual(runtime.followups[0]?.itemIds, [reminder.ctx.item.id]);

    runtime.finishNext();
    assert.equal(await drain, 1);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker reclaims items owned by an exited worker', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-worker-recovery-test-'));
  const runtime = new ControlledRuntime();
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      stateDir,
      workerId: 'new-worker',
      workerIsAlive: (workerId) => workerId !== 'dead-worker',
    }, silentLogger);
    const decision = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-recover',
        teamId: 'T-demo',
        text: 'recover',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    await queueFor('scout').takeNextRunnable({ isWorkerAlive: () => true, workerId: 'dead-worker' });
    assert.equal((await queueFor('scout').list())[0]?.handling.status, 'running');

    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    assert.equal(runtime.calls[0]?.itemId, decision.ctx.item.id);
    const recovered = await queueFor('scout').find(decision.ctx.item.id);
    assert.equal(recovered?.handling.status, 'running');
    assert.equal(recovered?.handling.workerId, 'new-worker');
    runtime.finishNext();
    assert.equal(await drain, 1);

    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker reclaims running items from a previous worker generation in the same supervisor', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-replaced-worker-recovery-test-'));
  const runtime = new ControlledRuntime();
  const coordinator = ({
    agentId: 'scout',
    stateDir,
  });
  const newWorkerId = `scout:new-worker:${process.pid}`;
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      stateDir,
      workerId: newWorkerId,
      workerIsAlive: () => true,
    }, silentLogger);
    const decision = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-replaced-supervisor-worker',
        teamId: 'T-demo',
        text: 'recover replaced worker',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    const oldWorkerId = `scout:${process.pid}`;
    const claimed = await queueFor('scout').takeNextRunnable({ isWorkerAlive: () => true, workerId: oldWorkerId });
    assert.equal(claimed?.handling.status, 'running');
    assert.equal(claimed?.handling.workerId, oldWorkerId);

    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    assert.equal(runtime.calls[0]?.itemId, decision.ctx.item.id);
    const recovered = await queueFor('scout').find(decision.ctx.item.id);
    assert.equal(recovered?.handling.status, 'running');
    assert.equal(recovered?.handling.workerId, newWorkerId);
    runtime.finishNext();
    assert.equal(await drain, 1);

    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});
