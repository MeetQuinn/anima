import {
  AgentHealthEvidenceStore,
  HEALTH_EVIDENCE_CAP,
} from '../runtime/agent-health-evidence.store.js';

import { buildAgentDiagnostics } from '../diagnostics/agent-diagnostics.service.js';

import { JsonFile } from '../storage/json-file.js';

import type { StaleRunningEvidence } from '../../shared/diagnostics.js';

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentHealthService,
  applyHealthWrite,
  applyProviderErrorClear,
  applyProviderFailure,
  sampleApiHealth,
  isStaleRunningItem,
  runtimeHandleHealth,
  startingTimeoutHealth,
} from '../runtime/agent-health.service.js';
import { AgentHealthStore } from '../runtime/agent-health.store.js';
import type { AgentRuntimeHandleSnapshot } from '../../shared/snapshot.js';
import { withAnimaHome } from '../anima-home.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { setActiveRuntimeItem } from '../runtime/active-item.js';
import { RuntimeService } from '../runtime/runtime.service.js';
import { defaultAgentConfig, writeAgentConfigs } from './helpers/harness.js';
import { ingestEvent } from './helpers/inbox.js';
import { makeSlackEvent } from './helpers/slack.js';

function runtimeSnapshot(overrides: Partial<AgentRuntimeHandleSnapshot> = {}): AgentRuntimeHandleSnapshot {
  return {
    providerChildExpected: false,
    workerId: 'worker-1',
    ...overrides,
  };
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (!child.pid) throw new Error('failed to spawn probe child');
  return child.pid;
}

test('healthy write without clearProviderFailure keeps a provider failure', () => {
  const next = applyHealthWrite(
    {
      reason: 'provider_quota_exhausted',
      state: 'unhealthy',
      updatedAt: '2026-06-04T01:00:00.000Z',
    },
    {
      runtime: runtimeSnapshot({ workerId: 'worker-healthy' }),
      state: 'healthy',
      updatedAt: '2026-06-04T01:01:00.000Z',
    },
  );

  assert.equal(next.state, 'unhealthy');
  assert.equal(next.reason, 'provider_quota_exhausted');
  assert.equal(next.runtime?.workerId, 'worker-healthy');
  assert.equal(next.updatedAt, '2026-06-04T01:01:00.000Z');
});

test('healthy write with clearProviderFailure clears the failure', () => {
  const next = applyHealthWrite(
    {
      reason: 'provider_auth_failed',
      state: 'unhealthy',
      updatedAt: '2026-06-04T01:00:00.000Z',
    },
    {
      clearProviderFailure: true,
      runtime: runtimeSnapshot({ workerId: 'worker-cleared' }),
      state: 'healthy',
      updatedAt: '2026-06-04T01:02:00.000Z',
    },
  );

  assert.equal(next.state, 'healthy');
  assert.equal(next.reason, undefined);
  assert.equal(next.runtime?.workerId, 'worker-cleared');
});

test('non-healthy write replaces a provider failure snapshot', () => {
  const next = applyHealthWrite(
    {
      reason: 'provider_quota_exhausted',
      state: 'unhealthy',
      updatedAt: '2026-06-04T01:00:00.000Z',
    },
    {
      state: 'starting',
      updatedAt: '2026-06-04T01:01:00.000Z',
    },
  );

  assert.equal(next.state, 'starting');
  assert.equal(next.reason, undefined);
});

test('rate limits degrade first and escalate to unhealthy after the grace window', () => {
  const first = applyProviderFailure(undefined, {
    reason: 'provider_rate_limited',
    updatedAt: '2026-06-04T01:00:00.000Z',
  });
  assert.equal(first.state, 'degraded');
  assert.equal(first.reason, 'provider_rate_limited');
  assert.equal(first.updatedAt, '2026-06-04T01:00:00.000Z');

  const withinGrace = applyProviderFailure(first, {
    reason: 'provider_rate_limited',
    updatedAt: '2026-06-04T01:00:30.000Z',
  });
  assert.equal(withinGrace.state, 'degraded');
  assert.equal(withinGrace.updatedAt, '2026-06-04T01:00:00.000Z');

  const escalated = applyProviderFailure(withinGrace, {
    reason: 'provider_rate_limited',
    updatedAt: '2026-06-04T01:01:00.000Z',
  });
  assert.equal(escalated.state, 'unhealthy');
  assert.equal(escalated.reason, 'provider_rate_limited');
  assert.equal(escalated.updatedAt, '2026-06-04T01:01:00.000Z');
});

