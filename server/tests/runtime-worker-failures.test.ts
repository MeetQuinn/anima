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
import { runtimeSessionServiceForAgent } from '../runtime/runtime-session.service.js';
import { ProviderSessionCorruptionError } from '../providers/session-corruption.js';
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
  waitForInboxItemAppendedTo,
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

class CorruptSessionThenSuccessRuntime implements AgentRuntime {
  readonly kind = 'codex-cli';
  readonly calls: AgentRuntimeInput[] = [];
  closeCalls = 0;

  constructor(private readonly corruptionsBeforeSuccess: number) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    if (this.calls.length <= this.corruptionsBeforeSuccess) {
      throw new ProviderSessionCorruptionError(
        'codex-thread-corrupt',
        'missing_tool_output',
        new Error('Custom tool call output is missing for call id: call_corrupt'),
      );
    }
    await input.effects.persistProviderSession({
      id: 'codex-thread-fresh',
      updatedAt: '2026-07-11T19:30:00.000Z',
    });
    return { text: 'recovered on a fresh session' };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class CorruptAfterFollowupRuntime implements AgentRuntime {
  readonly kind = 'codex-cli';
  readonly calls: AgentRuntimeInput[] = [];
  readonly followups: AgentRuntimeFollowupInput[] = [];
  private active = false;
  private firstReject?: (error: unknown) => void;
  private freshResolve?: (result: AgentRuntimeResult) => void;

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    this.active = true;
    if (this.calls.length === 1) {
      return new Promise((_, reject) => {
        this.firstReject = reject;
      });
    }
    await input.effects.persistProviderSession({
      id: 'codex-thread-fresh',
      updatedAt: '2026-07-11T19:30:00.000Z',
    });
    return new Promise((resolve) => {
      this.freshResolve = resolve;
    });
  }

  async appendToActiveRun(
    input: AgentRuntimeFollowupInput,
  ): Promise<{ accepted: boolean; retryable?: boolean; text?: string }> {
    if (!this.active) return { accepted: false, retryable: true };
    this.followups.push(input);
    return { accepted: true, text: `appended ${input.itemId}` };
  }

  async close(): Promise<void> {
    this.active = false;
    this.firstReject?.(new Error('closed'));
    this.firstReject = undefined;
    this.freshResolve?.({ text: 'closed' });
    this.freshResolve = undefined;
  }

  corruptFirstRun(): void {
    const reject = this.firstReject;
    assert.ok(reject, 'Expected the resumed run to be active');
    this.active = false;
    this.firstReject = undefined;
    reject(new ProviderSessionCorruptionError(
      'codex-thread-corrupt',
      'turn_desync',
      new Error('expected active turn id turn-old but found turn-new'),
    ));
  }

