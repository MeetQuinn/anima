import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeReminderInboxItem } from './helpers/inbox.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { ReminderInboxSubscriber } from '../inbox/reminder-subscriber.js';
import { allActivities, loadAgentState, loadState } from './helpers/state.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { reminderServiceForAgent } from '../reminders/reminder.service.js';
import {
  REMINDER_SCHEDULE_EXAMPLES,
  reminderScheduleExampleCommand,
} from '../reminders/cli.js';
import {
  buildWindowedIntervalSchedule,
  nextDueAtForSchedule,
  parseRepeatRule,
  parseWindowRule,
  windowedSlotsOnLocalDay,
} from '../reminders/reminder.helper.js';
import { zonedDateTime } from '../schedule/local-time.js';
import type {
  AgentRuntime,
  AgentRuntimeFollowupInput,
  AgentRuntimeInput,
  AgentRuntimeResult,
} from '../providers/contract.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { withAnimaHome } from './anima-home.js';
import { waitFor } from './helpers/harness.js';

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

test('fixed intervals preserve their initial phase across late fires and snooze', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-interval-phase-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const reminder = await reminderService.scheduleReminder({
        delaySeconds: 30 * 60,
        instructions: 'Review the queue.',
        now: new Date('2026-05-14T08:00:00.000Z'),
        repeat: 'every:1h',
        title: 'Queue review',
      });
      assert.equal(reminder.nextDueAt, '2026-05-14T08:30:00.000Z');
      assert.equal(
        reminder.schedule.kind === 'interval' ? reminder.schedule.phaseAnchorAt : undefined,
        '2026-05-14T08:30:00.000Z',
      );

      const late = await reminderService.completeReminderFire({
        id: reminder.reminderId,
        now: new Date('2026-05-14T12:45:00.000Z'),
      });
      assert.equal(late.nextDueAt, '2026-05-14T13:30:00.000Z');
      assert.equal(
        nextDueAtForSchedule(late.schedule, new Date('2026-05-14T13:30:00.000Z')),
        '2026-05-14T14:30:00.000Z',
      );

      const snoozed = await reminderService.snoozeReminder({
        by: '2h',
        id: reminder.reminderId,
        now: new Date('2026-05-14T13:00:00.000Z'),
      });
      assert.equal(snoozed.nextDueAt, '2026-05-14T15:00:00.000Z');

      const afterSnooze = await reminderService.completeReminderFire({
        id: reminder.reminderId,
        now: new Date('2026-05-14T15:01:00.000Z'),
      });
      assert.equal(afterSnooze.nextDueAt, '2026-05-14T15:30:00.000Z');

      const futureAnchor = await reminderService.scheduleReminder({
        fireAt: '2026-05-14T18:00:00.000Z',
        instructions: 'Review the future queue.',
        now: new Date('2026-05-14T17:00:00.000Z'),
        repeat: 'every:1h',
        title: 'Future queue review',
      });
      const earlySnooze = await reminderService.snoozeReminder({
        by: '10m',
        id: futureAnchor.reminderId,
        now: new Date('2026-05-14T17:00:00.000Z'),
      });
      assert.equal(earlySnooze.nextDueAt, '2026-05-14T17:10:00.000Z');

      const afterEarlySnooze = await reminderService.completeReminderFire({
        id: futureAnchor.reminderId,
        now: new Date('2026-05-14T17:11:00.000Z'),
      });
      assert.equal(afterEarlySnooze.nextDueAt, '2026-05-14T18:00:00.000Z');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('repeat-only intervals use creation time as their stable phase origin', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-interval-origin-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const reminder = await reminderService.scheduleReminder({
        instructions: 'Review the queue.',
        now: new Date('2026-05-14T08:12:00.000Z'),
        repeat: 'every:1h',
        title: 'Queue review',
      });
      assert.equal(reminder.nextDueAt, '2026-05-14T09:12:00.000Z');
      assert.equal(
        reminder.schedule.kind === 'interval' ? reminder.schedule.phaseAnchorAt : undefined,
        reminder.createdAt,
      );

      const recreated = await reminderService.scheduleReminder({
        instructions: 'Review the queue.',
        now: new Date('2026-05-14T08:47:00.000Z'),
        repeat: 'every:1h',
        title: 'Queue review',
      });
      assert.equal(recreated.nextDueAt, '2026-05-14T09:47:00.000Z');
      assert.equal(
        recreated.schedule.kind === 'interval' ? recreated.schedule.phaseAnchorAt : undefined,
        recreated.createdAt,
      );
      assert.notEqual(recreated.createdAt, reminder.createdAt);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('legacy fixed intervals fall back to createdAt without rewriting on read', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-interval-legacy-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeConfig(stateDir);
      const reminderPath = join(stateDir, 'agents', 'scout', 'reminders.json');
      const legacy = {
        createdAt: '2026-05-14T08:12:00.000Z',
        firedCount: 1,
        instructions: 'Review the queue.',
        nextDueAt: '2026-05-14T09:12:00.000Z',
        reminderId: 'rem_legacy_interval',
        schedule: { intervalMs: 3_600_000, kind: 'interval', repeatRule: 'every:1h' },
        status: 'scheduled',
        title: 'Legacy queue review',
        updatedAt: '2026-05-14T08:12:00.000Z',
      };
      await writeFile(reminderPath, `${JSON.stringify({ [legacy.reminderId]: legacy }, null, 2)}\n`, 'utf8');

      const loaded = await reminderService.findReminder(legacy.reminderId);
      assert.equal(loaded?.schedule.kind === 'interval' ? loaded.schedule.phaseAnchorAt : undefined, undefined);
      const unchanged = await readFile(reminderPath, 'utf8');
      assert.equal(unchanged, `${JSON.stringify({ [legacy.reminderId]: legacy }, null, 2)}\n`);

      const fired = await reminderService.completeReminderFire({
        id: legacy.reminderId,
        now: new Date('2026-05-14T12:45:00.000Z'),
      });
      assert.equal(fired.nextDueAt, '2026-05-14T13:12:00.000Z');
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
        ...(dueReminder.nextDueAt ? { scheduledAt: dueReminder.nextDueAt } : {}),
        title: dueReminder.title,
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
        await waitFor(() => runtime.calls.length === 1);
      } finally {
        await worker.close();
      }

      const call = runtime.calls[0];
      assert.match(call?.prompt ?? '', new RegExp(`reminder_id=${reminder.reminderId}`));
      // scheduled= reflects the intended fire time (nextDueAt), not the
      // 09:00:01 poll tick that noticed the reminder was due.
      assert.match(call?.prompt ?? '', /scheduled=2026-05-14T09:00:00Z/);

      await waitFor(async () => {
        const state = await loadState();
        return state.reminders[reminder.reminderId]?.status === 'fired';
      });
      await waitFor(async () => {
        const items = await queue.list();
        return items.length === 0;
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

test('reminder subscriber carries the human title into the inbox item and message record', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-title-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const reminder = await reminderService.scheduleReminder({
        fireAt: '2026-05-14T09:00:00.000Z',
        instructions: 'Review the launch queue.',
        now: new Date('2026-05-14T08:00:00.000Z'),
        title: 'Launch queue review',
      });

      const queue = new WakeQueueService('scout');
      const subscriber = new ReminderInboxSubscriber(queue, reminderService);
      subscriber.start();
      try {
        await waitFor(async () => {
          const items = await queue.list();
          return items.some((item) => item.kind === 'reminder' && item.reminderId === reminder.reminderId);
        });
      } finally {
        await subscriber.stop();
      }

      const item = (await queue.list()).find(
        (candidate) => candidate.kind === 'reminder' && candidate.reminderId === reminder.reminderId,
      );
      assert.ok(item);
      if (item.kind !== 'reminder') assert.fail('expected reminder inbox item');
      assert.equal(item.title, 'Launch queue review');
      assert.equal(item.reminderId, reminder.reminderId);
      // The subscriber stamps the intended fire moment before completing the fire.
      assert.equal(item.scheduledAt, '2026-05-14T09:00:00.000Z');

      const message = (await messageServiceForAgent('scout').list()).entries.find(
        (entry) => entry.reminderId === reminder.reminderId,
      );
      assert.ok(message);
      assert.equal(message.kind, 'reminder');
      assert.equal(message.reminderTitle, 'Launch queue review');
      assert.equal(message.text, 'Reminder fired: Launch queue review');
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

test('windowed interval mon-fri@08:00-18:30 / 30m has 22 inclusive grid slots per day', () => {
  const schedule = buildWindowedIntervalSchedule({
    repeatRule: 'every:30m',
    timezone: 'America/New_York',
    windowRule: 'mon-fri@08:00-18:30',
  });
  assert.equal(schedule.kind, 'windowed_interval');
  assert.deepEqual(schedule.weekdays, ['mon', 'tue', 'wed', 'thu', 'fri']);
  // Monday 2026-05-18 in America/New_York
  const monday = zonedDateTime(new Date('2026-05-18T12:00:00.000Z'), 'America/New_York').startOf('day');
  const slots = windowedSlotsOnLocalDay(schedule, monday);
  assert.equal(slots.length, 22);
  assert.equal(slots[0]?.toFormat('HH:mm'), '08:00');
  assert.equal(slots[slots.length - 1]?.toFormat('HH:mm'), '18:30');
});

test('windowed interval next-due: before/inside/end/after window and weekend skip', () => {
  const schedule = buildWindowedIntervalSchedule({
    repeatRule: 'every:30m',
    timezone: 'America/New_York',
    windowRule: 'mon-fri@08:00-18:30',
  });
  // Monday 2026-05-18: before window → 08:00 ET = 12:00Z (EDT)
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-05-18T11:00:00.000Z')),
    '2026-05-18T12:00:00.000Z',
  );
  // Inside window just after 10:00 ET (14:00Z) → next is 10:30 ET = 14:30Z
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-05-18T14:00:00.000Z')),
    '2026-05-18T14:30:00.000Z',
  );
  // Exactly on a grid tick: strictly after → next slot
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-05-18T14:30:00.000Z')),
    '2026-05-18T15:00:00.000Z',
  );
  // At inclusive end 18:30 ET = 22:30Z → next weekday morning
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-05-18T22:30:00.000Z')),
    '2026-05-19T12:00:00.000Z',
  );
  // After window Friday → Monday
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-05-22T23:00:00.000Z')),
    '2026-05-25T12:00:00.000Z',
  );
  // Saturday → Monday
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-05-23T15:00:00.000Z')),
    '2026-05-25T12:00:00.000Z',
  );
});