test('non-rate-limit provider failures go unhealthy immediately', () => {
  const next = applyProviderFailure(undefined, {
    reason: 'provider_error',
    updatedAt: '2026-06-04T01:00:00.000Z',
  });
  assert.equal(next.state, 'unhealthy');
  assert.equal(next.reason, 'provider_error');
});

test('carried rate limits decay to unknown as evidence goes stale', () => {
  const degraded = applyProviderFailure(undefined, {
    reason: 'provider_rate_limited',
    updatedAt: '2026-06-04T01:00:00.000Z',
  });

  const carriedGrace = applyHealthWrite(degraded, {
    runtime: runtimeSnapshot({ workerId: 'worker-grace' }),
    state: 'healthy',
    updatedAt: '2026-06-04T01:00:30.000Z',
  });
  assert.equal(carriedGrace.state, 'degraded');
  assert.equal(carriedGrace.reason, 'provider_rate_limited');
  assert.equal(carriedGrace.updatedAt, '2026-06-04T01:00:00.000Z');
  assert.equal(carriedGrace.runtime?.workerId, 'worker-grace');

  const expiredGrace = applyHealthWrite(degraded, {
    runtime: runtimeSnapshot({ workerId: 'worker-expired' }),
    state: 'healthy',
    updatedAt: '2026-06-04T01:01:00.000Z',
  });
  assert.equal(expiredGrace.state, 'unknown');
  assert.equal(expiredGrace.reason, undefined);
  assert.equal(expiredGrace.runtime?.workerId, 'worker-expired');

  const escalated = applyProviderFailure(
    applyProviderFailure(undefined, {
      reason: 'provider_rate_limited',
      updatedAt: '2026-06-04T02:00:00.000Z',
    }),
    {
      reason: 'provider_rate_limited',
      updatedAt: '2026-06-04T02:01:00.000Z',
    },
  );

  const carriedRed = applyHealthWrite(escalated, {
    runtime: runtimeSnapshot({ workerId: 'worker-red' }),
    state: 'healthy',
    updatedAt: '2026-06-04T02:04:00.000Z',
  });
  assert.equal(carriedRed.state, 'unhealthy');
  assert.equal(carriedRed.reason, 'provider_rate_limited');
  assert.equal(carriedRed.updatedAt, '2026-06-04T02:01:00.000Z');

  const expiredRed = applyHealthWrite(escalated, {
    runtime: runtimeSnapshot({ workerId: 'worker-red-expired' }),
    state: 'healthy',
    updatedAt: '2026-06-04T02:06:30.000Z',
  });
  assert.equal(expiredRed.state, 'unknown');
  assert.equal(expiredRed.reason, undefined);
  assert.equal(expiredRed.runtime?.workerId, 'worker-red-expired');
});

test('restart summaries carry across writes until a healthy write clears a failed one', () => {
  const failedRestart = {
    completedAt: '2026-06-03T19:30:00.000Z',
    outcome: 'failed' as const,
    reason: 'restart_failed' as const,
    requestId: 'restart-1',
    requestedAt: '2026-06-03T19:29:00.000Z',
  };

  const carried = applyHealthWrite(
    {
      reason: 'restart_failed',
      restart: failedRestart,
      state: 'unhealthy',
      updatedAt: '2026-06-03T19:30:00.000Z',
    },
    { state: 'starting', updatedAt: '2026-06-03T19:30:30.000Z' },
  );
  assert.equal(carried.restart?.requestId, 'restart-1');

  const healthy = applyHealthWrite(
    {
      reason: 'restart_failed',
      restart: failedRestart,
      state: 'unhealthy',
      updatedAt: '2026-06-03T19:30:00.000Z',
    },
    {
      runtime: runtimeSnapshot(),
      state: 'healthy',
      updatedAt: '2026-06-03T19:31:00.000Z',
    },
  );
  assert.equal(healthy.state, 'healthy');
  assert.equal(healthy.restart, undefined);

  const recoveredRestart = { ...failedRestart, outcome: 'recovered' as const };
  const keptRecovered = applyHealthWrite(
    {
      restart: recoveredRestart,
      state: 'healthy',
      updatedAt: '2026-06-03T19:32:00.000Z',
    },
    {
      runtime: runtimeSnapshot(),
      state: 'healthy',
      updatedAt: '2026-06-03T19:33:00.000Z',
    },
  );
  assert.equal(keptRecovered.restart?.outcome, 'recovered');
});

