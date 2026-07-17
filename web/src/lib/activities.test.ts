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

  it.each([
    [
      'created task',
      { providerToolName: 'TaskCreate', taskSubject: 'Trace task activity', tool: 'claude.TaskCreate' },
      { title: 'Created task', target: 'Trace task activity' },
    ],
    [
      'started task',
      { providerToolName: 'TaskUpdate', taskActiveForm: 'Tracing task activity', taskId: '7', taskStatus: 'in_progress', tool: 'claude.TaskUpdate' },
      { title: 'Started task', target: '#7 · Tracing task activity' },
    ],
    [
      'completed task',
      { providerToolName: 'TaskUpdate', taskId: '7', taskStatus: 'completed', tool: 'claude.TaskUpdate' },
      { title: 'Completed task', target: '#7' },
    ],
    [
      'deleted task',
      { providerToolName: 'TaskUpdate', taskId: '7', taskStatus: 'deleted', tool: 'claude.TaskUpdate' },
      { title: 'Deleted task', target: '#7' },
    ],
  ])('shows the identity and state for a Claude %s', (_label, payload, expected) => {
    const row = activityRow(activity(payload));

    expect(row).toMatchObject({
      ...expected,
      color: 'var(--color-activity-tool)',
      kind: 'tool',
    });
    expect(isNarrativeStep(activity(payload))).toBe(true);
  });

  it('shows the active Codex plan step and expands to the full plan', () => {
    const record = activity({
      eventType: 'codex.plan.updated',
      explanation: 'Plan changed',
      plan: [
        { step: 'Read provider', status: 'completed' },
        { step: 'Record events', status: 'inProgress' },
        { step: 'Verify Activity', status: 'pending' },
      ],
    }, 'runtime.event');

    expect(isNarrativeStep(record)).toBe(true);
    expect(activityRow(record)).toEqual({
      title: 'Updated plan',
      target: '1/3 complete · Record events',
      targetFull: '[done] Read provider\n[active] Record events\n[todo] Verify Activity',
      color: 'var(--color-activity-tool)',
      kind: 'tool',
    });
  });

  it('shows Grok ReadFile / ListDir targets in the narrative step row', () => {
    const read = activity({
      providerToolName: 'ReadFile',
      target: 'shared/provider-catalog.ts',
      tool: 'grok.ReadFile',
    });
    expect(isNarrativeStep(read)).toBe(true);
    expect(activityRow(read)).toEqual({
      title: 'Read',
      target: 'shared/provider-catalog.ts',
      color: 'var(--color-activity-tool)',
      kind: 'tool',
    });

    const list = activity({
      providerToolName: 'ListDir',
      target: 'server/providers',
      tool: 'grok.ListDir',
    });
    expect(isNarrativeStep(list)).toBe(true);
    expect(activityRow(list)).toEqual({
      title: 'Listed',
      target: 'server/providers',
      color: 'var(--color-activity-tool)',
      kind: 'tool',
    });
  });

  it('shows Codex web search query from nested action payloads', () => {
    expect(activityRow(activity({
      action: { query: 'activity tab\nsearched row query' },
      providerToolName: 'webSearch',
      tool: 'codex.webSearch',
    }))).toEqual({
      title: 'Searched',
      target: 'activity tab searched row query',
      color: 'var(--color-activity-tool)',
      kind: 'tool',
    });
  });

  it('shows Codex web search fallback details from nested action payloads', () => {
    expect(activityRow(activity({
      action: { queries: ['first query', 'second query', 'third query', 'ignored query'] },
      providerToolName: 'webSearch',
      tool: 'codex.webSearch',
    })).target).toBe('first query / second query / third query');

    expect(activityRow(activity({
      action: { pattern: 'rate limit', url: 'https://docs.example/search' },
      providerToolName: 'webSearch',
      tool: 'codex.webSearch',
    })).target).toBe('rate limit in https://docs.example/search');
  });
});
