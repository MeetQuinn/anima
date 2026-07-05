import { describe, expect, it } from 'vitest';

import { activityRow } from './activities';
import type { Activity } from '@shared/activity';

function activity(payload: Record<string, unknown>): Activity {
  return {
    activityId: 'actv_skill',
    createdAt: '2026-07-05T14:00:00.000Z',
    payload,
    type: 'tool.call.started',
  };
}

describe('activityRow', () => {
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
    expect(row.targetFull).toBe('deep-research\n\nresearch usage telemetry and summarize with citations');
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