test('runtime handle health debounces transient child issues before escalating', () => {
  const missing = runtimeSnapshot({ providerChildExpected: true });

  assert.deepEqual(runtimeHandleHealth(undefined, undefined, '2026-06-05T10:00:00.000Z'), {
    reason: 'start_failed',
    state: 'unhealthy',
    updatedAt: '2026-06-05T10:00:00.000Z',
  });

  assert.deepEqual(runtimeHandleHealth(runtimeSnapshot(), undefined, '2026-06-05T10:00:00.000Z'), {
    state: 'healthy',
    updatedAt: '2026-06-05T10:00:00.000Z',
  });

  const firstObservation = runtimeHandleHealth(missing, undefined, '2026-06-05T10:00:00.000Z');
  assert.deepEqual(firstObservation, {
    reason: 'provider_child_missing',
    state: 'degraded',
    updatedAt: '2026-06-05T10:00:00.000Z',
  });

  const withinDebounce = runtimeHandleHealth(
    missing,
    {
      reason: 'provider_child_missing',
      state: 'degraded',
      updatedAt: '2026-06-05T10:00:00.000Z',
    },
    '2026-06-05T10:00:05.000Z',
  );
  assert.deepEqual(withinDebounce, {
    reason: 'provider_child_missing',
    state: 'degraded',
    updatedAt: '2026-06-05T10:00:00.000Z',
  });

  const escalated = runtimeHandleHealth(
    missing,
    {
      reason: 'provider_child_missing',
      state: 'degraded',
      updatedAt: '2026-06-05T10:00:00.000Z',
    },
    '2026-06-05T10:00:11.000Z',
  );
  assert.deepEqual(escalated, {
    reason: 'provider_child_missing',
    state: 'unhealthy',
    updatedAt: '2026-06-05T10:00:11.000Z',
  });

  const alreadyUnhealthy = runtimeHandleHealth(
    missing,
    {
      reason: 'provider_child_missing',
      state: 'unhealthy',
      updatedAt: '2026-06-05T10:00:11.000Z',
    },
    '2026-06-05T10:00:12.000Z',
  );
  assert.equal(alreadyUnhealthy.state, 'unhealthy');
});

test('starting snapshots time out to start_failed or restart_failed', () => {
  const fresh = startingTimeoutHealth(
    { state: 'starting', updatedAt: '2026-06-05T10:00:00.000Z' },
    '2026-06-05T10:00:20.000Z',
  );
  assert.equal(fresh, undefined);

  const notStarting = startingTimeoutHealth(
    { state: 'healthy', updatedAt: '2026-06-05T10:00:00.000Z' },
    '2026-06-05T10:01:00.000Z',
  );
  assert.equal(notStarting, undefined);

  const timedOut = startingTimeoutHealth(
    {
      runtime: runtimeSnapshot(),
      state: 'starting',
      updatedAt: '2026-06-05T10:00:00.000Z',
    },
    '2026-06-05T10:00:31.000Z',
  );
  assert.equal(timedOut?.state, 'unhealthy');
  assert.equal(timedOut?.reason, 'start_failed');
  assert.equal(timedOut?.runtime?.workerId, 'worker-1');
  assert.equal(timedOut?.updatedAt, '2026-06-05T10:00:31.000Z');

  const restartTimedOut = startingTimeoutHealth(
    {
      restart: {
        outcome: 'pending',
        requestId: 'restart-1',
        requestedAt: '2026-06-05T10:00:00.000Z',
      },
      state: 'starting',
      updatedAt: '2026-06-05T10:00:00.000Z',
    },
    '2026-06-05T10:00:31.000Z',
  );
  assert.equal(restartTimedOut?.reason, 'restart_failed');
  assert.equal(restartTimedOut?.restart?.outcome, 'failed');
  assert.equal(restartTimedOut?.restart?.reason, 'restart_failed');
  assert.equal(restartTimedOut?.restart?.completedAt, '2026-06-05T10:00:31.000Z');
});

