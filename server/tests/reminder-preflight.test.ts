import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ReminderInboxSubscriber,
  setPreflightAfterRecheckHookForTests,
} from '../inbox/reminder-subscriber.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import {
  PREFLIGHT_MAX_TIMEOUT_MS,
  REMINDER_BODY_MAX_CHARS,
  normalizePreflightTimeoutMs,
  preflightEvidenceForWake,
  resetPreflightConcurrencyForTests,
  runPreflightCommand,
  tryBeginPreflight,
  endPreflight,
  validatePreflightCommand,
} from '../reminders/preflight.js';
import { reminderServiceForAgent } from '../reminders/reminder.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { withAnimaHome } from './anima-home.js';
import { waitFor } from './helpers/harness.js';

async function writeAgentConfig(stateDir: string, agentId: string, homePath: string): Promise<void> {
  await mkdir(homePath, { recursive: true });
  await mkdir(join(stateDir, 'agents', agentId), { recursive: true });
  await writeFile(
    join(stateDir, 'agents', agentId, 'config.json'),
    `${JSON.stringify({
      homePath,
      id: agentId,
      provider: { kind: 'codex-cli', model: 'gpt-5.5' },
      slack: { appToken: 'xapp', botToken: 'xoxb' },
    }, null, 2)}\n`,
  );
}

