import type { AgentConfig } from '../../shared/agent-config.js';
import type { Reminder, ReminderSchedule } from '../../shared/reminder.js';
import type { AgentStatusSummary } from '../../shared/snapshot.js';
import {
  SLACK_STOP_CONFIRM_VIEW_CALLBACK_ID,
  SLACK_VIEW_REMINDER_DETAIL_ACTION_ID,
  SLACK_VIEW_REMINDERS_ACTION_ID,
} from './shortcut-ids.js';

type MrkdwnText = { type: 'mrkdwn'; text: string };
type PlainText = { type: 'plain_text'; text: string; emoji?: boolean };
type ImageElement = { type: 'image'; image_url: string; alt_text: string };
type ButtonElement = {
  type: 'button';
  text: PlainText;
  action_id: string;
  value?: string;
};

type SectionAccessory = ImageElement | ButtonElement;

type ShortcutModalBlock =
  | { type: 'section'; text: MrkdwnText; accessory?: SectionAccessory }
  | { type: 'context'; elements: Array<MrkdwnText> }
  | { type: 'header'; text: PlainText }
  | { type: 'divider' }
  | { type: 'actions'; elements: ButtonElement[] };

export type ShortcutModalView = {
  blocks: ShortcutModalBlock[];
  callback_id?: string;
  close?: PlainText;
  private_metadata?: string;
  submit?: PlainText;
  title: PlainText;
  type: 'modal';
};

export interface ShortcutModalInput {
  callbackId?: string;
  close?: string;
  context?: string;
  lines: string[];
  privateMetadata?: string;
  submit?: string;
  title: string;
}

interface StopConfirmMetadata {
  itemId?: string;
}

export function homeView(
  agent: AgentConfig,
  status: AgentStatusSummary,
  reminders: Reminder[],
  now: Date,
): ShortcutModalView {
  const displayName = agent.profile.displayName;
  const role = agent.profile.role;
  const state: 'idle' | 'busy' | 'queued' = status.currentItemId
    ? 'busy'
    : status.queueDepth > 0
      ? 'queued'
      : 'idle';

  const blocks: ShortcutModalBlock[] = [];

  const identityText = role.trim()
    ? `*${escapeMrkdwn(displayName)}*\n${escapeMrkdwn(role)}`
    : `*${escapeMrkdwn(displayName)}*`;
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: identityText } });

  if (agent.owner) {
    const ownerLabel = agent.owner.handle
      ? `@${escapeMrkdwn(agent.owner.handle)}`
      : escapeMrkdwn(agent.owner.displayName);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Owner: ${ownerLabel}` }],
    });
  }

  blocks.push({ type: 'divider' });

  const statusEmoji = state === 'busy' ? ':gear:' : state === 'queued' ? ':hourglass_flowing_sand:' : ':white_check_mark:';
  const statusLabel = state === 'busy' ? 'Working' : state === 'queued' ? 'Queued' : 'Idle';
  const elapsed = state === 'busy' && status.currentItemStartedAt
    ? `  ·  ${elapsedLabel(status.currentItemStartedAt, now)}`
    : '';
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `${statusEmoji}  *${statusLabel}*${elapsed}` },
  });

  blocks.push({ type: 'divider' });

  if (reminders.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':alarm_clock:  *Reminders*\n_None scheduled_' },
    });
  } else {
    const next = reminders[0]!;
    const nextDue = next.nextDueAt ? humanDueLabel(next.nextDueAt, now) : '';
    const preview = nextDue
      ? `_Next: "${escapeMrkdwn(next.title)}"  ·  ${nextDue}_`
      : `_${escapeMrkdwn(next.title)}_`;
    const count = reminders.length;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:alarm_clock:  *Reminders*  ·  ${count} scheduled\n${preview}`,
      },
    });
    blocks.push({
      type: 'actions',
      elements: [{
        action_id: SLACK_VIEW_REMINDERS_ACTION_ID,
        text: { emoji: true, text: `View all (${count})  →`, type: 'plain_text' },
        type: 'button',
      }],
    });
  }

  return {
    blocks,
    close: { text: 'Close', type: 'plain_text' },
    ...(state === 'busy' ? {
      callback_id: SLACK_STOP_CONFIRM_VIEW_CALLBACK_ID,
      private_metadata: JSON.stringify({ itemId: status.currentItemId } satisfies StopConfirmMetadata),
      submit: { text: 'Stop', type: 'plain_text' },
    } : {}),
    title: { text: 'Home', type: 'plain_text' },
    type: 'modal',
  };
}

