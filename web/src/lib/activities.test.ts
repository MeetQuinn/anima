import { describe, expect, it } from 'vitest';

import { activityRow, isNarrativeStep } from './activities';
import type { Activity } from '@shared/activity';

function activity(
  payload: Record<string, unknown>,
  type: Activity['type'] = 'tool.call.started',
): Activity {
  return {
    activityId: 'actv_skill',
    createdAt: '2026-07-05T14:00:00.000Z',
    payload,
    type,
  };
}

describe('activityRow', () => {
  it.each([
    [
      'Slack message send',
      'external.effect.completed',
      { effect: 'slack.message.send' },
      { title: 'Slack message send', color: 'var(--color-activity-tool)', kind: 'tool' },
    ],
    [
      'Slack message update',
      'external.effect.completed',
      { effect: 'slack.message.update' },
      { title: 'Slack message update', color: 'var(--color-activity-tool)', kind: 'tool' },
    ],
    [
      'Slack file send',
      'external.effect.completed',
      { channelName: 'build', effect: 'slack.file.send', fileCount: 2 },
      { title: 'Sent 2 files', target: '#build', color: 'var(--color-activity-tool)', kind: 'tool' },
    ],
    [
      'Slack reaction',
      'external.effect.completed',
      { effect: 'slack.reaction' },
      { title: 'Slack reaction', color: 'var(--color-activity-tool)', kind: 'tool' },
    ],
  ])('keeps existing %s narrative row shape', (_label, type, payload, expected) => {
    const record = activity(payload, type);

    expect(isNarrativeStep(record)).toBe(true);
    expect(activityRow(record)).toEqual(expected);
  });

  it.each([
    [
      'Feishu message send',
      { effect: 'feishu.message.send' },
      { title: 'Feishu message send', color: 'var(--color-activity-tool)', kind: 'tool' },
    ],
    [
      'Feishu message update',
      { effect: 'feishu.message.update' },
      { title: 'Feishu message update', color: 'var(--color-activity-tool)', kind: 'tool' },
    ],
    [
      'Feishu file send',
      { channel: 'oc_123', effect: 'feishu.file.send' },
      { title: 'Sent file', target: 'oc_123', color: 'var(--color-activity-tool)', kind: 'tool' },
    ],
    [
      'Feishu reaction',
      { effect: 'feishu.reaction' },
      { title: 'Feishu reaction', color: 'var(--color-activity-tool)', kind: 'tool' },
    ],
  ])('shows %s narrative row via shared outbound classification', (_label, payload, expected) => {
    const record = activity(payload, 'external.effect.completed');

    expect(isNarrativeStep(record)).toBe(true);
    expect(activityRow(record)).toEqual(expected);
  });

  it.each([
    ['message send', { tool: 'anima.message.send' }, 'Message failed'],
    ['message send effect', { effect: 'slack.message.send' }, 'Message failed'],
    ['message update', { tool: 'anima.message.update' }, 'Edit failed'],
    ['message update effect', { effect: 'slack.message.update' }, 'Edit failed'],
    ['file send', { tool: 'anima.file.send' }, 'File upload failed'],
    ['file send effect', { effect: 'slack.file.send' }, 'File upload failed'],
    ['reaction', { tool: 'anima.message.react' }, 'Reaction failed'],
    ['reaction effect', { effect: 'slack.reaction' }, 'Reaction failed'],
    ['reminder schedule', { tool: 'anima.reminder.schedule' }, 'Reminder schedule failed'],
  ])('keeps existing Slack/reminder failure row shape for %s', (_label, payload, title) => {
    const record = activity({ ...payload, error: 'platform rejected request' }, 'external.effect.failed');

    expect(isNarrativeStep(record)).toBe(true);
    expect(activityRow(record)).toEqual({
      title,
      target: 'platform rejected request',
      color: 'var(--color-health-error)',
      kind: 'failure',
    });
  });

  it.each([
    ['message send', { effect: 'feishu.message.send' }, 'Message failed'],
    ['message update', { effect: 'feishu.message.update' }, 'Edit failed'],
    ['file send', { effect: 'feishu.file.send' }, 'File upload failed'],
    ['reaction', { effect: 'feishu.reaction' }, 'Reaction failed'],
  ])('labels Feishu outbound failure row for %s', (_label, payload, title) => {
    const record = activity({ ...payload, error: 'Feishu rejected request' }, 'external.effect.failed');

    expect(isNarrativeStep(record)).toBe(true);
    expect(activityRow(record)).toEqual({
      title,
      target: 'Feishu rejected request',
      color: 'var(--color-health-error)',
      kind: 'failure',
    });
  });

  it('shows Claude skill name and args', () => {
    const row = activityRow(activity({
      args: 'research usage telemetry and summarize with citations',
      providerToolName: 'Skill',
      skill: 'deep-research',
      target: 'deep-research',
      tool: 'claude.Skill',
    }));

    expect(row.title).toBe('Ran skill');
    expect(row.target).toBe('deep-research · research usage telemetry and summarize with citations');
    expect(row.targetFull).toBeUndefined();
  });

  it('expands skill args only when the inline row is truncated', () => {
    const args = 'summarize '.repeat(35).trim();
    const row = activityRow(activity({
      args,
      providerToolName: 'Skill',
      skill: 'deep-research',
      target: 'deep-research',
      tool: 'claude.Skill',
    }));

    expect(row.title).toBe('Ran skill');
    expect(row.target).toMatch(/^deep-research · summarize /);
    expect(row.target).toMatch(/…$/);
    expect(row.targetFull).toBe(`deep-research\n\n${args}`);
  });

  it('keeps the legacy name fallback for older skill records', () => {
    const row = activityRow(activity({
      name: 'Research ServiceTitan Intacct export mechanics',
      providerToolName: 'Skill',
      tool: 'claude.Skill',
    }));

    expect(row.title).toBe('Ran skill');
    expect(row.target).toBe('Research ServiceTitan Intacct export mechanics');
    expect(row.targetFull).toBeUndefined();
  });
});
