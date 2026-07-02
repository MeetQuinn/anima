import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentHealthService,
  applyHealthWrite,
  applyProviderFailure,
  deriveApiHealth,
  isStaleRunningItem,
  runtimeHandleHealth,
  startingTimeoutHealth,
} from '../runtime/agent-health.service.js';
import { AgentHealthStore } from '../runtime/agent-health.store.js';
import type { AgentRuntimeHandleSnapshot } from '../../shared/snapshot.js';

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
    { reason: 'restart_failed', restart: failedRestart, state: 'unhealthy', updatedAt: '2026-06-03T19:30:00.000Z' },
    { state: 'starting', updatedAt: '2026-06-03T19:30:30.000Z' },
  );
  assert.equal(carried.restart?.requestId, 'restart-1');

  const healthy = applyHealthWrite(
    { reason: 'restart_failed', restart: failedRestart, state: 'unhealthy', updatedAt: '2026-06-03T19:30:00.000Z' },
    { runtime: runtimeSnapshot(), state: 'healthy', updatedAt: '2026-06-03T19:31:00.000Z' },
  );
  assert.equal(healthy.state, 'healthy');
  assert.equal(healthy.restart, undefined);

  const recoveredRestart = { ...failedRestart, outcome: 'recovered' as const };
  const keptRecovered = applyHealthWrite(
    { restart: recoveredRestart, state: 'healthy', updatedAt: '2026-06-03T19:32:00.000Z' },
    { runtime: runtimeSnapshot(), state: 'healthy', updatedAt: '2026-06-03T19:33:00.000Z' },
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
    { reason: 'provider_child_missing', state: 'degraded', updatedAt: '2026-06-05T10:00:00.000Z' },
    '2026-06-05T10:00:05.000Z',
  );
  assert.deepEqual(withinDebounce, {
    reason: 'provider_child_missing',
    state: 'degraded',
    updatedAt: '2026-06-05T10:00:00.000Z',
  });

  const escalated = runtimeHandleHealth(
    missing,
    { reason: 'provider_child_missing', state: 'degraded', updatedAt: '2026-06-05T10:00:00.000Z' },
    '2026-06-05T10:00:11.000Z',
  );
  assert.deepEqual(escalated, {
    reason: 'provider_child_missing',
    state: 'unhealthy',
    updatedAt: '2026-06-05T10:00:11.000Z',
  });

  const alreadyUnhealthy = runtimeHandleHealth(
    missing,
    { reason: 'provider_child_missing', state: 'unhealthy', updatedAt: '2026-06-05T10:00:11.000Z' },
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
    { runtime: runtimeSnapshot(), state: 'starting', updatedAt: '2026-06-05T10:00:00.000Z' },
    '2026-06-05T10:00:31.000Z',
  );
  assert.equal(timedOut?.state, 'unhealthy');
  assert.equal(timedOut?.reason, 'start_failed');
  assert.equal(timedOut?.runtime?.workerId, 'worker-1');
  assert.equal(timedOut?.updatedAt, '2026-06-05T10:00:31.000Z');

  const restartTimedOut = startingTimeoutHealth(
    {
      restart: { outcome: 'pending', requestId: 'restart-1', requestedAt: '2026-06-05T10:00:00.000Z' },
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
  const active = { startedAt: '2026-06-05T10:00:10.000Z', workerId: 'worker-1' };

  assert.equal(isStaleRunningItem({ ...base, runtime: runtimeSnapshot() }), true, 'no active record');
  assert.equal(isStaleRunningItem({ ...base, active, runtime: undefined }), true, 'no runtime snapshot');
  assert.equal(
    isStaleRunningItem({ ...base, active, runtime: runtimeSnapshot({ workerId: 'worker-other' }) }),
    true,
    'worker mismatch',
  );
  assert.equal(
    isStaleRunningItem({ ...base, active, runtime: runtimeSnapshot({ activeItemId: 'item-other' }) }),
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
      runtime: runtimeSnapshot({ activeItemId: 'item-1', processId: process.pid }),
    }),
    false,
    'live matching worker',
  );
  assert.equal(
    isStaleRunningItem({
      ...base,
      active,
      runtime: runtimeSnapshot({ activeItemId: 'item-1', processId: deadPid() }),
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
    isStaleRunningItem({ ...base, active, includeProviderChildCheck: false, runtime: wedgedChild }),
    false,
    'wedged provider child ignored on the API read side',
  );
});

test('api health derives synthetics for missing or stale snapshots', () => {
  const nowIso = '2026-06-05T10:00:00.000Z';

  const staleMissing = deriveApiHealth(undefined, { runningItemId: 'item-1' }, nowIso);
  assert.equal(staleMissing.state, 'unhealthy');
  assert.equal(staleMissing.reason, 'stale_running_item');

  const idleMissing = deriveApiHealth(undefined, {}, nowIso);
  assert.equal(idleMissing.state, 'unknown');
  assert.equal(idleMissing.reason, undefined);

  const healthySnapshot = {
    runtime: runtimeSnapshot({ activeItemId: 'item-1', processId: process.pid }),
    state: 'healthy' as const,
    updatedAt: '2026-06-05T09:59:59.000Z',
  };
  const passthrough = deriveApiHealth(
    healthySnapshot,
    { active: { startedAt: '2026-06-05T09:59:00.000Z', workerId: 'worker-1' }, runningItemId: 'item-1' },
    nowIso,
  );
  assert.deepEqual(passthrough, healthySnapshot);

  const staleWorker = deriveApiHealth(
    healthySnapshot,
    { active: { startedAt: '2026-06-05T09:59:00.000Z', workerId: 'worker-other' }, runningItemId: 'item-1' },
    nowIso,
  );
  assert.equal(staleWorker.state, 'unhealthy');
  assert.equal(staleWorker.reason, 'stale_running_item');
  assert.equal(staleWorker.runtime?.workerId, 'worker-1');

  const deadWorker = deriveApiHealth(
    {
      runtime: runtimeSnapshot({ processId: deadPid() }),
      state: 'healthy',
      updatedAt: '2026-06-05T09:59:59.000Z',
    },
    {},
    nowIso,
  );
  assert.equal(deadWorker.state, 'unhealthy');
  assert.equal(deadWorker.reason, 'start_failed');
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