export function remindersView(reminders: Reminder[], now: Date): ShortcutModalView {
  const blocks: ShortcutModalBlock[] = [];

  if (reminders.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No reminders scheduled._' },
    });
  } else {
    for (const reminder of reminders) {
      const due = reminder.nextDueAt ? humanDueLabel(reminder.nextDueAt, now) : '';
      const recurrence = scheduleLabel(reminder.schedule);
      const meta = [due, recurrence].filter(Boolean).join('  ·  ');
      blocks.push({
        accessory: {
          action_id: SLACK_VIEW_REMINDER_DETAIL_ACTION_ID,
          text: { emoji: false, text: 'View →', type: 'plain_text' },
          type: 'button',
          value: reminder.reminderId,
        },
        text: {
          text: `*${escapeMrkdwn(reminder.title)}*${meta ? `\n_${escapeMrkdwn(meta)}_` : ''}`,
          type: 'mrkdwn',
        },
        type: 'section',
      });
    }
  }

  return {
    blocks,
    close: { text: 'Close', type: 'plain_text' },
    title: { text: 'Reminders', type: 'plain_text' },
    type: 'modal',
  };
}

export function reminderDetailView(reminder: Reminder, now: Date): ShortcutModalView {
  const blocks: ShortcutModalBlock[] = [];

  const due = reminder.nextDueAt ? humanDueLabel(reminder.nextDueAt, now) : '';
  const recurrence = scheduleLabel(reminder.schedule);
  const meta = [due, recurrence].filter(Boolean).join('  ·  ');

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${escapeMrkdwn(reminder.title)}*${meta ? `\n_${escapeMrkdwn(meta)}_` : ''}`,
    },
  });

  const SECTION_LIMIT = 2900;
  if (reminder.instructions.trim()) {
    const escaped = escapeMrkdwn(reminder.instructions);
    const text = escaped.length > SECTION_LIMIT
      ? `${escaped.slice(0, SECTION_LIMIT)}…`
      : escaped;
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text },
    });
  }

  return {
    blocks,
    close: { text: 'Close', type: 'plain_text' },
    title: { text: 'Reminder', type: 'plain_text' },
    type: 'modal',
  };
}

export function shortcutModal(input: ShortcutModalInput): ShortcutModalView {
  type LegacyBlock =
    | { type: 'section'; text: MrkdwnText }
    | { type: 'context'; elements: Array<MrkdwnText> };
  const blocks: LegacyBlock[] = [
    ...input.lines.map((line): { type: 'section'; text: MrkdwnText } => ({
      text: { text: line, type: 'mrkdwn' },
      type: 'section',
    })),
    ...(input.context ? [{
      elements: [{ text: input.context, type: 'mrkdwn' as const }],
      type: 'context' as const,
    }] : []),
  ];
  return {
    blocks,
    ...(input.callbackId ? { callback_id: input.callbackId } : {}),
    close: { text: input.close ?? 'Close', type: 'plain_text' },
    ...(input.privateMetadata ? { private_metadata: input.privateMetadata } : {}),
    ...(input.submit ? { submit: { text: input.submit, type: 'plain_text' } } : {}),
    title: { text: input.title.slice(0, 24), type: 'plain_text' },
    type: 'modal',
  };
}

function humanDueLabel(dueAt: string, now: Date): string {
  const ms = Date.parse(dueAt) - now.getTime();
  if (ms < 0) return 'overdue';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return 'in <1m';
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `in ${d}d ${rh}h` : `in ${d}d`;
}

function scheduleLabel(schedule: ReminderSchedule): string {
  switch (schedule.kind) {
    case 'once': return 'once';
    case 'daily': return 'repeating daily';
    case 'weekly': return `weekly ${schedule.weekdays.slice(0, 3).join('/')}`;
    case 'interval': {
      const ms = schedule.intervalMs;
      if (ms < 3_600_000) return `every ${Math.round(ms / 60_000)}m`;
      if (ms < 86_400_000) return `every ${Math.round(ms / 3_600_000)}h`;
      return `every ${Math.round(ms / 86_400_000)}d`;
    }
  }
}

function elapsedLabel(startedAt: string, now: Date): string {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return 'elapsed unknown';
  const seconds = Math.max(0, Math.floor((now.getTime() - startedMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export function escapeMrkdwn(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
