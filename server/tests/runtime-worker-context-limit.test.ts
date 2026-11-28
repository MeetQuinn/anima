import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';
import { allActivities, loadState } from './helpers/state.js';
import { enqueueInbox, queueFor, silentLogger } from './helpers/runtime-worker.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { runtimeSessionServiceForAgent } from '../runtime/runtime-session.service.js';
import type { Activity } from '../../shared/activity.js';
import type {
  AgentRuntime,
  AgentRuntimeFollowupInput,
  AgentRuntimeInput,
  AgentRuntimeResult,
} from '../providers/contract.js';

const MODEL_WINDOW = 1_048_576;

/** Records which provider session each item runs on, and says whether it is still busy. */
class SessionRecordingRuntime implements AgentRuntime {
  readonly sessions: Array<string | undefined> = [];
  quiescent = true;

  constructor(readonly kind: string, readonly env: Record<string, string>) {}

  isProviderQuiescent(): boolean {
    return this.quiescent;
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.sessions.push(input.providerSession?.id);
    return { text: 'ok' };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

async function withWorker(
  runtime: SessionRecordingRuntime,
  body: (worker: AgentRuntimeWorker, stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-worker-context-limit-'));
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
      await body(worker, stateDir);
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
}

let eventCount = 0;

async function enqueue(stateDir: string) {
  eventCount += 1;
  return enqueueInbox(makeSlackEvent({
    channelId: 'D-user',
    eventId: `evt-context-limit-${eventCount}`,
    teamId: 'T-demo',
    text: 'next message',
    ts: `1770000020.${String(eventCount).padStart(6, '0')}`,
    userId: 'U1',
  }), { agentId: 'scout', stateDir });
}

/** The agent's session is `agy-full`, and its last turn left this much context. */
async function lastTurnLeft(runtime: SessionRecordingRuntime, currentContextTokens: number): Promise<void> {
  const sessions = runtimeSessionServiceForAgent('scout');
  await sessions.persistProviderSession(runtime.kind, { id: 'agy-full', updatedAt: '2026-11-28T00:00:00.000Z' });
  const stats = {
    activityId: `actv_context_${currentContextTokens}`,
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    payload: {
      contextWindow: MODEL_WINDOW,
      currentContextTokens,
      eventType: 'antigravity.context.stats',
      runtimeKind: runtime.kind,
    },
    type: 'runtime.event',
  } as Activity;
  await sessions.updateRuntimeStats(runtime.kind, runtime.env, stats);
}

function rotations(activities: Activity[]): Activity[] {
  return activities.filter((activity) => activity.type === 'anima.session.rotate');
}

for (const scenario of [
  { name: 'at the default 240K', limitEnv: '240000', used: 240_000, limit: 240_000 },
  { name: 'past a K shorthand the agent sets', limitEnv: '100K', used: 433_052, limit: 100_000 },
  { name: 'past a percentage of the model window', limitEnv: '25%', used: 300_000, limit: 262_144 },
]) {
  test(`runtime worker starts a new agy session for the next item once the last turn's context is ${scenario.name}`, async () => {
    const runtime = new SessionRecordingRuntime('antigravity-cli', { AGY_CLI_AUTO_COMPACT_OVERRIDE: scenario.limitEnv });
    await withWorker(runtime, async (worker, stateDir) => {
      const decision = await enqueue(stateDir);
      await lastTurnLeft(runtime, scenario.used);
      const before = await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
      assert.equal(before.latestProviderStats?.autoCompactWindow, scenario.limit, 'the gauge measures against the limit');

      assert.equal(await worker.drainOnce(), 1);
      assert.deepEqual(runtime.sessions, [undefined], 'the item runs on a new session');

      const session = await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
      assert.equal(session.current, undefined);
      assert.equal(session.latestProviderStats, undefined, 'the gauge starts over with the new session');
      assert.equal(session.archived?.length, 1);
      assert.equal(session.archived?.[0]?.id, 'agy-full');
      assert.equal(session.archived?.[0]?.archivedBy, 'recovery');
      assert.equal(session.archived?.[0]?.note, `Context reached ${scenario.used} of ${scenario.limit} tokens`);

      const [rotation, ...more] = rotations(allActivities(await loadState()));
      assert.equal(more.length, 0);
      assert.deepEqual(
        {
          automatic: rotation?.payload?.['automatic'],
          contextLimit: rotation?.payload?.['contextLimit'],
          currentContextTokens: rotation?.payload?.['currentContextTokens'],
          itemId: rotation?.payload?.['itemId'],
          reason: rotation?.payload?.['reason'],
        },
        {
          automatic: true,
          contextLimit: scenario.limit,
          currentContextTokens: scenario.used,
          itemId: decision.ctx.item.id,
          reason: 'context_limit',
        },
      );
    });
  });
}

for (const scenario of [
  { name: 'below the limit', kind: 'antigravity-cli', limitEnv: '240000', used: 239_999 },
  { name: 'when the agent sets 0 (no limit)', kind: 'antigravity-cli', limitEnv: '0', used: 900_000 },
  { name: 'when the agent sets an unreadable limit', kind: 'antigravity-cli', limitEnv: 'lots', used: 900_000 },
  { name: 'for a provider that compacts by itself', kind: 'claude-code', limitEnv: '240000', used: 900_000 },
]) {
  test(`runtime worker keeps the session ${scenario.name}`, async () => {
    const runtime = new SessionRecordingRuntime(scenario.kind, { AGY_CLI_AUTO_COMPACT_OVERRIDE: scenario.limitEnv });
    await withWorker(runtime, async (worker, stateDir) => {
      await enqueue(stateDir);
      await lastTurnLeft(runtime, scenario.used);

      assert.equal(await worker.drainOnce(), 1);
      assert.deepEqual(runtime.sessions, ['agy-full']);
      const session = await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
      assert.equal(session.archived, undefined);
      assert.equal(rotations(allActivities(await loadState())).length, 0);
    });
  });
}

test('runtime worker leaves a full agy session to work agy is still doing, then starts a new one', async () => {
  const runtime = new SessionRecordingRuntime('antigravity-cli', { AGY_CLI_AUTO_COMPACT_OVERRIDE: '240000' });
  await withWorker(runtime, async (worker, stateDir) => {
    await enqueue(stateDir);
    await lastTurnLeft(runtime, 300_000);
    runtime.quiescent = false;
    assert.equal(await worker.drainOnce(), 1);

    runtime.quiescent = true;
    await enqueue(stateDir);
    assert.equal(await worker.drainOnce(), 1);
    assert.deepEqual(runtime.sessions, ['agy-full', undefined]);
    assert.equal(rotations(allActivities(await loadState())).length, 1);
  });
});

test('runtime worker keeps a full agy session for an item it resumes after a restart', async () => {
  const runtime = new SessionRecordingRuntime('antigravity-cli', { AGY_CLI_AUTO_COMPACT_OVERRIDE: '240000' });
  await withWorker(runtime, async (worker, stateDir) => {
    const decision = await enqueue(stateDir);
    await lastTurnLeft(runtime, 300_000);
    const queue = queueFor('scout');
    const claimed = await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'worker-before-restart' });
    assert.equal(claimed?.id, decision.ctx.item.id);
    await queue.requeue(decision.ctx.item.id, { resumeReason: 'runtime_restart' });

    assert.equal(await worker.drainOnce(), 1);
    assert.deepEqual(runtime.sessions, ['agy-full']);
    assert.equal(rotations(allActivities(await loadState())).length, 0);
  });
});