test('stale running item predicate covers worker and item ownership mismatches', () => {
  const nowMs = Date.parse('2026-06-05T10:00:15.000Z');
  const base = {
    activeItemMismatchGraceMs: 0,
    includeProviderChildCheck: true,
    nowMs,
    runningItemId: 'item-1',
  };
  const active = {
    startedAt: '2026-06-05T10:00:10.000Z',
    workerId: 'worker-1',
  };

  assert.equal(
    isStaleRunningItem({ ...base, runtime: runtimeSnapshot() }),
    true,
    'no active record',
  );
  assert.equal(
    isStaleRunningItem({ ...base, active, runtime: undefined }),
    true,
    'no runtime snapshot',
  );
  assert.equal(
    isStaleRunningItem({
      ...base,
      active,
      runtime: runtimeSnapshot({ workerId: 'worker-other' }),
    }),
    true,
    'worker mismatch',
  );
  assert.equal(
    isStaleRunningItem({
      ...base,
      active,
      runtime: runtimeSnapshot({ activeItemId: 'item-other' }),
    }),
    true,
    'item mismatch with zero grace',
  );
  assert.equal(
    isStaleRunningItem({
      ...base,
      active,
      activeItemMismatchGraceMs: 10_000,
      runtime: runtimeSnapshot({ activeItemId: 'item-other' }),
    }),
    false,
    'item mismatch within grace of a fresh claim',
  );
  assert.equal(
    isStaleRunningItem({
      ...base,
      active: { startedAt: '2026-06-05T09:59:00.000Z', workerId: 'worker-1' },
      activeItemMismatchGraceMs: 10_000,
      runtime: runtimeSnapshot({ activeItemId: 'item-other' }),
    }),
    true,
    'item mismatch past the grace window',
  );
  assert.equal(
    isStaleRunningItem({
      ...base,
      active,
      runtime: runtimeSnapshot({
        activeItemId: 'item-1',
        processId: process.pid,
      }),
    }),
    false,
    'live matching worker',
  );
  assert.equal(
    isStaleRunningItem({
      ...base,
      active,
      runtime: runtimeSnapshot({
        activeItemId: 'item-1',
        processId: deadPid(),
      }),
    }),
    true,
    'dead worker process',
  );

  const wedgedChild = runtimeSnapshot({
    activeItemId: 'item-1',
    processId: process.pid,
    providerChildExpected: true,
  });
  assert.equal(
    isStaleRunningItem({ ...base, active, runtime: wedgedChild }),
    true,
    'wedged provider child with the host-side check enabled',
  );
  assert.equal(
    isStaleRunningItem({
      ...base,
      active,
      includeProviderChildCheck: false,
      runtime: wedgedChild,
    }),
    false,
    'wedged provider child ignored on the API read side',
  );
});

test('api health derives synthetics for missing or stale snapshots', () => {
  const nowIso = '2026-06-05T10:00:00.000Z';

  const staleMissing = sampleApiHealth(undefined, { runningItemId: 'item-1' }, nowIso);
  assert.equal(staleMissing.health.state, 'unhealthy');
  assert.equal(staleMissing.health.reason, 'stale_running_item');

  const idleMissing = sampleApiHealth(undefined, {}, nowIso);
  assert.equal(idleMissing.health.state, 'unknown');
  assert.equal(idleMissing.health.reason, undefined);

  const healthySnapshot = {
    runtime: runtimeSnapshot({
      activeItemId: 'item-1',
      processId: process.pid,
    }),
    state: 'healthy' as const,
    updatedAt: '2026-06-05T09:59:59.000Z',
  };
  const passthrough = sampleApiHealth(
    healthySnapshot,
    {
      active: { startedAt: '2026-06-05T09:59:00.000Z', workerId: 'worker-1' },
      runningItemId: 'item-1',
    },
    nowIso,
  );
  assert.deepEqual(passthrough.health, healthySnapshot);

  const staleWorker = sampleApiHealth(
    healthySnapshot,
    {
      active: {
        startedAt: '2026-06-05T09:59:00.000Z',
        workerId: 'worker-other',
      },
      runningItemId: 'item-1',
    },
    nowIso,
  );
  assert.equal(staleWorker.health.state, 'unhealthy');
  assert.equal(staleWorker.health.reason, 'stale_running_item');
  assert.equal(staleWorker.health.runtime?.workerId, 'worker-1');

  const deadWorker = sampleApiHealth(
    {
      runtime: runtimeSnapshot({ processId: deadPid() }),
      state: 'healthy',
      updatedAt: '2026-06-05T09:59:59.000Z',
    },
    {},
    nowIso,
  );
  assert.equal(deadWorker.health.state, 'unhealthy');
  assert.equal(deadWorker.health.reason, 'start_failed');
});

