import { describe, expect, it } from 'vitest';
import type { AgentRuntimeHealthSummary, SlackConnectionSnapshot } from '@shared/snapshot';
import { slackConnectionDisplay } from './slack-connection';
const now = Date.parse('2026-10-23T08:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
function health(overrides: Partial<SlackConnectionSnapshot> = {}): AgentRuntimeHealthSummary {
  return {
    state: 'healthy',
    updatedAt: iso(now),
    runtime: {
      providerChildExpected: false,
      transports: {
        slack: {
          state: 'reconnecting',
          since: iso(now - 480_000),
          observedAt: iso(now),
          disconnectedAt: iso(now - 480_000),
          attempts: 4,
          reason: 'invalid_auth',
          retryAt: iso(now + 120_000),
          ...overrides,
        },
      },
    },
  };
}
describe('Slack connection display', () => {
  it('keeps long disconnects visible with duration, error and the next retry', () => {
    expect(slackConnectionDisplay(health(), now)).toEqual({
      label: 'Slack disconnected',
      severity: 'error',
      detail:
        'Disconnected for 8m. Last error: invalid_auth. 4 connection attempts. Next retry in 2m.',
    });
    expect(
      slackConnectionDisplay(health({ disconnectedAt: iso(now - 299_999) }), now)?.severity,
    ).toBe('warning');
    expect(
      slackConnectionDisplay(health({ disconnectedAt: iso(now - 300_000) }), now)?.severity,
    ).toBe('error');
  });
  it('uses the singular for the first connection attempt', () => {
    expect(slackConnectionDisplay(health({ attempts: 1 }), now)?.detail).toContain(
      '1 connection attempt.',
    );
  });
  it('distinguishes terminal failures and stopped listeners from automatic retries', () => {
    expect(slackConnectionDisplay(health({ state: 'failed' }), now)?.detail).toContain(
      'Automatic retries stopped',
    );
    expect(slackConnectionDisplay(health({ state: 'stopped' }), now)?.label).toBe('Slack stopped');
    expect(
      slackConnectionDisplay(health({ state: 'connecting', disconnectedAt: undefined }), now)
        ?.label,
    ).toBe('Slack connecting');
  });
  it('clears warnings on recovery and never treats stale snapshots as proof of connection', () => {
    expect(slackConnectionDisplay(health({ state: 'connected' }), now)?.severity).toBe('normal');
    expect(
      slackConnectionDisplay(health({ state: 'connected', observedAt: iso(now - 30_001) }), now)
        ?.label,
    ).toBe('Slack status unavailable');
    expect(
      slackConnectionDisplay({ ...health({ state: 'connected' }), reason: 'start_failed' }, now)
        ?.label,
    ).toBe('Slack status unavailable');
    expect(slackConnectionDisplay(undefined, now)).toBeUndefined();
    expect(slackConnectionDisplay({ state: 'healthy', updatedAt: iso(now) }, now)).toBeUndefined();
  });
});
