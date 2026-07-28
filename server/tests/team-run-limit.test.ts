import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentRuntime,
  AgentRuntimeFollowupInput,
  AgentRuntimeInput,
  AgentRuntimeResult,
} from '../providers/contract.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { TEAM_ACTIVE_RUN_LIMIT, TeamRunLimiter } from '../runtime/team-run-limiter.js';
import { makeSlackEvent } from './helpers/slack.js';
import { sleep, waitFor, withTempAnimaHome } from './helpers/harness.js';
import {
  ControlledRuntime,
  FollowupRuntime,
  enqueueInbox,
  queueFor,
  silentLogger,
  waitForInboxItemAppendedTo,
} from './helpers/runtime-worker.js';

test('team run limit is five active provider runs', () => {
  assert.equal(TEAM_ACTIVE_RUN_LIMIT, 5);
});

test('team run limiter admits waiters in request order', async () => {
  const limiter = new TeamRunLimiter(2);
  const firstRelease = await limiter.acquire();
  const secondRelease = await limiter.acquire();
  const admitted: string[] = [];

  const third = limiter.acquire().then((release) => {
    admitted.push('third');
    return release;
  });
  const fourth = limiter.acquire().then((release) => {
    admitted.push('fourth');
    return release;
  });

  await sleep(10);
  assert.deepEqual(admitted, []);

  firstRelease();
  const thirdRelease = await third;
  assert.deepEqual(admitted, ['third']);

  secondRelease();
  const fourthRelease = await fourth;
  assert.deepEqual(admitted, ['third', 'fourth']);

  thirdRelease();
  fourthRelease();
});

