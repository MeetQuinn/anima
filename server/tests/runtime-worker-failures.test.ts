import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';
import { waitFor } from './helpers/harness.js';
import { allActivities, loadState } from './helpers/state.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { AgentHealthService } from '../runtime/agent-health.service.js';
import { AgentHealthStore } from '../runtime/agent-health.store.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import type {
  AgentRuntime,
  AgentRuntimeFollowupInput,
  AgentRuntimeInput,
  AgentRuntimeResult,
} from '../providers/contract.js';
import {
  AbortableRuntime,
  ActivityBeforeFinishRuntime,
  ControlledRuntime,
  CrashThenSuccessRuntime,
  FatalProviderRuntime,
  enqueueInbox,
  queueFor,
  silentLogger,
  waitForInboxItemRemoved,
} from './helpers/runtime-worker.js';

class ProgressThenWaitRuntime implements AgentRuntime {
  readonly kind = 'progress-then-wait';
  readonly calls: AgentRuntimeInput[] = [];
  completed = 0;
  private readonly resolvers: Array<() => void> = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    await input.effects.recordToolStarted({
      providerToolId: 'tool-progress',
      providerToolName: 'Bash',
      tool: 'claude.Bash',
    });
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

test('runtime worker passes cached Slack identity into the standing prompt', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-slack-identity-test-'));
  const runtime = new ControlledRuntime();
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
          eventId: 'evt-slack-identity',
          teamId: 'T-demo',
          text: 'who am I',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );
      await writeFile(join(stateDir, 'agents', 'scout', 'config.json'), `${JSON.stringify({
        id: 'scout',
        profile: { displayName: 'Scout' },
        slack: {
          appToken: 'xapp-test',
          botHandle: 'scout-bot',
          botName: 'scout-bot',
          botToken: 'xoxb-test',
          botUserId: 'U-SCOUT',
        },
      }, null, 2)}\n`, 'utf8');

      const drain = worker.drainOnce();
      await waitFor(() => runtime.calls.length === 1);
      assert.match(
        runtime.calls[0]?.systemPrompt ?? '',
        /In Slack you are \*\*@scout-bot\*\* \(user id `U-SCOUT`\)/,
      );
      runtime.finishNext();
      assert.equal(await drain, 1);
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

test('runtime worker records generic provider errors as unhealthy', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-provider-generic-test-'));
  const runtime = new FatalProviderRuntime('opaque provider failure');
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
        eventId: 'evt-provider-generic',
        teamId: 'T-demo',
        text: 'provider failed',
        ts: '1770000011.000001',
        userId: 'U1',
      }),
      coordinator,
    );

    assert.equal(await worker.drainOnce(), 1);
    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
    assert.equal(runtime.calls.length, 1);

    const failed = allActivities(await loadState()).find((activity) => activity.type === 'runtime.failed');
    assert.equal(failed?.payload?.['failureSource'], 'provider');
    assert.equal(failed?.payload?.['providerReason'], 'provider_error');
    assert.equal(failed?.payload?.['retryable'], false);
    const health = await new AgentHealthStore({ animaHome: stateDir }).get('scout');
    assert.equal(health?.state, 'unhealthy');
    assert.equal(health?.reason, 'provider_error');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker clears provider failure after real provider progress before completion', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-provider-progress-health-test-'));
  const runtime = new ProgressThenWaitRuntime();
  const coordinator = { agentId: 'scout', stateDir };
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const healthStore = new AgentHealthStore({ animaHome: stateDir });
      const healthService = new AgentHealthService(healthStore);
      await healthService.writeProviderFailure({
        agentId: 'scout',
        reason: 'provider_auth_failed',
        updatedAt: '2026-07-06T15:54:00.000Z',
      });
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
          eventId: 'evt-provider-progress',
          teamId: 'T-demo',
          text: 'recover after login',
          ts: '1770000012.000001',
          userId: 'U1',
        }),
        coordinator,
      );

      const drain = worker.drainOnce();
      await waitFor(() => runtime.calls.length === 1);
      await waitFor(async () => {
        const health = await healthStore.get('scout');
        return health?.state === 'healthy' && health.reason === undefined;
      });
      assert.equal((await queueFor('scout').find(decision.ctx.item.id))?.handling.status, 'running');

      runtime.finishNext();
      assert.equal(await drain, 1);
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
    await waitForInboxItemRemoved('scout', decision.ctx.item.id, 5_000);
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

test('runtime worker records operator restart aborts without requeueing the active item', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-operator-restart-test-'));
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
        eventId: 'evt-operator-restart',
        teamId: 'T-demo',
        text: 'restart me',
        ts: '1770000010.000001',
        userId: 'U1',
      }),
      coordinator,
    );
    const drain = worker.drainOnce();
    await waitFor(() => runtime.calls.length === 1);
    const queued = await enqueueInbox(
      makeSlackEvent({
        channelId: 'D-user',
        eventId: 'evt-after-operator-restart',
        teamId: 'T-demo',
        text: 'preserve me',
        ts: '1770000010.000002',
        userId: 'U1',
      }),
      coordinator,
    );

    await worker.close({ abortReason: 'operator_restart' });
    await drain;

    const item = await queueFor('scout').find(decision.ctx.item.id);
    assert.equal(item, undefined);
    const queuedItem = await queueFor('scout').find(queued.ctx.item.id);
    assert.equal(queuedItem?.handling.status, 'queued');
    const activities = allActivities(await loadState());
    const aborted = activities.find((activity) => activity.type === 'runtime.aborted');
    assert.equal(aborted?.payload?.['reason'], 'operator_restart');
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

    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
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

    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
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

    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
    assert.equal(runtime.calls.length, 4);
    const activities = await activitiesForInboxItemWindow('scout', decision.ctx.item.id);
    assert.equal(
      activities.filter((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry').length,
      3,
    );
    const failed = activities.find((activity) => activity.type === 'runtime.failed');
    assert.equal(failed?.payload?.['failureSource'], 'provider');
    assert.equal(failed?.payload?.['itemId'], decision.ctx.item.id);
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

    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
    assert.equal(runtime.calls.length, 1);
    const activities = allActivities(await loadState());
    assert.equal(
      activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry'),
      false,
    );
    const failed = activities.find((activity) => activity.type === 'runtime.failed');
    assert.equal(failed?.payload?.['failureSource'], 'provider');
    assert.equal(failed?.payload?.['providerReason'], 'provider_auth_failed');
    assert.equal(failed?.payload?.['retryable'], false);
    const health = await new AgentHealthStore({ animaHome: stateDir }).get('scout');
    assert.equal(health?.state, 'unhealthy');
    assert.equal(health?.reason, 'provider_auth_failed');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});
