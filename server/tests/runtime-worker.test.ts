import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';
import { makeReminderInboxItem } from './helpers/inbox.js';
import { WakeQueueService, type WakeQueueEnqueueResult } from '../inbox/wake-queue.service.js';
import { allActivities, loadState } from './helpers/state.js';
import type { InboxItem, InboxItemStatus } from '../../shared/inbox.js';
import type {
  AgentRuntime,
  AgentRuntimeDrainInput,
  AgentRuntimeInput,
  AgentRuntimeResult,
  AgentRuntimeFollowupInput,
} from '../runtime/provider-contract.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { clearRestartDrain, requestRestartDrain } from '../services/restart-drain.js';
import { runtimeContextForItemId } from '../runtime/context.js';
import type { RuntimeWorkerConfig, RuntimeItemContext } from '../runtime/types.js';
import { findActiveRuntimeItem } from '../runtime/active-item.js';
import { addProcessingReaction, removeProcessingReactions } from '../runtime/processing-reactions.js';

type TestInboxDecision = WakeQueueEnqueueResult & { ctx: RuntimeItemContext };

async function enqueueInbox(
  event: InboxItem,
  options: RuntimeWorkerConfig,
): Promise<TestInboxDecision> {
  await ensureTestAgentConfig(options);
  const decision = await new WakeQueueService(options.agentId).enqueue(event);
  return {
    ...decision,
    ctx: await runtimeContextForItemId(decision.item.id, options),
  };
}

const queueFor = (agentId: string): WakeQueueService => new WakeQueueService(agentId);

async function ensureTestAgentConfig(options: RuntimeWorkerConfig): Promise<void> {
  const agentDir = join(options.stateDir, 'agents', options.agentId);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'config.json'), `${JSON.stringify({ id: options.agentId }, null, 2)}\n`, 'utf8');
}

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
    assert.equal((await queueFor('scout').listRunnable())[0]?.handling.status, 'queued');

    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    assert.match(runtime.calls[0]?.prompt ?? '', /queued/);
    assert.equal((await queueFor('scout').listRunnable())[0]?.handling.status, 'running');
    runtime.finishNext();
    assert.equal(await drain, 1);

    assert.equal((await queueFor('scout').listRunnable())[0]?.handling.status, 'completed');
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
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await findActiveRuntimeItem('scout'))?.itemId, decision.ctx.item.id);
      assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'running');

      runtime.finishNext();
      await close;
      await drain;
      assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'completed');
      assert.equal(await findActiveRuntimeItem('scout'), undefined);
      worker = undefined;
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
    assert.equal(runtime.followups[0]?.itemId, second.ctx.item.id);
    await waitForInboxItemStatus('scout', second.ctx.item.id, 'completed');
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
    assert.equal(runtime.followups[1]?.itemId, third.ctx.item.id);
    await waitForInboxItemStatus('scout', third.ctx.item.id, 'completed');
    await waitFor(() => reactionCalls.includes('add:D-user:1770000012.000001:eyes'));
    assert.deepEqual(reactionCalls, [
      'add:D-user:1770000010.000001:eyes',
      'add:D-user:1770000011.000001:eyes',
      'add:D-user:1770000012.000001:eyes',
    ]);
    assert.deepEqual(settledTurnIds, []);

    runtime.finishNext();
    assert.equal(await drain, 1);
    assert.equal((await queueFor('scout').listRunnable()).find((item) => item.id === first.ctx.item.id)?.handling.status, 'completed');
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
    assert.equal(runtime.followups[0]?.itemId, second.ctx.item.id);
    await waitFor(() => followupSignals.length === 1);
    assert.deepEqual(followupSignals, [`${first.ctx.item.id}:${second.ctx.item.id}`]);
    await waitForInboxItemStatus('scout', second.ctx.item.id, 'completed');

    runtime.finishNext();
    assert.equal(await drain, 1);
    assert.equal((await queueFor('scout').find(first.ctx.item.id))?.handling.status, 'completed');
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
    assert.equal((await queueFor('scout').find(first.ctx.item.id))?.handling.status, 'completed');
    assert.equal((await queueFor('scout').find(second.ctx.item.id))?.handling.status, 'completed');
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

    assert.equal(second.queued, true);
    await waitFor(() => runtime.followups.length === 1);
    await waitForInboxItemStatus('scout', second.ctx.item.id, 'queued');
    await waitForAsync(async () => allActivities(await loadState()).some((activity) => activity.type === 'runtime.pending'));
    const pending = allActivities(await loadState()).find((activity) => activity.type === 'runtime.pending');
    assert.equal(pending?.payload?.['reason'], 'followup_rejected');

    runtime.finishNext();
    await waitFor(() => runtime.calls.length === 2);
    runtime.finishNext();
    assert.equal(await drain, 2);
    assert.equal((await queueFor('scout').find(second.ctx.item.id))?.handling.status, 'completed');
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
    assert.equal(runtime.followups[0]?.itemId, reminder.ctx.item.id);

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

    await queueFor('scout').claimNext('dead-worker');
    assert.equal((await queueFor('scout').listRunnable())[0]?.handling.status, 'running');

    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    assert.equal(runtime.calls[0]?.itemId, decision.ctx.item.id);
    runtime.finishNext();
    assert.equal(await drain, 1);

    const recovered = (await queueFor('scout').listRunnable())[0];
    assert.equal(recovered?.handling.status, 'completed');
    assert.equal(recovered?.handling.workerId, 'new-worker');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker injects provider env while preserving Anima-managed env', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-env-test-'));
  const runtime = new ControlledRuntime({
    ANIMA_AGENT_ID: 'bad-agent',
    ANIMA_HOME: '/bad/home',
    CUSTOM_LAUNCH_FLAG: 'enabled',
    PATH: '/custom/bin',
  });
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      stateDir,
      workerId: 'test-worker',
    }, silentLogger);
    await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-env',
        teamId: 'T-demo',
        text: 'env',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    runtime.finishNext();
    await drain;

    const env = runtime.calls[0]?.env;
    assert.equal(env?.CUSTOM_LAUNCH_FLAG, 'enabled');
    assert.equal(env?.ANIMA_AGENT_ID, 'scout');
    assert.equal(env?.ANIMA_HOME, stateDir);
    assert.match(env?.PATH ?? '', /^.*bin:\/custom\/bin$/);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