test('agent health service applies carry rules through the persisted store', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agent-health-service-test-'));
  try {
    const store = new AgentHealthStore({ animaHome: stateDir });
    const service = new AgentHealthService(store);

    await service.writeProviderFailure({
      agentId: 'alpha',
      reason: 'provider_rate_limited',
      updatedAt: '2026-06-04T01:00:00.000Z',
    });
    await service.writeHealth({
      agentId: 'alpha',
      runtime: runtimeSnapshot({ workerId: 'worker-grace' }),
      state: 'healthy',
      updatedAt: '2026-06-04T01:00:30.000Z',
    });

    const carried = await store.get('alpha');
    assert.equal(carried?.state, 'degraded');
    assert.equal(carried?.reason, 'provider_rate_limited');
    assert.equal(carried?.runtime?.workerId, 'worker-grace');

    await service.writeHealth({
      agentId: 'alpha',
      clearProviderFailure: true,
      runtime: runtimeSnapshot({ workerId: 'worker-cleared' }),
      state: 'healthy',
      updatedAt: '2026-06-04T01:01:00.000Z',
    });

    const cleared = await service.get('alpha');
    assert.equal(cleared?.state, 'healthy');
    assert.equal(cleared?.reason, undefined);
    assert.equal(cleared?.runtime?.workerId, 'worker-cleared');
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('provider error clear only touches a provider_error snapshot', () => {
  const cleared = applyProviderErrorClear(
    {
      reason: 'provider_error',
      runtime: runtimeSnapshot({ workerId: 'worker-rotated' }),
      state: 'degraded',
      updatedAt: '2026-06-04T02:00:00.000Z',
    },
    '2026-06-04T02:00:30.000Z',
  );
  assert.equal(cleared?.state, 'healthy');
  assert.equal(cleared?.reason, undefined);
  assert.equal(cleared?.runtime?.workerId, 'worker-rotated');
  assert.equal(cleared?.updatedAt, '2026-06-04T02:00:30.000Z');

  const withoutRuntime = applyProviderErrorClear(
    {
      reason: 'provider_error',
      state: 'degraded',
      updatedAt: '2026-06-04T02:00:00.000Z',
    },
    '2026-06-04T02:00:30.000Z',
  );
  assert.equal(withoutRuntime?.state, 'unknown');
  assert.equal(withoutRuntime?.reason, undefined);

  for (const reason of [
    'provider_rate_limited',
    'provider_auth_failed',
    'provider_quota_exhausted',
  ] as const) {
    const kept = applyProviderErrorClear(
      { reason, state: 'degraded', updatedAt: '2026-06-04T02:00:00.000Z' },
      '2026-06-04T02:00:30.000Z',
    );
    assert.equal(kept, undefined, `${reason} must survive a provider_error clear`);
  }
  assert.equal(applyProviderErrorClear(undefined, '2026-06-04T02:00:30.000Z'), undefined);
});

test('agent health service clears provider_error inside the store lock and keeps other failures', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agent-health-clear-test-'));
  try {
    const store = new AgentHealthStore({ animaHome: stateDir });
    const service = new AgentHealthService(store);

    await service.clearProviderError({
      agentId: 'alpha',
      updatedAt: '2026-06-04T03:00:00.000Z',
    });
    assert.equal(await store.get('alpha'), undefined);

    await service.writeProviderFailure({
      agentId: 'alpha',
      reason: 'provider_error',
      runtime: runtimeSnapshot({ workerId: 'worker-poisoned' }),
      updatedAt: '2026-06-04T03:00:10.000Z',
    });
    await service.clearProviderError({
      agentId: 'alpha',
      updatedAt: '2026-06-04T03:00:20.000Z',
    });
    const cleared = await store.get('alpha');
    assert.equal(cleared?.state, 'healthy');
    assert.equal(cleared?.reason, undefined);
    assert.equal(cleared?.runtime?.workerId, 'worker-poisoned');

    // A failure that lands between the rotate decision and the write must win:
    // the reason check runs inside the locked update, so it sees this write.
    await service.writeProviderFailure({
      agentId: 'alpha',
      reason: 'provider_rate_limited',
      updatedAt: '2026-06-04T03:00:30.000Z',
    });
    await service.clearProviderError({
      agentId: 'alpha',
      updatedAt: '2026-06-04T03:00:40.000Z',
    });
    const rateLimited = await store.get('alpha');
    assert.equal(rateLimited?.reason, 'provider_rate_limited');
    assert.equal(rateLimited?.updatedAt, '2026-06-04T03:00:30.000Z');

    await service.writeProviderFailure({
      agentId: 'alpha',
      reason: 'provider_auth_failed',
      updatedAt: '2026-06-04T03:00:50.000Z',
    });
    await service.clearProviderError({
      agentId: 'alpha',
      updatedAt: '2026-06-04T03:01:00.000Z',
    });
    const authFailed = await store.get('alpha');
    assert.equal(authFailed?.reason, 'provider_auth_failed');
    assert.equal(authFailed?.updatedAt, '2026-06-04T03:00:50.000Z');
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('background list and terminal evidence survive the health store independently of the count', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-background-health-'));
  try {
    const at = '2026-10-06T00:00:00.000Z';
    const work = {
      state: 'background' as const,
      backgroundTaskCount: 2,
      backgroundEvidence: {
        snapshotReceivedAt: at,
        listedTaskIds: ['one', 'two'],
        ambientTaskIds: [],
        listedTaskIdsTruncated: false,
        terminalNotifications: [{ taskId: 'one', status: 'completed' as const, receivedAt: at }],
      },
    };
    const store = new AgentHealthStore({ animaHome: stateDir });
    await store.update('alpha', () => ({
      state: 'healthy',
      updatedAt: at,
      runtime: runtimeSnapshot({ providerWork: work }),
    }));
    const reloaded = new AgentHealthStore({ animaHome: stateDir });
    assert.deepEqual((await reloaded.get('alpha'))?.runtime?.providerWork, work);
    const notifications = [{ taskId: 'early-task', status: 'completed' as const, receivedAt: at }];
    for (const evidence of [
      { terminalNotifications: notifications },
      {
        snapshotReceivedAt: at,
        listedTaskIds: [],
        ambientTaskIds: [],
        listedTaskIdsTruncated: false,
        terminalNotifications: notifications,
      },
    ]) {
      const terminalWork = {
        state: 'working' as const,
        backgroundTaskCount: 1,
        backgroundHookIds: ['keep-working'],
        backgroundHookIdsTruncated: false,
        backgroundEvidence: evidence,
      };
      await store.update('alpha', () => ({
        state: 'healthy',
        updatedAt: at,
        runtime: runtimeSnapshot({ providerWork: terminalWork }),
      }));
      const readback = new AgentHealthStore({ animaHome: stateDir });
      assert.deepEqual((await readback.get('alpha'))?.runtime?.providerWork, terminalWork);
    }
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const transition of ['complete', 'next-item', 'none', 'worker-mismatch'] as const) {
  test(`runtime status confirms queue/health sampling across ${transition}`, async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-health-read-race-'));
    t.after(() => rm(stateDir, { force: true, recursive: true }));
    await writeAgentConfigs(stateDir, [defaultAgentConfig('milo')]);
    await withAnimaHome(stateDir, async () => {
      const queue = new WakeQueueService('milo');
      const health = new AgentHealthService(new AgentHealthStore({ animaHome: stateDir }));
      const first = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-demo',
          teamId: 'T-demo',
          text: 'Synthetic first item',
          ts: '1770000000.000012',
          userId: 'U1',
        }),
        { agentId: 'milo', stateDir },
      );
      await queue.takeNextRunnable({
        isWorkerAlive: () => true,
        workerId: 'worker-live',
      });
      await setActiveRuntimeItem({
        agentId: 'milo',
        itemId: first.item.id,
        workerId: 'worker-live',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      const publish = (activeItemId?: string) =>
        health.writeHealth({
          agentId: 'milo',
          state: 'healthy',
          updatedAt: new Date().toISOString(),
          runtime: {
            ...(activeItemId ? { activeItemId } : {}),
            processId: process.pid,
            providerChildExpected: false,
            workerId: transition === 'worker-mismatch' ? 'worker-other' : 'worker-live',
          },
        });
      await publish(first.item.id);
      const originalGet = health.get.bind(health);
      let reads = 0;
      let expectedItemId: string | undefined = first.item.id;
      t.mock.method(health, 'get', async (agentId: string) => {
        if (++reads === 1 && (transition === 'complete' || transition === 'next-item')) {
          await queue.complete(first.item.id);
          expectedItemId = undefined;
          if (transition === 'next-item') {
            const next = await ingestEvent(
              makeSlackEvent({
                channelId: 'C-demo',
                teamId: 'T-demo',
                text: 'Synthetic next item',
                ts: '1770000000.000013',
                userId: 'U1',
              }),
              { agentId: 'milo', stateDir },
            );
            await queue.takeNextRunnable({
              isWorkerAlive: () => true,
              workerId: 'worker-live',
            });
            expectedItemId = next.item.id;
          }
          await publish(expectedItemId);
        }
        return originalGet(agentId);
      });
      const status = await new RuntimeService(health).getStatus('milo');
      assert.equal(status.currentItemId, expectedItemId);
      assert.equal(status.itemCount, (await queue.list()).length);
      assert.equal(
        status.health?.state,
        transition === 'worker-mismatch' ? 'unhealthy' : 'healthy',
      );
      assert.equal(
        status.health?.reason,
        transition === 'worker-mismatch' ? 'stale_running_item' : undefined,
      );
      assert.equal(reads, transition === 'none' ? 1 : 2);
      const history = await new AgentHealthEvidenceStore('milo').list();
      assert.equal(history.length, transition === 'worker-mismatch' ? 1 : 0);
      if (history[0]) {
        assert.equal(history[0].queue.runningItemId, first.item.id);
        assert.equal(history[0].mismatch, 'worker_mismatch');
        assert.equal(history[0].runtime.processAlive, true);
      }
    });
  });
}

test('confirmed stale evidence survives recovery, omits payloads, and is included in Copy diagnostics', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'anima-health-evidence-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await withAnimaHome(home, async () => {
    const queue = new WakeQueueService('scout');
    const health = new AgentHealthService(new AgentHealthStore({ animaHome: home }));
    const runtime = new RuntimeService(health);
    const item = (
      await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          userId: 'U1',
          text: 'PRIVATE_QUEUE_SENTINEL',
          ts: '1770000000.000020',
        }),
        { agentId: 'scout', stateDir: home },
      )
    ).item;
    await queue.takeNextRunnable({
      isWorkerAlive: () => true,
      workerId: 'worker-queue',
    });
    await health.writeHealth({
      agentId: 'scout',
      state: 'healthy',
      updatedAt: new Date().toISOString(),
      runtime: {
        workerId: 'worker-snapshot',
        activeItemId: 'another-item',
        processId: process.pid,
        providerChildExpected: true,
        providerChild: {
          command: 'PRIVATE_COMMAND_SENTINEL',
          label: 'PRIVATE_LABEL_SENTINEL',
          alive: true,
          exited: false,
          pid: process.pid,
          stdinWritable: true,
          startedAt: new Date().toISOString(),
        },
      },
    });
    assert.equal((await runtime.getStatus('scout')).health?.reason, 'stale_running_item');
    const path = join(home, 'agents/scout/health-evidence.json');
    const before = await stat(path);
    const first = (await new AgentHealthEvidenceStore('scout').list())[0]!;
    assert.equal(first.queue.runningItemId, item.id);
    assert.equal(first.queue.workerId, 'worker-queue');
    assert.equal(first.runtime.workerId, 'worker-snapshot');
    assert.equal(first.runtime.processAlive, true);
    assert.equal(first.runtime.providerChild.processAlive, true);
    assert.equal(first.grace.milliseconds, 10_000);
    assert.equal(first.grace.active, true);
    assert.equal(before.mode & 0o777, 0o600);
    const locks: string[] = [];
    const update = JsonFile.prototype.update;
    t.mock.method(
      JsonFile.prototype,
      'update',
      function (this: JsonFile<unknown>, ...args: Parameters<typeof update>) {
        if (this.path === path) locks.push(this.path);
        return update.apply(this, args);
      },
    );
    await Promise.all(
      Array.from({ length: 8 }, () => new RuntimeService(health).getStatus('scout')),
    );
    assert.equal(locks.length, 0, 'duplicate observations must not acquire the evidence file lock');
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    await queue.complete(item.id);
    await health.writeHealth({
      agentId: 'scout',
      state: 'healthy',
      updatedAt: new Date().toISOString(),
      runtime: {
        workerId: 'worker-snapshot',
        processId: process.pid,
        providerChildExpected: false,
      },
    });
    assert.equal((await runtime.getStatus('scout')).health?.state, 'healthy');
    const bundle = await buildAgentDiagnostics('scout');
    assert.equal(bundle.healthEvidence?.available, true);
    assert.deepEqual(bundle.healthEvidence?.events, [first]);
    assert.equal(bundle.healthEvidence?.cappedAt, 20);
    assert.doesNotMatch(await readFile(path, 'utf8'), /PRIVATE_|runtime-secret-value|xoxb-/);
    assert.doesNotMatch(JSON.stringify(bundle.healthEvidence), /PRIVATE_/);
  });
});