test('windowed interval late fire does not replay missed ticks', () => {
  const schedule = buildWindowedIntervalSchedule({
    repeatRule: 'every:30m',
    timezone: 'America/New_York',
    windowRule: 'mon-fri@08:00-18:30',
  });
  // Fire late at 11:07 ET (15:07Z) → next grid is 11:30 ET = 15:30Z, not catch-up of 11:00
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-05-18T15:07:00.000Z')),
    '2026-05-18T15:30:00.000Z',
  );
});

test('windowed interval DST: one wake per local label on spring/fall transition Sundays', () => {
  // Contract: skip nonexistent spring labels; no duplicate fall-back labels.
  const schedule = buildWindowedIntervalSchedule({
    repeatRule: 'every:30m',
    timezone: 'America/New_York',
    windowRule: 'sun@00:00-04:00',
  });

  // 2026-03-08 spring forward: 02:00–02:59 do not exist.
  const springDay = zonedDateTime(new Date('2026-03-08T12:00:00.000Z'), 'America/New_York').startOf('day');
  const springSlots = windowedSlotsOnLocalDay(schedule, springDay);
  const springLabels = springSlots.map((s) => s.toFormat('HH:mm'));
  assert.deepEqual(springLabels, ['00:00', '00:30', '01:00', '01:30', '03:00', '03:30', '04:00']);
  assert.ok(!springLabels.includes('02:00') && !springLabels.includes('02:30'));
  // Exact instants (EST → EDT):
  assert.equal(springSlots[3]?.toUTC().toISO(), '2026-03-08T06:30:00.000Z'); // 01:30 EST
  assert.equal(springSlots[4]?.toUTC().toISO(), '2026-03-08T07:00:00.000Z'); // 03:00 EDT
  // Next-due from just after 01:30 EST skips the gap to 03:00 EDT
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-03-08T06:30:00.000Z')),
    '2026-03-08T07:00:00.000Z',
  );

  // 2026-11-01 fall back: 01:00–01:59 repeat; emit each label once (earlier offset).
  const fallDay = zonedDateTime(new Date('2026-11-01T12:00:00.000Z'), 'America/New_York').startOf('day');
  const fallSlots = windowedSlotsOnLocalDay(schedule, fallDay);
  const fallLabels = fallSlots.map((s) => s.toFormat('HH:mm'));
  assert.deepEqual(fallLabels, ['00:00', '00:30', '01:00', '01:30', '02:00', '02:30', '03:00', '03:30', '04:00']);
  assert.equal(fallLabels.filter((l) => l === '01:00').length, 1);
  assert.equal(fallLabels.filter((l) => l === '01:30').length, 1);
  // 01:00 / 01:30 resolve to first (EDT) occurrence, not the EST repeat.
  assert.equal(fallSlots[2]?.toUTC().toISO(), '2026-11-01T05:00:00.000Z'); // 01:00 EDT
  assert.equal(fallSlots[3]?.toUTC().toISO(), '2026-11-01T05:30:00.000Z'); // 01:30 EDT
  assert.equal(fallSlots[4]?.toUTC().toISO(), '2026-11-01T07:00:00.000Z'); // 02:00 EST
  assert.equal(
    nextDueAtForSchedule(schedule, new Date('2026-11-01T05:00:00.000Z')),
    '2026-11-01T05:30:00.000Z',
  );
});