class ControlledRuntime implements AgentRuntime {
  readonly kind = 'controlled';
  readonly calls: AgentRuntimeInput[] = [];
  completed = 0;
  private readonly resolvers: Array<() => void> = [];

  constructor(readonly env?: Record<string, string>) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    await new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
    this.completed += 1;
    return { text: `completed ${input.itemId}` };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }

  async close(): Promise<void> {
    while (this.resolvers.length > 0) this.resolvers.shift()?.();
  }

  finishNext(): void {
    const resolve = this.resolvers.shift();
    assert.ok(resolve, 'Expected an active runtime call');
    resolve();
  }
}

class FollowupRuntime extends ControlledRuntime {
  readonly followups: AgentRuntimeFollowupInput[] = [];

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean; text: string }> {
    this.followups.push(input);
    return { accepted: true, text: `appended ${input.itemId}` };
  }
}

class RejectingFollowupRuntime extends ControlledRuntime {
  readonly followups: AgentRuntimeFollowupInput[] = [];

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    this.followups.push(input);
    return { accepted: false };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForInboxItemStatus(
  agentId: string,
  itemId: string,
  status: InboxItemStatus,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const item = (await queueFor(agentId).listRunnable()).find((candidate) => candidate.id === itemId);
    if (item?.handling.status === status) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for item ${itemId} to reach ${status}; current status is ${item?.handling.status ?? 'missing'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const silentLogger = {
  error: () => {},
  log: () => {},
};

class AbortableRuntime implements AgentRuntime {
  readonly kind = 'abortable';
  readonly calls: AgentRuntimeInput[] = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    return new Promise((_, reject) => {
      if (input.signal?.aborted) {
        reject(new Error(`aborted: ${String(input.signal.reason)}`));
        return;
      }
      input.signal?.addEventListener('abort', () => {
        reject(new Error(`aborted: ${String(input.signal?.reason)}`));
      }, { once: true });
    });
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

class DrainableRuntime extends AbortableRuntime {
  readonly drainCalls: AgentRuntimeDrainInput[] = [];

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    this.drainCalls.push(input);
  }
}

class ActivityBeforeFinishRuntime implements AgentRuntime {
  readonly kind = 'activity-runtime';
  readonly calls: AgentRuntimeInput[] = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (input.signal?.aborted) throw new Error(`aborted: ${String(input.signal.reason)}`);
    await input.effects.recordOutput('stdout', 'still running');
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (input.signal?.aborted) throw new Error(`aborted: ${String(input.signal.reason)}`);
    return { text: 'finished after activity' };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

class CrashThenSuccessRuntime implements AgentRuntime {
  readonly kind = 'codex-cli';
  readonly calls: AgentRuntimeInput[] = [];

  constructor(private readonly failuresBeforeSuccess: number) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    if (this.calls.length <= this.failuresBeforeSuccess) {
      throw new Error('Codex app-server runtime exited before completing active requests');
    }
    return { text: 'recovered' };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

class FatalProviderRuntime implements AgentRuntime {
  readonly kind = 'claude-code';
  readonly calls: AgentRuntimeInput[] = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    throw new Error('Invalid API key');
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

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
      assert.equal(resumedRuntime.calls[0]?.prompt, [
        'Anima system message: runtime restarted while this task was in progress.',
        'Continue the same task from the current session; do not repeat completed external side effects.',
      ].join('\n'));
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

    await queueFor('scout').requestStop(decision.ctx.item.id);
    await waitForInboxItemStatus('scout', decision.ctx.item.id, 'failed', 5_000);
    await drain;

    const item = await queueFor('scout').find(decision.ctx.item.id);
    assert.ok(item?.handling.stopRequestedAt, 'expected stopRequestedAt to be set');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker idle watchdog aborts a item that produces no activity', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-idle-test-'));
  const runtime = new AbortableRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      idleTimeoutMs: 200,
      pollIntervalMs: 10_000,
      stateDir,
      workerId: 'test-worker',
    }, silentLogger);
    const decision = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-idle',
        teamId: 'T-demo',
        text: 'idle stuck',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitForInboxItemStatus('scout', decision.ctx.item.id, 'failed', 5_000);
    await drain;

    assert.equal(runtime.calls.length, 1);
    const activities = allActivities(await loadState());
    const aborted = activities.find((activity) => activity.type === 'runtime.aborted');
    assert.equal(aborted?.payload?.['reason'], 'idle_timeout');
    assert.equal(aborted?.payload?.['timeoutMs'], 200);
    assert.equal(
      activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry'),
      false,
    );
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker idle watchdog resets on provider activity effects', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-idle-activity-test-'));
  const runtime = new ActivityBeforeFinishRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
    worker = new AgentRuntimeWorker({
      agentId: 'scout',
      agentRuntime: runtime,
      queue: queueFor('scout'),
      idleTimeoutMs: 220,
      pollIntervalMs: 10_000,
      stateDir,
      workerId: 'test-worker',
    }, silentLogger);
    const decision = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-idle-activity',
        teamId: 'T-demo',
        text: 'long running but active',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    assert.equal(await drain, 1);

    assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'completed');
    const activities = allActivities(await loadState());
    assert.ok(activities.some((activity) => activity.type === 'runtime.output'));
    assert.equal(activities.some((activity) => activity.type === 'runtime.aborted'), false);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker retries provider process crashes and continues same item', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-provider-retry-test-'));
  const runtime = new CrashThenSuccessRuntime(1);
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
        eventId: 'evt-provider-retry',
        teamId: 'T-demo',
        text: 'recover this',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    assert.equal(await drain, 1);

    assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'completed');
    assert.equal(runtime.calls.length, 2);
    assert.match(runtime.calls[1]?.prompt ?? '', /previous provider process crashed/);
    assert.match(runtime.calls[1]?.prompt ?? '', /Do not repeat completed external side effects/);
    const activities = allActivities(await loadState());
    assert.ok(activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry'));
    assert.equal(activities.some((activity) => activity.type === 'runtime.failed'), false);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker records provider failure after retry exhaustion', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-provider-retry-exhausted-test-'));
  const runtime = new CrashThenSuccessRuntime(10);
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
        eventId: 'evt-provider-retry-exhausted',
        teamId: 'T-demo',
        text: 'fail this',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    assert.equal(await drain, 1);

    assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'failed');
    assert.equal(runtime.calls.length, 4);
    const activities = allActivities(await loadState());
    assert.equal(
      activities.filter((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry').length,
      3,
    );
    const failed = activities.find((activity) => activity.type === 'runtime.failed');
    assert.equal(failed?.payload?.['failureSource'], 'provider');
    assert.equal(failed?.payload?.['providerReason'], 'process_crash');
    assert.equal(failed?.payload?.['retryAttempts'], 3);
    assert.equal(failed?.payload?.['maxRetries'], 3);
    assert.equal(failed?.payload?.['retryable'], false);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker records non-crash provider errors without retrying', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-provider-noncrash-test-'));
  const runtime = new FatalProviderRuntime();
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
        eventId: 'evt-provider-noncrash',
        teamId: 'T-demo',
        text: 'bad key',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    assert.equal(await drain, 1);

    assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'failed');
    assert.equal(runtime.calls.length, 1);
    const activities = allActivities(await loadState());
    assert.equal(
      activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry'),
      false,
    );
    const failed = activities.find((activity) => activity.type === 'runtime.failed');
    assert.equal(failed?.payload?.['failureSource'], 'provider');
    assert.equal(failed?.payload?.['providerReason'], 'provider_error');
    assert.equal(failed?.payload?.['retryable'], false);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});