function syntheticEvidence(item = 'item-1'): StaleRunningEvidence {
  return {
    observedAt: '2026-10-23T00:00:00.000Z',
    mismatch: 'snapshot_missing',
    queue: { runningItemId: item, activePresent: true, workerId: 'worker-1' },
    runtime: { present: false, providerChild: { present: false } },
    grace: { active: false, milliseconds: 10_000 },
  };
}

test('evidence store bounds history, deduplicates across writers, and retains a new occurrence after recovery', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'anima-health-history-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new AgentHealthEvidenceStore('scout', home);
  await store.observe(undefined);
  const path = join(home, 'agents/scout/health-evidence.json');
  await assert.rejects(stat(path), { code: 'ENOENT' });
  const input = {
    ...syntheticEvidence(),
    secret: 'PRIVATE_EXTRA_SENTINEL',
    runtime: {
      ...syntheticEvidence().runtime,
      command: 'PRIVATE_COMMAND_SENTINEL',
    },
  };
  await Promise.all(
    Array.from({ length: 6 }, () => new AgentHealthEvidenceStore('scout', home).observe(input)),
  );
  assert.equal((await store.list()).length, 1);
  assert.doesNotMatch(await readFile(path, 'utf8'), /PRIVATE_/);
  await store.observe(undefined);
  await store.observe({ ...input, observedAt: '2026-10-23T00:01:00.000Z' });
  assert.equal((await store.list()).length, 2);
  for (let i = 0; i < HEALTH_EVIDENCE_CAP + 5; i++)
    await store.observe(syntheticEvidence(`next-${i}`));
  const history = await new AgentHealthEvidenceStore('scout', home).list();
  assert.equal(history.length, 20);
  assert.equal(history[0]?.queue.runningItemId, 'next-5');
  assert.equal(history.at(-1)?.queue.runningItemId, 'next-24');
});