test('runtime workers keep a sixth provider run queued and release a slot after failure', async () => {
  await withTempAnimaHome(async (stateDir) => {
    const limiter = new TeamRunLimiter();
    const runtimes: AgentRuntime[] = [
      ...Array.from({ length: TEAM_ACTIVE_RUN_LIMIT - 1 }, () => new ControlledRuntime()),
      new DeferredFailureRuntime(),
      new ControlledRuntime(),
    ];
    const workers: AgentRuntimeWorker[] = [];
    const itemIds: string[] = [];
    const drains: Promise<number>[] = [];

    try {
      for (const [index, runtime] of runtimes.entries()) {
        const agentId = `limit-agent-${index}`;
        const decision = await enqueueInbox(
          makeSlackEvent({
            channelId: `D-${index}`,
            eventId: `evt-team-limit-${index}`,
            teamId: 'T-demo',
            text: `work ${index}`,
            ts: `17700000${index}.000001`,
            userId: 'U1',
          }),
          { agentId, stateDir },
        );
        itemIds.push(decision.ctx.item.id);
        workers.push(new AgentRuntimeWorker({
          agentId,
          agentRuntime: runtime,
          pollIntervalMs: 10_000,
          queue: queueFor(agentId),
          stateDir,
          workerId: `worker-${index}`,
        }, silentLogger, limiter));
      }

      for (let index = 0; index < TEAM_ACTIVE_RUN_LIMIT; index += 1) {
        drains.push(workers[index]!.drainOnce());
        await waitFor(() => runtimeCalls(runtimes[index]!) === 1, {
          description: `provider run ${index} to start`,
        });
      }

      drains.push(workers[TEAM_ACTIVE_RUN_LIMIT]!.drainOnce());
      await sleep(50);
      assert.equal(runtimeCalls(runtimes[TEAM_ACTIVE_RUN_LIMIT]!), 0);
      assert.equal(
        (await queueFor(`limit-agent-${TEAM_ACTIVE_RUN_LIMIT}`).find(itemIds[TEAM_ACTIVE_RUN_LIMIT]!))
          ?.handling.status,
        'queued',
      );
      for (let index = 0; index < TEAM_ACTIVE_RUN_LIMIT; index += 1) {
        assert.equal(
          (await queueFor(`limit-agent-${index}`).find(itemIds[index]!))?.handling.status,
          'running',
        );
      }

      (runtimes[TEAM_ACTIVE_RUN_LIMIT - 1] as DeferredFailureRuntime).fail();
      await waitFor(() => runtimeCalls(runtimes[TEAM_ACTIVE_RUN_LIMIT]!) === 1, {
        description: 'sixth provider run to start after failure',
      });

      for (let index = 0; index < TEAM_ACTIVE_RUN_LIMIT - 1; index += 1) {
        (runtimes[index] as ControlledRuntime).finishNext();
      }
      (runtimes[TEAM_ACTIVE_RUN_LIMIT] as ControlledRuntime).finishNext();
      await Promise.all(drains);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });
});

test('an active run appends follow-ups without consuming another team slot', async () => {
  await withTempAnimaHome(async (stateDir) => {
    const limiter = new TeamRunLimiter();
    const runtimes = [
      new FollowupRuntime(),
      ...Array.from({ length: TEAM_ACTIVE_RUN_LIMIT }, () => new ControlledRuntime()),
    ];
    const workers: AgentRuntimeWorker[] = [];
    const drains: Promise<number>[] = [];

    try {
      for (const [index, runtime] of runtimes.entries()) {
        const agentId = `followup-limit-agent-${index}`;
        await enqueueInbox(
          makeSlackEvent({
            channelId: `D-${index}`,
            eventId: `evt-followup-limit-${index}`,
            teamId: 'T-demo',
            text: `primary ${index}`,
            ts: `17700001${index}.000001`,
            userId: 'U1',
          }),
          { agentId, stateDir },
        );
        workers.push(new AgentRuntimeWorker({
          agentId,
          agentRuntime: runtime,
          pollIntervalMs: 10_000,
          queue: queueFor(agentId),
          stateDir,
          workerId: `followup-worker-${index}`,
        }, silentLogger, limiter));
      }

      for (let index = 0; index < TEAM_ACTIVE_RUN_LIMIT; index += 1) {
        drains.push(workers[index]!.drainOnce());
        await waitFor(() => runtimes[index]!.calls.length === 1, {
          description: `provider run ${index} to start`,
        });
      }
      drains.push(workers[TEAM_ACTIVE_RUN_LIMIT]!.drainOnce());

      const followup = await enqueueInbox(
        makeSlackEvent({
          channelId: 'C-followup',
          eventId: 'evt-followup-with-full-team',
          teamId: 'T-demo',
          text: 'append while all slots are occupied',
          threadTs: '1770000100.000001',
          ts: '1770000101.000001',
          userId: 'U2',
        }),
        { agentId: 'followup-limit-agent-0', stateDir },
      );
      await waitForInboxItemAppendedTo(
        'followup-limit-agent-0',
        followup.ctx.item.id,
        runtimes[0]!.calls[0]!.itemId,
      );
      assert.equal((runtimes[0] as FollowupRuntime).followups.length, 1);
      assert.equal(runtimes[TEAM_ACTIVE_RUN_LIMIT]!.calls.length, 0);

      runtimes[1]!.finishNext();
      await waitFor(() => runtimes[TEAM_ACTIVE_RUN_LIMIT]!.calls.length === 1, {
        description: 'waiting provider run to start after a slot releases',
      });

      runtimes[0]!.finishNext();
      for (let index = 2; index <= TEAM_ACTIVE_RUN_LIMIT; index += 1) {
        runtimes[index]!.finishNext();
      }
      await Promise.all(drains);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });
});

class DeferredFailureRuntime implements AgentRuntime {
  readonly kind = 'deferred-failure';
  readonly calls: AgentRuntimeInput[] = [];
  private rejectRun?: (error: unknown) => void;

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    return new Promise((_resolve, reject) => {
      this.rejectRun = reject;
    });
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }

  async close(): Promise<void> {
    this.rejectRun?.(new Error('closed'));
    this.rejectRun = undefined;
  }

  fail(): void {
    assert.ok(this.rejectRun, 'Expected an active provider run');
    this.rejectRun(new Error('controlled provider failure'));
    this.rejectRun = undefined;
  }
}

function runtimeCalls(runtime: AgentRuntime): number {
  return 'calls' in runtime && Array.isArray(runtime.calls) ? runtime.calls.length : 0;
}