async function withAgentHome<T>(body: (home: string, agentId: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-preflight-'));
  const agentId = 'scout';
  const homePath = join(stateDir, 'home');
  try {
    await writeFile(join(stateDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`);
    await writeAgentConfig(stateDir, agentId, homePath);
    return await withAnimaHome(stateDir, () => body(homePath, agentId));
  } finally {
    resetPreflightConcurrencyForTests();
    setPreflightAfterRecheckHookForTests(undefined);
    await rm(stateDir, { force: true, recursive: true });
  }
}

async function withTwoAgentHomes<T>(
  body: (alpha: { home: string; agentId: string }, beta: { home: string; agentId: string }) => Promise<T>,
): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-preflight-2-'));
  const alphaId = 'alpha';
  const betaId = 'beta';
  const alphaHome = join(stateDir, 'home-alpha');
  const betaHome = join(stateDir, 'home-beta');
  try {
    await writeFile(join(stateDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`);
    await writeAgentConfig(stateDir, alphaId, alphaHome);
    await writeAgentConfig(stateDir, betaId, betaHome);
    return await withAnimaHome(stateDir, () =>
      body({ home: alphaHome, agentId: alphaId }, { home: betaHome, agentId: betaId }),
    );
  } finally {
    resetPreflightConcurrencyForTests();
    setPreflightAfterRecheckHookForTests(undefined);
    await rm(stateDir, { force: true, recursive: true });
  }
}

test('preflight exit 0 = succeeded, exit 1 = declined, exit 2 = errored', async () => {
  await withAgentHome(async (cwd) => {
    const ok = await runPreflightCommand({
      command: 'exit 0',
      cwd,
      scheduledAt: '2026-08-03T00:00:00.000Z',
    });
    assert.ok(ok.result);
    assert.equal(ok.result.status, 'succeeded');
    assert.equal(ok.result.exitCode, 0);

    const declined = await runPreflightCommand({
      command: 'exit 1',
      cwd,
      scheduledAt: '2026-08-03T00:00:00.000Z',
    });
    assert.ok(declined.result);
    assert.equal(declined.result.status, 'declined');
    assert.equal(declined.result.exitCode, 1);

    const errored = await runPreflightCommand({
      command: 'exit 2',
      cwd,
      scheduledAt: '2026-08-03T00:00:00.000Z',
    });
    assert.ok(errored.result);
    assert.equal(errored.result.status, 'errored');
    assert.equal(errored.result.exitCode, 2);
  });
});

test('preflight cwd is exactly Agent Home', async () => {
  await withAgentHome(async (cwd) => {
    const marker = join(cwd, 'cwd-marker.txt');
    await writeFile(marker, 'here\n');
    const run = await runPreflightCommand({
      command: 'pwd && test -f cwd-marker.txt && echo FOUND',
      cwd,
      scheduledAt: '2026-08-03T00:00:00.000Z',
    });
    assert.ok(run.result);
    assert.equal(run.result.status, 'succeeded');
    assert.match(run.result.stdout ?? '', /FOUND/);
    // pwd output should be the agent home path
    assert.ok(
      (run.result.stdout ?? '').includes(cwd) || (run.result.stdout ?? '').includes(await realpathSafe(cwd)),
      `stdout should contain cwd ${cwd}: ${run.result.stdout}`,
    );
  });
});

test('preflight timeout kills process group and is errored', async () => {
  await withAgentHome(async (cwd) => {
    const started = Date.now();
    const run = await runPreflightCommand({
      command: 'sleep 30',
      cwd,
      scheduledAt: '2026-08-03T00:00:00.000Z',
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;
    assert.ok(run.result);
    assert.equal(run.result.status, 'errored');
    assert.equal(run.result.timedOut, true);
    assert.ok(elapsed < 5_000, `timeout should kill quickly, took ${elapsed}ms`);
  });
});

test('preflight stdout is capped with truncation marker on wake evidence', async () => {
  await withAgentHome(async (cwd) => {
    const run = await runPreflightCommand({
      command: `node -e "process.stdout.write('x'.repeat(${REMINDER_BODY_MAX_CHARS + 500}))"`,
      cwd,
      scheduledAt: '2026-08-03T00:00:00.000Z',
    });
    assert.ok(run.result);
    assert.equal(run.result.status, 'succeeded');
    assert.equal(run.result.stdoutTruncated, true);
    assert.ok((run.result.stdout ?? '').length <= REMINDER_BODY_MAX_CHARS);
    const evidence = preflightEvidenceForWake(run.result);
    assert.ok(evidence?.includes('[preflight stdout truncated]'));
  });
});

test('timeoutMs hard cap and command validation', () => {
  assert.equal(normalizePreflightTimeoutMs(undefined), 30 * 60 * 1000);
  assert.throws(() => normalizePreflightTimeoutMs(PREFLIGHT_MAX_TIMEOUT_MS + 1), /hard cap/);
  assert.throws(() => validatePreflightCommand('  '), /non-empty/);
});

test('CLI/help copy forbids true/false/pass/fail wording for preflight', async () => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const cli = await readFile(resolve('server/reminders/cli.ts'), 'utf8');
  const preflightHelp = cli.slice(cli.indexOf('--preflight'));
  const section = preflightHelp.slice(0, 800).toLowerCase();
  assert.match(section, /exit 0 = wake/);
  assert.match(section, /exit 1 = skip/);
  for (const banned of ['true/false', 'pass/fail', 'true = ', 'false = ', 'pass =', 'fail =']) {
    assert.ok(!section.includes(banned), `banned wording: ${banned}`);
  }
});

test('end-to-end: preflight 0 wakes with evidence; 1 skips; 2 errors without queue item', async () => {
  await withAgentHome(async (_homePath, agentId) => {
    const service = reminderServiceForAgent(agentId);
    const queue = new WakeQueueService(agentId);
    const subscriber = new ReminderInboxSubscriber(queue, service);
    const now = new Date();

    const wake = await service.scheduleReminder({
      fireAt: '2020-01-01T00:00:00.000Z',
      instructions: 'do the work',
      now,
      preflight: { command: 'echo PREFLIGHT_OK && exit 0' },
      title: 'gate-ok',
    });

    subscriber.start();
    try {
      await waitFor(async () => (await queue.list()).some((i) => i.kind === 'reminder' && i.reminderId === wake.reminderId), {
        description: 'reminder wake enqueued after exit 0',
        timeoutMs: 5_000,
      });
    } finally {
      await subscriber.stop();
    }

    const wakeItem = (await queue.list()).find((i) => i.kind === 'reminder' && i.reminderId === wake.reminderId);
    assert.ok(wakeItem);
    assert.match((wakeItem as { preflightEvidence?: string }).preflightEvidence ?? '', /PREFLIGHT_OK/);

    const afterWake = await service.findReminder(wake.reminderId);
    const prompt = buildCodeAgentDeliveryPrompt(wakeItem as never, {
      reminder: afterWake,
    });
    assert.match(prompt, /PREFLIGHT_OK/);
    assert.match(prompt, /do the work/);
    assert.equal(afterWake?.preflightLastResult?.status, 'succeeded');

    // exit 1: no additional queue items
    const skip = await service.scheduleReminder({
      fireAt: '2020-01-02T00:00:00.000Z',
      instructions: 'should not run',
      now,
      preflight: { command: 'exit 1' },
      title: 'gate-skip',
    });
    const beforeSkip = (await queue.list()).length;
    subscriber.start();
    try {
      await waitFor(async () => {
        const rem = await service.findReminder(skip.reminderId);
        return rem?.preflightLastResult?.status === 'declined';
      }, { description: 'preflight declined recorded', timeoutMs: 5_000 });
    } finally {
      await subscriber.stop();
    }
    const afterSkip = await service.findReminder(skip.reminderId);
    assert.equal(afterSkip?.preflightLastResult?.status, 'declined');
    assert.equal((await queue.list()).length, beforeSkip);
    assert.equal(afterSkip?.preflightError, undefined);
    // Declined check must not count as a fire.
    assert.equal(afterSkip?.firedCount, 0);
    assert.equal(afterSkip?.lastFiredAt, undefined);

    // exit 2: error state, no queue
    const err = await service.scheduleReminder({
      fireAt: '2020-01-03T00:00:00.000Z',
      instructions: 'should error',
      now,
      preflight: { command: 'exit 7' },
      title: 'gate-err',
    });
    const beforeErr = (await queue.list()).length;
    subscriber.start();
    try {
      await waitFor(async () => {
        const rem = await service.findReminder(err.reminderId);
        return rem?.preflightLastResult?.status === 'errored';
      }, { description: 'preflight error recorded', timeoutMs: 5_000 });
    } finally {
      await subscriber.stop();
    }
    const afterErr = await service.findReminder(err.reminderId);
    assert.equal(afterErr?.preflightLastResult?.status, 'errored');
    assert.equal(afterErr?.preflightLastResult?.exitCode, 7);
    assert.ok(afterErr?.preflightError, 'preflight-error attention state');
    assert.equal((await queue.list()).length, beforeErr);
    assert.equal(afterErr?.firedCount, 0, 'errored check is not a fire');
    assert.equal(afterErr?.lastFiredAt, undefined);

    // red control: exit 1 must not be succeeded or errored
    assert.notEqual(afterSkip?.preflightLastResult?.status, 'succeeded');
    assert.notEqual(afterSkip?.preflightLastResult?.status, 'errored');
  });
});

test('overlap Forbid: second fire while preflight runs is skipped', async () => {
  await withAgentHome(async () => {
    const id = 'rem_overlap_test';
    const noop = () => {};
    assert.equal(tryBeginPreflight(id, noop), true);
    assert.equal(tryBeginPreflight(id, noop), false, 'second begin must be rejected');
    endPreflight(id);
    assert.equal(tryBeginPreflight(id, noop), true);
    endPreflight(id);
  });
});

test('legacy reminders without preflight still fire (byte-compatible path)', async () => {
  await withAgentHome(async (_home, agentId) => {
    const service = reminderServiceForAgent(agentId);
    const queue = new WakeQueueService(agentId);
    const subscriber = new ReminderInboxSubscriber(queue, service);
    const reminder = await service.scheduleReminder({
      fireAt: '2020-01-01T00:00:00.000Z',
      instructions: 'legacy wake',
      now: new Date(),
      title: 'legacy',
    });
    assert.equal(reminder.preflight, undefined);
    subscriber.start();
    try {
      await waitFor(async () => (await queue.list()).some((i) => i.kind === 'reminder' && i.reminderId === reminder.reminderId), {
        description: 'legacy reminder wake',
        timeoutMs: 5_000,
      });
    } finally {
      await subscriber.stop();
    }
    const item = (await queue.list()).find((i) => i.kind === 'reminder' && i.reminderId === reminder.reminderId);
    assert.equal((item as { preflightEvidence?: string } | undefined)?.preflightEvidence, undefined);
  });
});

test('windowed schedule still accepts preflight without schedule rewrite', async () => {
  await withAgentHome(async (_home, agentId) => {
    const service = reminderServiceForAgent(agentId);
    const reminder = await service.scheduleReminder({
      instructions: 'poll',
      now: new Date('2026-05-18T11:00:00.000Z'),
      preflight: { command: 'exit 0', timeoutMs: 60_000 },
      repeat: 'every:30m',
      timezone: 'America/New_York',
      title: 'windowed+gate',
      window: 'mon-fri@08:00-18:30',
    });
    assert.equal(reminder.schedule.kind, 'windowed_interval');
    assert.equal(reminder.preflight?.command, 'exit 0');
    assert.equal(reminder.preflight?.timeoutMs, 60_000);
  });
});

test('cancel/snooze mid-preflight discards stale success via updatedAt gate', async () => {
  await withAgentHome(async (home, agentId) => {
    const service = reminderServiceForAgent(agentId);
    const queue = new WakeQueueService(agentId);
    const subscriber = new ReminderInboxSubscriber(queue, service);
    const { isPreflightResultStillValid } = await import('../inbox/reminder-subscriber.js');
    const gate = join(home, 'preflight-release');

    // Cancel case: unit validity + e2e with gate file
    const cancelRem = await service.scheduleReminder({
      fireAt: '2020-01-01T00:00:00.000Z',
      instructions: 'cancel',
      now: new Date(),
      preflight: { command: `while [ ! -f '${gate}' ]; do sleep 0.05; done; exit 0` },
      title: 'cancel-race',
    });
    subscriber.start();
    await waitFor(async () => {
      const { isPreflightRunning } = await import('../reminders/preflight.js');
      return isPreflightRunning(cancelRem.reminderId);
    }, { description: 'cancel preflight started', timeoutMs: 2_000 });
    const cancelled = await service.cancelReminder({ id: cancelRem.reminderId });
    assert.equal(isPreflightResultStillValid(cancelRem, cancelled), false);
    await writeFile(gate, 'go\n');
    await waitFor(async () => {
      const { isPreflightRunning } = await import('../reminders/preflight.js');
      return !isPreflightRunning(cancelRem.reminderId);
    }, { description: 'cancel preflight finished', timeoutMs: 5_000 });
    await subscriber.stop();
    assert.equal((await service.findReminder(cancelRem.reminderId))?.status, 'cancelled');
    assert.equal(
      (await queue.list()).filter((i) => i.kind === 'reminder' && i.reminderId === cancelRem.reminderId).length,
      0,
    );
    assert.equal((await service.findReminder(cancelRem.reminderId))?.firedCount, 0);

    // Snooze case
    await rm(gate, { force: true });
    const snoozeRem = await service.scheduleReminder({
      fireAt: '2020-01-02T00:00:00.000Z',
      instructions: 'snooze',
      now: new Date(),
      preflight: { command: `while [ ! -f '${gate}' ]; do sleep 0.05; done; exit 0` },
      repeat: 'every:1h',
      title: 'snooze-race',
    });
    // Freeze snapshot as the job does (clone) so in-place store mutation cannot poison it.
    const frozenSnap = structuredClone(snoozeRem);
    subscriber.start();
    await waitFor(async () => {
      const { isPreflightRunning } = await import('../reminders/preflight.js');
      return isPreflightRunning(snoozeRem.reminderId);
    }, { description: 'snooze preflight started', timeoutMs: 2_000 });
    const snoozed = await service.snoozeReminder({ by: '2h', id: snoozeRem.reminderId, now: new Date() });
    assert.equal(isPreflightResultStillValid(frozenSnap, snoozed), false);
    assert.notEqual(snoozed.nextDueAt, frozenSnap.nextDueAt);
    await writeFile(gate, 'go\n');
    await waitFor(async () => {
      const { isPreflightRunning } = await import('../reminders/preflight.js');
      return !isPreflightRunning(snoozeRem.reminderId);
    }, { description: 'snooze preflight finished', timeoutMs: 5_000 });
    await subscriber.stop();
    const after = await service.findReminder(snoozeRem.reminderId);
    assert.equal(after?.status, 'scheduled');
    assert.equal(after?.firedCount, 0, 'stale success must not count a fire');
    assert.equal(after?.nextDueAt, snoozed.nextDueAt, 'snooze nextDueAt must stick');
    assert.equal(
      (await queue.list()).filter((i) => i.kind === 'reminder' && i.reminderId === snoozeRem.reminderId).length,
      0,
    );
  });
});

test('schedule advances from completion time (no missed-tick catch-up)', async () => {
  await withAgentHome(async (_home, agentId) => {
    const service = reminderServiceForAgent(agentId);
    // Simulate long preflight: record check with completedAt far after original due.
    const rem = await service.scheduleReminder({
      fireAt: '2020-01-01T00:00:00.000Z',
      instructions: 'interval',
      now: new Date('2020-01-01T00:00:00.000Z'),
      preflight: { command: 'exit 1' },
      repeat: 'every:1m',
      title: 'catchup',
    });
    assert.equal(rem.nextDueAt, '2020-01-01T00:00:00.000Z');
    const completedAt = new Date('2020-01-01T00:05:00.000Z');
    const { applied, reminder: after } = await service.recordPreflightCheck({
      id: rem.reminderId,
      now: completedAt,
      preflightResult: {
        durationMs: 300_000,
        endedAt: completedAt.toISOString(),
        exitCode: 1,
        scheduledAt: '2020-01-01T00:00:00.000Z',
        startedAt: '2020-01-01T00:00:00.000Z',
        status: 'declined',
      },
    });
    assert.equal(applied, true);
    // Next due must be strictly after completion (00:06), not 00:01.
    assert.equal(after.nextDueAt, '2020-01-01T00:06:00.000Z');
    assert.equal(after.firedCount, 0);
  });
});

test('error attention throttle preserves lastNotifiedAt across three repeats', async () => {
  await withAgentHome(async (_home, agentId) => {
    const service = reminderServiceForAgent(agentId);
    const { shouldNotifyPreflightError } = await import('../inbox/reminder-subscriber.js');
    const rem = await service.scheduleReminder({
      fireAt: '2020-01-01T00:00:00.000Z',
      instructions: 'err',
      now: new Date(),
      preflight: { command: 'exit 9' },
      title: 'throttle',
    });
    const result = {
      durationMs: 1,
      endedAt: '2020-01-01T00:00:01.000Z',
      exitCode: 9,
      scheduledAt: '2020-01-01T00:00:00.000Z',
      startedAt: '2020-01-01T00:00:00.000Z',
      status: 'errored' as const,
    };
    const { classifyPreflightAttentionKey } = await import('../reminders/preflight.js');
    const key = classifyPreflightAttentionKey(rem.reminderId, result);
    const t0 = new Date('2020-01-01T00:00:01.000Z');
    const first = await service.recordPreflightCheck({
      id: rem.reminderId,
      now: t0,
      preflightResult: result,
      setPreflightError: {
        attentionKey: key,
        lastNotifiedAt: t0.toISOString(),
        since: t0.toISOString(),
      },
    });
    assert.equal(first.applied, true);
    assert.equal(first.reminder.preflightError?.lastNotifiedAt, t0.toISOString());
    assert.equal(shouldNotifyPreflightError(first.reminder, key, new Date('2020-01-01T00:10:00.000Z')), false);
    // Suppressed write must not erase lastNotifiedAt
    const second = await service.recordPreflightCheck({
      id: rem.reminderId,
      now: new Date('2020-01-01T00:10:00.000Z'),
      preflightResult: { ...result, endedAt: '2020-01-01T00:10:00.000Z' },
      setPreflightError: {
        attentionKey: key,
        since: t0.toISOString(),
        // omit lastNotifiedAt on purpose
      },
    });
    assert.equal(second.reminder.preflightError?.lastNotifiedAt, t0.toISOString());
    assert.equal(shouldNotifyPreflightError(second.reminder, key, new Date('2020-01-01T00:20:00.000Z')), false);
    const third = await service.recordPreflightCheck({
      id: rem.reminderId,
      now: new Date('2020-01-01T00:20:00.000Z'),
      preflightResult: { ...result, endedAt: '2020-01-01T00:20:00.000Z' },
      setPreflightError: {
        attentionKey: key,
        since: t0.toISOString(),
      },
    });
    assert.equal(third.reminder.preflightError?.lastNotifiedAt, t0.toISOString());
    assert.equal(shouldNotifyPreflightError(third.reminder, key, new Date('2020-01-01T00:30:00.000Z')), false);
    // After 1h, notify again
    assert.equal(shouldNotifyPreflightError(third.reminder, key, new Date('2020-01-01T01:01:00.000Z')), true);
  });
});

test('queue failure before complete leaves reminder scheduled (wake not lost)', async () => {
  await withAgentHome(async (_home, agentId) => {
    const service = reminderServiceForAgent(agentId);
    const queue = new WakeQueueService(agentId);
    const retry = await service.scheduleReminder({
      fireAt: '2020-02-01T00:00:00.000Z',
      instructions: 'retry',
      now: new Date(),
      preflight: { command: 'exit 0' },
      repeat: 'every:1h',
      title: 'enqueue-fail',
    });
    const originalDue = retry.nextDueAt;
    let enqueueAttempts = 0;
    queue.enqueue = async () => {
      enqueueAttempts += 1;
      throw new Error('synthetic enqueue failure');
    };
    const subscriber = new ReminderInboxSubscriber(queue, service);
    subscriber.start();
    // Gate on observed enqueue attempt — not merely !isPreflightRunning (true before poll starts).
    await waitFor(async () => enqueueAttempts >= 1, {
      description: 'enqueue attempted after preflight success',
      timeoutMs: 5_000,
    });
    await waitFor(async () => {
      const { isPreflightRunning } = await import('../reminders/preflight.js');
      return !isPreflightRunning(retry.reminderId);
    }, { description: 'preflight job finished after enqueue failure', timeoutMs: 5_000 });
    await subscriber.stop();
    assert.ok(enqueueAttempts >= 1, `expected enqueue attempt, got ${enqueueAttempts}`);
    const after = await service.findReminder(retry.reminderId);
    assert.equal(after?.status, 'scheduled');
    assert.equal(after?.firedCount, 0);
    assert.equal(after?.nextDueAt, originalDue, 'must not advance schedule when enqueue fails');
    assert.equal(after?.preflightLastResult, undefined, 'failed enqueue must not commit success');
  });
});

test('stopping one subscriber does not abort another agent preflight', async () => {
  await withTwoAgentHomes(async (alpha, beta) => {
    const alphaService = reminderServiceForAgent(alpha.agentId);
    const betaService = reminderServiceForAgent(beta.agentId);
    const alphaQueue = new WakeQueueService(alpha.agentId);
    const betaQueue = new WakeQueueService(beta.agentId);
    const alphaSub = new ReminderInboxSubscriber(alphaQueue, alphaService);
    const betaSub = new ReminderInboxSubscriber(betaQueue, betaService);
    const alphaGate = join(alpha.home, 'release');
    const betaGate = join(beta.home, 'release');

    await alphaService.scheduleReminder({
      fireAt: '2020-01-01T00:00:00.000Z',
      instructions: 'alpha',
      now: new Date(),
      preflight: { command: `while [ ! -f '${alphaGate}' ]; do sleep 0.05; done; exit 1` },
      title: 'alpha-hold',
    });
    const betaRem = await betaService.scheduleReminder({
      fireAt: '2020-01-01T00:00:00.000Z',
      instructions: 'beta',
      now: new Date(),
      preflight: { command: `while [ ! -f '${betaGate}' ]; do sleep 0.05; done; exit 1` },
      title: 'beta-hold',
    });

    alphaSub.start();
    betaSub.start();
    const { isPreflightRunning } = await import('../reminders/preflight.js');
    await waitFor(async () => isPreflightRunning((await alphaService.listReminders())[0]!.reminderId), {
      description: 'alpha preflight running',
      timeoutMs: 3_000,
    });
    await waitFor(async () => isPreflightRunning(betaRem.reminderId), {
      description: 'beta preflight running',
      timeoutMs: 3_000,
    });

    await alphaSub.stop();
    // Beta must still be running after Alpha stop.
    assert.equal(isPreflightRunning(betaRem.reminderId), true, 'beta preflight must survive alpha stop');

    await writeFile(betaGate, 'go\n');
    await waitFor(async () => {
      const rem = await betaService.findReminder(betaRem.reminderId);
      return rem?.preflightLastResult?.status === 'declined';
    }, { description: 'beta declined after its own release', timeoutMs: 5_000 });
    await betaSub.stop();

    const afterBeta = await betaService.findReminder(betaRem.reminderId);
    assert.equal(afterBeta?.preflightLastResult?.status, 'declined');
    assert.equal(afterBeta?.firedCount, 0);
  });
});

test('CAS commit discards snooze injected after outer recheck', async () => {
  await withAgentHome(async (_home, agentId) => {
    const service = reminderServiceForAgent(agentId);
    const queue = new WakeQueueService(agentId);
    const subscriber = new ReminderInboxSubscriber(queue, service);
    const rem = await service.scheduleReminder({
      fireAt: '2026-08-03T01:00:00.000Z',
      instructions: 'cas',
      now: new Date('2026-08-03T00:00:00.000Z'),
      preflight: { command: 'exit 1' },
      repeat: 'every:1h',
      title: 'cas-snooze',
    });
    const originalDue = rem.nextDueAt;
    assert.equal(originalDue, '2026-08-03T01:00:00.000Z');

    let barrierRelease!: () => void;
    const barrier = new Promise<void>((resolve) => {
      barrierRelease = resolve;
    });
    let enteredBarrier = false;
    setPreflightAfterRecheckHookForTests(async () => {
      enteredBarrier = true;
      // Snooze in the gap between outer recheck and store CAS.
      await service.snoozeReminder({
        by: '2h',
        id: rem.reminderId,
        now: new Date('2026-08-03T00:30:00.000Z'),
      });
      barrierRelease();
    });

    subscriber.start();
    await barrier;
    await waitFor(async () => {
      const { isPreflightRunning } = await import('../reminders/preflight.js');
      return enteredBarrier && !isPreflightRunning(rem.reminderId);
    }, { description: 'job finished after CAS miss', timeoutMs: 5_000 });
    await subscriber.stop();

    const after = await service.findReminder(rem.reminderId);
    assert.equal(after?.status, 'scheduled');
    assert.equal(after?.firedCount, 0);
    assert.equal(after?.preflightLastResult, undefined, 'declined must not overwrite snooze');
    // Snooze set nextDue to ~02:30 from 00:30; not the declined advance from original due.
    assert.ok(after?.nextDueAt);
    assert.notEqual(after?.nextDueAt, originalDue);
    assert.match(after!.nextDueAt!, /^2026-08-03T02:30/);
  });
});

test('cancel during post-enqueue complete withdraws real queued wake', async () => {
  await withAgentHome(async (_home, agentId) => {
    const service = reminderServiceForAgent(agentId);
    const queue = new WakeQueueService(agentId);
    const rem = await service.scheduleReminder({
      fireAt: '2020-03-01T00:00:00.000Z',
      instructions: 'post-enqueue-cancel',
      now: new Date(),
      preflight: { command: 'exit 0' },
      title: 'enqueue-then-cancel',
    });
    const realEnqueue = queue.enqueue.bind(queue);
    let enqueueDone = false;
    queue.enqueue = async (event) => {
      const result = await realEnqueue(event);
      enqueueDone = true;
      // Cancel at the exact post-enqueue boundary before complete CAS.
      await service.cancelReminder({ id: rem.reminderId });
      return result;
    };
    const subscriber = new ReminderInboxSubscriber(queue, service);
    subscriber.start();
    await waitFor(async () => enqueueDone, {
      description: 'real enqueue completed',
      timeoutMs: 5_000,
    });
    await waitFor(async () => {
      const { isPreflightRunning } = await import('../reminders/preflight.js');
      return !isPreflightRunning(rem.reminderId);
    }, { description: 'preflight job settled', timeoutMs: 5_000 });
    await subscriber.stop();

    assert.equal((await service.findReminder(rem.reminderId))?.status, 'cancelled');
    assert.equal((await service.findReminder(rem.reminderId))?.firedCount, 0);
    const wakes = (await queue.list()).filter(
      (i) => i.kind === 'reminder' && i.reminderId === rem.reminderId,
    );
    assert.equal(wakes.length, 0, 'queued wake must be withdrawn after cancel');
  });
});

async function realpathSafe(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
