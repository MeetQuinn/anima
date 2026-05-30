import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeReminderInboxItem } from './helpers/inbox.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { allActivities, loadAgentState, loadState } from './helpers/state.js';
import { reminderServiceForAgent } from '../reminders/reminder.service.js';
import { nextDueAtForSchedule, parseRepeatRule } from '../reminders/reminder.helper.js';
import type {
  AgentRuntime,
  AgentRuntimeFollowupInput,
  AgentRuntimeInput,
  AgentRuntimeResult,
} from '../runtime/provider-contract.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { withAnimaHome } from './anima-home.js';

const cliPath = resolve('dist/server/cli/anima.js');
const reminderService = reminderServiceForAgent('scout');

test('one-shot reminders fire and clear nextDueAt', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-once-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const reminder = await reminderService.scheduleReminder({
        fireAt: '2026-05-14T09:00:00.000Z',
        instructions: 'Check course comments and send a concise summary only if something changed.',
        now: new Date('2026-05-14T08:00:00.000Z'),
        provenance: {
          channelId: 'C-course-review',
          messageTs: '1770000000.000001',
        },
        title: 'Course review',
      });

      assert.equal(reminder.status, 'scheduled');
      assert.equal(reminder.nextDueAt, '2026-05-14T09:00:00.000Z');

      const tooEarly = await reminderService.dueReminders({
        now: new Date('2026-05-14T08:59:59.000Z'),
      });
      assert.equal(tooEarly.length, 0);

      const due = await reminderService.dueReminders({
        now: new Date('2026-05-14T09:00:01.000Z'),
      });
      assert.equal(due.length, 1);
      assert.equal(due[0]?.reminderId, reminder.reminderId);

      await reminderService.completeReminderFire({
        id: reminder.reminderId,
        now: new Date('2026-05-14T09:00:01.000Z'),
      });
      const state = await loadAgentState('scout');
      assert.equal(state.reminders[reminder.reminderId]?.status, 'fired');
      assert.equal(state.reminders[reminder.reminderId]?.firedCount, 1);
      assert.equal(state.reminders[reminder.reminderId]?.nextDueAt, undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('recurring reminders can be snoozed without changing the long-term cadence', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-recurring-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const reminder = await reminderService.scheduleReminder({
        instructions: 'Review course comments.',
        now: new Date('2026-05-14T08:00:00.000Z'),
        repeat: 'daily@09:00',
        timezone: 'UTC',
        title: 'Daily course review',
      });
      assert.equal(reminder.nextDueAt, '2026-05-14T09:00:00.000Z');

      const snoozed = await reminderService.snoozeReminder({
        by: '2h',
        id: reminder.reminderId,
        now: new Date('2026-05-14T08:30:00.000Z'),
      });
      assert.equal(snoozed.nextDueAt, '2026-05-14T10:30:00.000Z');

      const fired = await reminderService.completeReminderFire({
        id: reminder.reminderId,
        now: new Date('2026-05-14T10:31:00.000Z'),
      });
      assert.equal(fired.status, 'scheduled');
      assert.equal(fired.firedCount, 1);
      assert.equal(fired.nextDueAt, '2026-05-15T09:00:00.000Z');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('due reminder delivery enters the inbox and records fire activity', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-scheduler-'));
  const runtime = new CapturingRuntime();
  const logger = { error: () => {}, log: () => {} };
  try {
    await withAnimaHome(stateDir, async () => {
      await writeConfig(stateDir);
      const reminder = await reminderService.scheduleReminder({
        fireAt: '2026-05-14T09:00:00.000Z',
        instructions: 'Wake up and decide whether to post an update.',
        now: new Date('2026-05-14T08:00:00.000Z'),
        title: 'Wake scout',
      });

      const queue = new WakeQueueService('scout');
      const firedAt = new Date('2026-05-14T09:00:01.000Z');
      const due = await reminderService.dueReminders({ now: firedAt });
      assert.equal(due.length, 1);
      const dueReminder = due[0] ?? assert.fail('expected due reminder');
      const event = makeReminderInboxItem({
        eventId: `reminder:${dueReminder.reminderId}:fire:${dueReminder.firedCount + 1}`,
        reminderId: dueReminder.reminderId,
        timestamp: firedAt.toISOString(),
      });
      const decision = await queue.enqueue(event);
      const firedReminder = await reminderService.completeReminderFire({
        id: dueReminder.reminderId,
        now: firedAt,
      });
      if (!decision.duplicate) {
        await reminderService.recordReminderFire({
          firedAt,
          reminder: firedReminder,
        });
      }
      const worker = new AgentRuntimeWorker(
        {
          agentId: 'scout',
          agentRuntime: runtime,
          pollIntervalMs: 10,
          queue,
          stateDir,
          workerId: 'reminder-test-worker',
        },
        logger,
      );

      worker.start();
      try {
        await waitUntil(() => runtime.calls.length === 1);
      } finally {
        await worker.close();
      }

      const call = runtime.calls[0];
      assert.match(call?.prompt ?? '', new RegExp(`reminder_id=${reminder.reminderId}`));

      await waitUntil(async () => {
        const state = await loadState();
        return state.reminders[reminder.reminderId]?.status === 'fired';
      });
      await waitUntil(async () => {
        const items = await queue.listRunnable();
        return items.length > 0 && items.every((item) => item.handling.status !== 'running');
      });
      const fireActivity = allActivities(await loadState()).find(
        (activity) => activity.payload?.['tool'] === 'anima.reminder.fire',
      );
      assert.equal(fireActivity?.type, 'tool.call.completed');
      assert.equal(fireActivity?.payload?.['reminderId'], reminder.reminderId);
      assert.equal(fireActivity?.payload?.['title'], 'Wake scout');
      assert.equal(fireActivity?.payload?.['status'], 'fired');
      assert.equal(fireActivity?.payload?.['firedAt'], fireActivity?.payload?.['lastFiredAt']);
      assert.equal(Number.isFinite(Date.parse(String(fireActivity?.payload?.['firedAt']))), true);
      assert.equal(fireActivity?.payload?.['firedCount'], 1);
      assert.equal(fireActivity?.payload?.['scheduleKind'], 'once');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('reminder cancel and snooze record agent activity', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-audit-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const first = await reminderService.scheduleReminder({
        delaySeconds: 600,
        instructions: 'no-op',
        now: new Date('2026-05-14T08:00:00.000Z'),
        title: 'snooze target',
      });
      const snoozed = await reminderService.snoozeReminder({
        by: '30m',
        id: first.reminderId,
        now: new Date('2026-05-14T08:01:00.000Z'),
      });
      assert.equal(snoozed.nextDueAt, '2026-05-14T08:31:00.000Z');

      const second = await reminderService.scheduleReminder({
        delaySeconds: 600,
        instructions: 'no-op',
        now: new Date('2026-05-14T08:00:00.000Z'),
        title: 'cancel target',
      });
      const cancelled = await reminderService.cancelReminder({
        id: second.reminderId,
        now: new Date('2026-05-14T08:02:00.000Z'),
      });
      assert.equal(cancelled.cancelledAt, '2026-05-14T08:02:00.000Z');

      const activities = allActivities(await loadState());
      const snooze = activities.find((activity) => activity.payload?.['tool'] === 'anima.reminder.snooze');
      assert.equal(snooze?.type, 'tool.call.completed');
      assert.equal(snooze?.payload?.['reminderId'], first.reminderId);
      assert.equal(snooze?.payload?.['title'], 'snooze target');
      assert.equal(snooze?.payload?.['nextDueAt'], '2026-05-14T08:31:00.000Z');

      const cancel = activities.find((activity) => activity.payload?.['tool'] === 'anima.reminder.cancel');
      assert.equal(cancel?.type, 'tool.call.completed');
      assert.equal(cancel?.payload?.['reminderId'], second.reminderId);
      assert.equal(cancel?.payload?.['title'], 'cancel target');
      assert.equal(cancel?.payload?.['cancelledAt'], '2026-05-14T08:02:00.000Z');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('settled reminders older than 30 days are pruned on writes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-retention-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const oldFired = await reminderService.scheduleReminder({
        fireAt: '2026-03-02T08:00:00.000Z',
        instructions: 'old fired',
        now: new Date('2026-03-01T08:00:00.000Z'),
        title: 'old fired',
      });
      await reminderService.completeReminderFire({
        id: oldFired.reminderId,
        now: new Date('2026-03-02T08:00:00.000Z'),
      });

      const oldCancelled = await reminderService.scheduleReminder({
        delaySeconds: 60,
        instructions: 'old cancelled',
        now: new Date('2026-03-01T08:00:00.000Z'),
        title: 'old cancelled',
      });
      await reminderService.cancelReminder({
        id: oldCancelled.reminderId,
        now: new Date('2026-03-03T08:00:00.000Z'),
      });

      const oldScheduled = await reminderService.scheduleReminder({
        fireAt: '2026-06-01T08:00:00.000Z',
        instructions: 'still active',
        now: new Date('2026-03-01T08:00:00.000Z'),
        title: 'old scheduled',
      });

      const recentFired = await reminderService.scheduleReminder({
        fireAt: '2026-05-01T08:00:00.000Z',
        instructions: 'recent fired',
        now: new Date('2026-04-30T08:00:00.000Z'),
        title: 'recent fired',
      });
      await reminderService.completeReminderFire({
        id: recentFired.reminderId,
        now: new Date('2026-05-01T08:00:00.000Z'),
      });

      await reminderService.scheduleReminder({
        delaySeconds: 60,
        instructions: 'trigger retention',
        now: new Date('2026-05-15T08:00:00.000Z'),
        title: 'trigger retention',
      });

      const state = await loadAgentState('scout');
      assert.equal(state.reminders[oldFired.reminderId], undefined);
      assert.equal(state.reminders[oldCancelled.reminderId], undefined);
      assert.equal(state.reminders[oldScheduled.reminderId]?.status, 'scheduled');
      assert.equal(state.reminders[recentFired.reminderId]?.status, 'fired');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('parseRepeatRule rejects zero-interval and malformed rules', () => {
  assert.throws(() => parseRepeatRule('every:0h', 'UTC'), /greater than zero/);
  assert.throws(() => parseRepeatRule('every:0m', 'UTC'), /greater than zero/);
  assert.throws(() => parseRepeatRule('weekly:@09:00', 'UTC'), /Invalid repeat rule/);
  assert.throws(() => parseRepeatRule('weekly:funday@09:00', 'UTC'), /Invalid weekly repeat weekdays/);
});

test('recurring reminder rules respect IANA timezones', () => {
  const daily = parseRepeatRule('daily@09:00', 'Asia/Shanghai');
  assert.equal(
    nextDueAtForSchedule(daily, new Date('2026-05-14T00:30:00.000Z')),
    '2026-05-14T01:00:00.000Z',
  );

  const weekly = parseRepeatRule('weekly:mon@10:00', 'Asia/Shanghai');
  assert.equal(
    nextDueAtForSchedule(weekly, new Date('2026-05-17T12:00:00.000Z')),
    '2026-05-18T02:00:00.000Z',
  );
});

test('cancelReminder throws on missing id and snoozeReminder throws on cancelled', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-errors-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await assert.rejects(
        reminderService.cancelReminder({ id: 'rem_does_not_exist' }),
        /Reminder not found/,
      );

      const reminder = await reminderService.scheduleReminder({
        delaySeconds: 60,
        instructions: 'no-op',
        now: new Date('2026-05-14T08:00:00.000Z'),
        title: 'temp',
      });
      await reminderService.cancelReminder({ id: reminder.reminderId });
      await assert.rejects(
        reminderService.snoozeReminder({ by: '5m', id: reminder.reminderId }),
        /Cannot snooze cancelled reminder/,
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('reminder CLI schedules, lists, snoozes, and cancels reminders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-reminder-cli-'));
  const configDir = join(root, '.anima');
  try {
    await writeConfig(configDir);

    const env = { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: configDir, ANIMA_INBOX_ITEM_ID: '' };
    const scheduled = await runNode(
      [
        cliPath,
        'reminder',
        'schedule',
        '--title',
        'Review comments',
        '--in',
        '10m',
        '--instructions',
        'Read the latest comments and summarize changes.',
      ],
      { env },
    );
    assert.equal(scheduled.status, 0, scheduled.stderr || scheduled.stdout);
    assert.match(scheduled.stdout, /^scheduled successfully\. reminder_id=rem_/);
    const reminderId = scheduled.stdout.match(/reminder_id=([^,]+)/)?.[1];
    assert.ok(reminderId);

    const aliasScheduled = await runNode(
      [
        cliPath,
        'reminder',
        'schedule',
        '--in',
        '5m',
        '--note',
        'Check prod after restart and report anything odd.',
      ],
      { env },
    );
    assert.equal(aliasScheduled.status, 0, aliasScheduled.stderr || aliasScheduled.stdout);
    assert.match(aliasScheduled.stdout, /title=Check prod after restart and report anything odd\./);

    const listed = await runNode([cliPath, 'reminder', 'list'], { env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, new RegExp(`${reminderId} \\[scheduled\\] next=.* Review comments`));

    const snoozed = await runNode(
      [cliPath, 'reminder', 'snooze', '--id', reminderId, '--by', '30m'],
      { env },
    );
    assert.equal(snoozed.status, 0, snoozed.stderr || snoozed.stdout);
    assert.match(snoozed.stdout, new RegExp(`^snoozed successfully\\. reminder_id=${reminderId}, title=Review comments, next=`));

    const cancelled = await runNode(
      [cliPath, 'reminder', 'cancel', reminderId],
      { env },
    );
    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    assert.equal(cancelled.stdout.trim(), `cancelled successfully. reminder_id=${reminderId}, title=Review comments.`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

class CapturingRuntime implements AgentRuntime {
  readonly kind = 'capturing-runtime';
  readonly calls: AgentRuntimeInput[] = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    return { text: 'ok' };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

async function writeConfig(configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await mkdir(join(configDir, 'agents', 'scout'), { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  await writeFile(join(configDir, 'agents', 'scout', 'config.json'), `${JSON.stringify({ id: 'scout' }, null, 2)}\n`, 'utf8');
}

async function runNode(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(options.input);
  const [status] = (await once(child, 'exit')) as [number | null];
  return { status, stderr, stdout };
}