  finishFreshRun(): void {
    const resolve = this.freshResolve;
    assert.ok(resolve, 'Expected the fresh run to be active');
    this.active = false;
    this.freshResolve = undefined;
    resolve({ text: 'recovered with follow-up replayed' });
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
    await runtimeSessionServiceForAgent('scout').persistProviderSession('codex-cli', {
      id: 'codex-thread-healthy',
      updatedAt: '2026-07-11T19:20:00.000Z',
    });
    const drain = worker.drainOnce();
    assert.equal(await drain, 1);

    assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
    assert.equal(runtime.calls.length, 2);
    assert.equal(runtime.calls[0]?.providerSession?.id, 'codex-thread-healthy');
    assert.equal(runtime.calls[1]?.providerSession?.id, 'codex-thread-healthy');
    assert.match(runtime.calls[1]?.prompt ?? '', /previous provider process crashed/);
    assert.match(runtime.calls[1]?.prompt ?? '', /Do not repeat completed external side effects/);
    const activities = allActivities(await loadState());
    assert.ok(activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === 'provider.crash.retry'));
    assert.equal(activities.some((activity) => activity.type === 'runtime.failed'), false);
    const session = await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
    assert.equal(session.current?.id, 'codex-thread-healthy');
    assert.equal(session.archived, undefined);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker archives a confirmed corrupt session and retries the same item fresh once', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-session-recovery-test-'));
  const runtime = new CorruptSessionThenSuccessRuntime(1);
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
          eventId: 'evt-session-recovery',
          teamId: 'T-demo',
          text: 'recover this item',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );
      await runtimeSessionServiceForAgent('scout').persistProviderSession('codex-cli', {
        id: 'codex-thread-corrupt',
        updatedAt: '2026-07-11T19:20:00.000Z',
      });

      assert.equal(await worker.drainOnce(), 1);
      assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
      assert.equal(runtime.calls.length, 2);
      assert.equal(runtime.closeCalls, 1);
      assert.equal(runtime.calls[0]?.providerSession?.id, 'codex-thread-corrupt');
      assert.equal(runtime.calls[1]?.providerSession, undefined);
      assert.match(runtime.calls[1]?.prompt ?? '', /Provider session recovery:/);
      assert.match(runtime.calls[1]?.prompt ?? '', /Do not repeat completed external side effects/);

      const session = await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
      assert.equal(session.current?.id, 'codex-thread-fresh');
      assert.equal(session.archived?.length, 1);
      assert.equal(session.archived?.[0]?.id, 'codex-thread-corrupt');
      assert.equal(session.archived?.[0]?.archivedBy, 'recovery');
      const activities = allActivities(await loadState());
      const rotation = activities.find((activity) => activity.type === 'anima.session.rotate');
      assert.equal(rotation?.payload?.['automatic'], true);
      assert.equal(rotation?.payload?.['reason'], 'missing_tool_output');
      assert.equal(rotation?.payload?.['itemId'], decision.ctx.item.id);
      assert.equal(activities.some((activity) => activity.type === 'runtime.failed'), false);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker never rotates twice for the same corrupt-session item', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-session-recovery-once-test-'));
  const runtime = new CorruptSessionThenSuccessRuntime(2);
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
          eventId: 'evt-session-recovery-once',
          teamId: 'T-demo',
          text: 'do not loop',
          ts: '1770000010.000002',
          userId: 'U1',
        }),
        coordinator,
      );
      await runtimeSessionServiceForAgent('scout').persistProviderSession('codex-cli', {
        id: 'codex-thread-corrupt',
        updatedAt: '2026-07-11T19:20:00.000Z',
      });

      assert.equal(await worker.drainOnce(), 1);
      assert.equal(runtime.calls.length, 2);
      assert.equal(runtime.closeCalls, 1);
      assert.equal(await queueFor('scout').find(decision.ctx.item.id), undefined);
      const session = await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
      assert.equal(session.current, undefined);
      assert.equal(session.archived?.length, 1);
      const activities = allActivities(await loadState());
      assert.equal(
        activities.filter((activity) => activity.type === 'anima.session.rotate').length,
        1,
      );
      assert.ok(activities.some((activity) => activity.type === 'runtime.failed'));
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker requeues follow-ups accepted by the corrupt turn and appends them to the fresh turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-session-recovery-followup-test-'));
  const runtime = new CorruptAfterFollowupRuntime();
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
      const primary = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-user',
          eventId: 'evt-session-recovery-primary',
          teamId: 'T-demo',
          text: 'primary item',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
        coordinator,
      );
      await runtimeSessionServiceForAgent('scout').persistProviderSession('codex-cli', {
        id: 'codex-thread-corrupt',
        updatedAt: '2026-07-11T19:20:00.000Z',
      });

      const drain = worker.drainOnce();
      await waitFor(() => runtime.calls.length === 1);
      const followup = await enqueueInbox(
        makeSlackEvent({
          channelId: 'D-user',
          eventId: 'evt-session-recovery-followup',
          teamId: 'T-demo',
          text: 'follow-up that must survive',
          ts: '1770000010.000002',
          userId: 'U1',
        }),
        coordinator,
      );
      await waitForInboxItemAppendedTo('scout', followup.ctx.item.id, primary.ctx.item.id);
      assert.equal(runtime.followups.length, 1);

      runtime.corruptFirstRun();
      await waitFor(() => runtime.calls.length === 2);
      await waitFor(() => runtime.followups.length === 2);
      assert.match(runtime.followups[0]?.prompt ?? '', /follow-up that must survive/);
      assert.match(runtime.followups[1]?.prompt ?? '', /follow-up that must survive/);
      runtime.finishFreshRun();

      assert.equal(await drain, 1);
      assert.equal(await queueFor('scout').find(primary.ctx.item.id), undefined);
      assert.equal(await queueFor('scout').find(followup.ctx.item.id), undefined);
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