test('unwritable evidence does not hide unhealthy status and diagnostics marks history unavailable', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'anima-health-evidence-error-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  await withAnimaHome(home, async () => {
    await ingestEvent(
      makeSlackEvent({
        channelId: 'D-demo',
        teamId: 'T-demo',
        userId: 'U1',
        text: 'Synthetic work',
        ts: '1770000000.000021',
      }),
      { agentId: 'scout', stateDir: home },
    );
    await new WakeQueueService('scout').takeNextRunnable({
      isWorkerAlive: () => true,
      workerId: 'worker-live',
    });
    await mkdir(join(home, 'agents/scout/health-evidence.json'));
    const warnings: unknown[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
    const runtime = new RuntimeService();
    for (let i = 0; i < 3; i++)
      assert.equal((await runtime.getStatus('scout')).health?.reason, 'stale_running_item');
    assert.equal(warnings.length, 1);
    const bundle = await buildAgentDiagnostics('scout');
    assert.equal(bundle.healthEvidence?.available, false);
    assert.equal(bundle.status.health?.reason, 'stale_running_item');
  });
});

test('health evidence captures the failed invariant and actual liveness at the grace boundary', () => {
  const now = '2026-10-23T00:00:10.000Z';
  const active = {
    workerId: 'worker-1',
    startedAt: '2026-10-23T00:00:00.000Z',
  };
  const snapshot = {
    state: 'healthy' as const,
    updatedAt: now,
    runtime: runtimeSnapshot({
      activeItemId: 'other',
      processId: process.pid,
    }),
  };
  assert.equal(
    sampleApiHealth(snapshot, { runningItemId: 'item-1', active }, '2026-10-23T00:00:09.999Z')
      .evidence,
    undefined,
  );
  const boundary = sampleApiHealth(snapshot, { runningItemId: 'item-1', active }, now).evidence!;
  assert.equal(boundary.mismatch, 'item_mismatch');
  assert.equal(boundary.grace.active, false);
  assert.equal(boundary.runtime.processAlive, true);
  const dead = deadPid();
  const failed = sampleApiHealth(
    {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        activeItemId: 'item-1',
        processId: dead,
        providerChild: {
          pid: dead,
          command: 'PRIVATE_COMMAND',
          label: 'cli',
          alive: true,
          exited: false,
          stdinWritable: true,
          startedAt: now,
        },
      },
    },
    { runningItemId: 'item-1', active },
    now,
  ).evidence!;
  assert.equal(failed.mismatch, 'worker_dead');
  assert.equal(failed.runtime.processAlive, false);
  assert.equal(
    failed.runtime.providerChild.alive,
    true,
    'reported and observed liveness are separate',
  );
  assert.equal(failed.runtime.providerChild.processAlive, false);
  assert.equal(
    sampleApiHealth(undefined, { runningItemId: 'item-1', active }, now).evidence?.mismatch,
    'snapshot_missing',
  );
  assert.equal(
    sampleApiHealth(snapshot, { runningItemId: 'item-1' }, now).evidence?.mismatch,
    'active_missing',
  );
});
