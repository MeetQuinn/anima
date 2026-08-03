import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReminderInboxSubscriber } from '../inbox/reminder-subscriber.js';
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

async function withAgentHome<T>(body: (home: string, agentId: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-preflight-'));
  const agentId = 'scout';
  const homePath = join(stateDir, 'home');
  try {
    await mkdir(homePath, { recursive: true });
    await mkdir(join(stateDir, 'agents', agentId), { recursive: true });
    await writeFile(join(stateDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`);
    await writeFile(
      join(stateDir, 'agents', agentId, 'config.json'),
      `${JSON.stringify({
        homePath,
        id: agentId,
        provider: { kind: 'codex-cli', model: 'gpt-5.5' },
        slack: { appToken: 'xapp', botToken: 'xoxb' },
      }, null, 2)}\n`,
    );
    return await withAnimaHome(stateDir, () => body(homePath, agentId));
  } finally {
    resetPreflightConcurrencyForTests();
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
    assert.equal(ok.result.status, 'succeeded');
    assert.equal(ok.result.exitCode, 0);

    const declined = await runPreflightCommand({
      command: 'exit 1',
      cwd,
      scheduledAt: '2026-08-03T00:00:00.000Z',
    });
    assert.equal(declined.result.status, 'declined');
    assert.equal(declined.result.exitCode, 1);

    const errored = await runPreflightCommand({
      command: 'exit 2',
      cwd,
      scheduledAt: '2026-08-03T00:00:00.000Z',
    });
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

    // red control: exit 1 must not be succeeded or errored
    assert.notEqual(afterSkip?.preflightLastResult?.status, 'succeeded');
    assert.notEqual(afterSkip?.preflightLastResult?.status, 'errored');
  });
});

test('overlap Forbid: second fire while preflight runs is skipped', async () => {
  await withAgentHome(async () => {
    const id = 'rem_overlap_test';
    assert.equal(tryBeginPreflight(id), true);
    assert.equal(tryBeginPreflight(id), false, 'second begin must be rejected');
    endPreflight(id);
    assert.equal(tryBeginPreflight(id), true);
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

async function realpathSafe(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