test('windowed interval schedule, snooze, fire resume grid without drift', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-windowed-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const now = new Date('2026-05-18T11:00:00.000Z'); // Mon before 08:00 ET
      const reminder = await reminderService.scheduleReminder({
        instructions: 'Work-hours poll',
        now,
        repeat: 'every:30m',
        timezone: 'America/New_York',
        title: 'Work-hours poll',
        window: 'mon-fri@08:00-18:30',
      });
      assert.equal(reminder.schedule.kind, 'windowed_interval');
      assert.equal(reminder.nextDueAt, '2026-05-18T12:00:00.000Z');
      if (reminder.schedule.kind !== 'windowed_interval') throw new Error('expected windowed');
      assert.equal(reminder.schedule.windowRule, 'mon-fri@08:00-18:30');
      assert.equal(reminder.schedule.timezone, 'America/New_York');

      const snoozed = await reminderService.snoozeReminder({
        by: '45m',
        id: reminder.reminderId,
        now: new Date('2026-05-18T12:05:00.000Z'),
      });
      assert.equal(snoozed.nextDueAt, '2026-05-18T12:50:00.000Z');

      const afterSnooze = await reminderService.completeReminderFire({
        id: reminder.reminderId,
        now: new Date('2026-05-18T12:50:00.000Z'),
      });
      // Back on window grid strictly after fire: 09:00 ET = 13:00Z
      assert.equal(afterSnooze.nextDueAt, '2026-05-18T13:00:00.000Z');
      assert.equal(afterSnooze.schedule.kind, 'windowed_interval');

      // Reload store: schedule + next due unchanged (no drift)
      const reloaded = await reminderService.findReminder(reminder.reminderId);
      assert.equal(reloaded?.nextDueAt, '2026-05-18T13:00:00.000Z');
      assert.equal(reloaded?.schedule.kind, 'windowed_interval');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('windowed interval rejects invalid combinations and preserves legacy interval', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-windowed-contract-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await assert.rejects(
        reminderService.scheduleReminder({
          instructions: 'x',
          now: new Date('2026-05-18T12:00:00.000Z'),
          title: 'bad',
          window: 'mon-fri@08:00-18:30',
        }),
        /--window requires --repeat/,
      );
      await assert.rejects(
        reminderService.scheduleReminder({
          instructions: 'x',
          now: new Date('2026-05-18T12:00:00.000Z'),
          repeat: 'daily@09:00',
          title: 'bad',
          timezone: 'UTC',
          window: 'mon-fri@08:00-18:30',
        }),
        /only allowed with every/,
      );
      // --fire-at / --in must not bypass the window (e.g. Saturday fire with mon-fri).
      await assert.rejects(
        reminderService.scheduleReminder({
          fireAt: '2026-05-23T15:00:00.000Z', // Saturday
          instructions: 'x',
          now: new Date('2026-05-18T12:00:00.000Z'),
          repeat: 'every:30m',
          timezone: 'America/New_York',
          title: 'bad-fire-at',
          window: 'mon-fri@08:00-18:30',
        }),
        /cannot be combined with --fire-at or --in/,
      );
      await assert.rejects(
        reminderService.scheduleReminder({
          delaySeconds: 3600,
          instructions: 'x',
          now: new Date('2026-05-23T15:00:00.000Z'), // Saturday
          repeat: 'every:30m',
          timezone: 'America/New_York',
          title: 'bad-in',
          window: 'mon-fri@08:00-18:30',
        }),
        /cannot be combined with --fire-at or --in/,
      );
      // Long intervals would restart each eligible day while UI says every 1d/12h.
      assert.throws(
        () => buildWindowedIntervalSchedule({
          repeatRule: 'every:1d',
          timezone: 'America/New_York',
          windowRule: 'mon-fri@08:00-18:30',
        }),
        /longer than the same-day window/,
      );
      assert.throws(
        () => buildWindowedIntervalSchedule({
          repeatRule: 'every:12h',
          timezone: 'America/New_York',
          windowRule: 'mon-fri@08:00-18:30',
        }),
        /longer than the same-day window/,
      );
      assert.throws(() => parseWindowRule('mon-fri@18:30-08:00'), /overnight|after start/i);
      assert.throws(() => parseWindowRule('mon-fri@08:00-08:00'), /overnight|after start/i);
      assert.throws(
        () => buildWindowedIntervalSchedule({
          repeatRule: 'every:30m',
          timezone: 'Not/AZone',
          windowRule: 'mon-fri@08:00-18:30',
        }),
        /Invalid timezone/,
      );
      assert.throws(() => parseWindowRule('funday@08:00-18:30'), /Invalid window weekdays/);

      // Legacy plain interval still works
      const legacy = await reminderService.scheduleReminder({
        instructions: 'legacy',
        now: new Date('2026-05-18T12:00:00.000Z'),
        repeat: 'every:30m',
        title: 'legacy',
      });
      assert.equal(legacy.schedule.kind, 'interval');
      assert.equal(legacy.nextDueAt, '2026-05-18T12:30:00.000Z');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('windowed next-due is red-controlled: removing window awareness breaks the 22-slot grid', () => {
  // If nextWindowedIntervalDueAt were replaced by plain interval math, this
  // Monday→weekend skip and inclusive end count would not hold.
  const schedule = buildWindowedIntervalSchedule({
    repeatRule: 'every:30m',
    timezone: 'America/New_York',
    windowRule: 'mon-fri@08:00-18:30',
  });
  const monday = zonedDateTime(new Date('2026-05-18T12:00:00.000Z'), 'America/New_York').startOf('day');
  assert.equal(windowedSlotsOnLocalDay(schedule, monday).length, 22);
  // After Friday end, plain every:30m would stay on the weekend continuum.
  const afterFridayEnd = nextDueAtForSchedule(schedule, new Date('2026-05-22T22:30:00.000Z'));
  assert.equal(afterFridayEnd, '2026-05-25T12:00:00.000Z');
  assert.match(afterFridayEnd, /^2026-05-25/);
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

test('reminder scheduling rejects both initial-time options and accepts either with repeat', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-reminder-contract-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await assert.rejects(
        reminderService.scheduleReminder({
          delaySeconds: 60,
          fireAt: '2026-05-14T09:00:00.000Z',
          instructions: 'Invalid schedule.',
          now: new Date('2026-05-14T08:00:00.000Z'),
          repeat: 'every:1h',
          title: 'Invalid schedule',
        }),
        /only one of fireAt or delaySeconds/,
      );

      const delayed = await reminderService.scheduleReminder({
        delaySeconds: 30 * 60,
        instructions: 'Delayed recurring schedule.',
        now: new Date('2026-05-14T08:00:00.000Z'),
        repeat: 'every:1h',
        title: 'Delayed recurring schedule',
      });
      assert.equal(delayed.nextDueAt, '2026-05-14T08:30:00.000Z');

      const dated = await reminderService.scheduleReminder({
        fireAt: '2026-05-14T10:15:00.000Z',
        instructions: 'Dated recurring schedule.',
        now: new Date('2026-05-14T08:00:00.000Z'),
        repeat: 'every:1h',
        title: 'Dated recurring schedule',
      });
      assert.equal(dated.nextDueAt, '2026-05-14T10:15:00.000Z');
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

test('every reminder schedule help example passes the real CLI scheduling contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-reminder-cli-help-'));
  const configDir = join(root, '.anima');
  try {
    await writeConfig(configDir);
    const env = { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: configDir, ANIMA_INBOX_ITEM_ID: '' };
    for (const args of REMINDER_SCHEDULE_EXAMPLES) {
      const result = await runNode([cliPath, 'reminder', 'schedule', ...args], { env });
      assert.equal(result.status, 0, `${reminderScheduleExampleCommand(args)}\n${result.stderr || result.stdout}`);
      assert.match(result.stdout, /^scheduled successfully\./);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('reminder CLI show and JSON inspection are complete, stable, and stdout-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-reminder-inspection-'));
  const configDir = join(root, '.anima');
  try {
    await writeConfig(configDir);
    const env = { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: configDir, ANIMA_INBOX_ITEM_ID: '' };
    const service = reminderServiceForAgent('scout');
    const instructions = [
      'Read the complete incident timeline.',
      'Preserve this final sentinel exactly: INSPECTION_END_585',
    ].join('\n');

    let recurringId = '';
    let intervalId = '';
    let firedId = '';
    let cancelledId = '';
    await withAnimaHome(configDir, async () => {
      const recurring = await service.scheduleReminder({
        instructions,
        now: new Date('2026-07-01T00:00:00.000Z'),
        provenance: {
          channelId: 'C012INSPECT',
          messageTs: '1782864000.000100',
          threadTs: '1782863900.000001',
        },
        repeat: 'weekly:mon,fri@10:30',
        timezone: 'Asia/Shanghai',
        title: 'Inspect incident follow-up',
      });
      recurringId = recurring.reminderId;

      const interval = await service.scheduleReminder({
        delaySeconds: 10 * 60,
        instructions: 'Inspect the hourly queue.',
        now: new Date('2026-07-01T00:00:00.000Z'),
        repeat: 'every:1h',
        title: 'Hourly inspection',
      });
      intervalId = interval.reminderId;

      const fired = await service.scheduleReminder({
        fireAt: '2026-07-01T01:00:00.000Z',
        instructions: 'One-shot fired instructions.',
        now: new Date('2026-07-01T00:00:00.000Z'),
        title: 'Fired once',
      });
      firedId = fired.reminderId;
      await service.completeReminderFire({
        id: firedId,
        now: new Date('2026-07-01T01:00:01.000Z'),
      });

      const cancelled = await service.scheduleReminder({
        delaySeconds: 3600,
        instructions: 'Cancelled instructions.',
        now: new Date('2026-07-01T00:00:00.000Z'),
        title: 'Cancelled once',
      });
      cancelledId = cancelled.reminderId;
      await service.cancelReminder({
        id: cancelledId,
        now: new Date('2026-07-01T00:05:00.000Z'),
      });
    });

    const shown = await runNode([cliPath, 'reminder', 'show', recurringId], { env });
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    assert.equal(shown.stderr, '');
    assert.match(shown.stdout, /INSPECTION_END_585/);
    assert.match(shown.stdout, /"threadTs":"1782863900\.000001"/);
    assert.match(shown.stdout, /"repeatRule":"weekly:mon,fri@10:30"/);
    assert.match(shown.stdout, /fired_count: 0/);

    const shownByPosition = await runNode([cliPath, 'reminder', 'show', recurringId, '--json'], { env });
    assert.equal(shownByPosition.status, 0, shownByPosition.stderr || shownByPosition.stdout);
    assert.equal(shownByPosition.stderr, '');

    const shownByFlag = await runNode([cliPath, 'reminder', 'show', '--id', recurringId, '--json'], { env });
    assert.equal(shownByFlag.status, 0, shownByFlag.stderr || shownByFlag.stdout);
    assert.equal(shownByFlag.stderr, '');
    assert.equal(shownByFlag.stdout, shownByPosition.stdout);

    const shownByIdenticalIds = await runNode(
      [cliPath, 'reminder', 'show', recurringId, '--id', recurringId, '--json'],
      { env },
    );
    assert.equal(
      shownByIdenticalIds.status,
      0,
      shownByIdenticalIds.stderr || shownByIdenticalIds.stdout,
    );
    assert.equal(shownByIdenticalIds.stderr, '');
    assert.equal(shownByIdenticalIds.stdout, shownByPosition.stdout);

    const shownByConflictingIds = await runNode(
      [cliPath, 'reminder', 'show', recurringId, '--id', intervalId, '--json'],
      { env },
    );
    assert.equal(shownByConflictingIds.status, 1);
    assert.equal(shownByConflictingIds.stdout, '');
    assert.match(shownByConflictingIds.stderr, /error input\.invalid_options \(not retryable\)/);
    assert.match(
      shownByConflictingIds.stderr,
      /Reminder id must match when passed both positionally and with --id/,
    );

    const publicReminder = JSON.parse(shownByFlag.stdout) as Record<string, unknown>;
    assert.equal(publicReminder['instructions'], instructions);
    assert.equal(publicReminder['reminderId'], recurringId);
    assert.deepEqual(publicReminder['provenance'], {
      channelId: 'C012INSPECT',
      messageTs: '1782864000.000100',
      threadTs: '1782863900.000001',
    });
    assert.deepEqual(publicReminder['schedule'], {
      kind: 'weekly',
      repeatRule: 'weekly:mon,fri@10:30',
      time: '10:30',
      timezone: 'Asia/Shanghai',
      weekdays: ['mon', 'fri'],
    });

    const listed = await runNode(
      [cliPath, 'reminder', 'list', '--status', 'scheduled,fired,cancelled', '--json'],
      { env },
    );
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.equal(listed.stderr, '');
    const publicList = JSON.parse(listed.stdout) as Array<Record<string, unknown>>;
    assert.equal(publicList.length, 4);
    assert.deepEqual(publicList.find((item) => item['reminderId'] === recurringId), publicReminder);
    assert.deepEqual(publicList.find((item) => item['reminderId'] === intervalId)?.['schedule'], {
      intervalMs: 3_600_000,
      kind: 'interval',
      phaseAnchorAt: '2026-07-01T00:10:00.000Z',
      repeatRule: 'every:1h',
    });
    assert.equal(publicList.find((item) => item['reminderId'] === firedId)?.['status'], 'fired');
    assert.equal(publicList.find((item) => item['reminderId'] === firedId)?.['firedCount'], 1);
    assert.equal(publicList.find((item) => item['reminderId'] === cancelledId)?.['status'], 'cancelled');
    assert.equal(typeof publicList.find((item) => item['reminderId'] === cancelledId)?.['cancelledAt'], 'string');

    const missing = await runNode([cliPath, 'reminder', 'show', 'rem_missing', '--json'], { env });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /Reminder not found: rem_missing/);

    const missingId = await runNode([cliPath, 'reminder', 'show', '--json'], { env });
    assert.equal(missingId.status, 1);
    assert.equal(missingId.stdout, '');
    assert.match(missingId.stderr, /error input\.invalid_options/);
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
