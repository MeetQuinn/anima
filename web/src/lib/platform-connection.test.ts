import { describe, expect, it } from 'vitest';
import type { AgentRuntimeHealthSummary, LinearConnectionSummary } from '@shared/snapshot';
import { agentConnectionDisplay, linearConnectionDisplay } from './platform-connection';

const now = Date.parse('2026-11-04T01:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const linear = (overrides: Partial<LinearConnectionSummary> = {}): LinearConnectionSummary => ({
  state: 'connected',
  listener: 'listening',
  ...overrides,
});
const slackDown: AgentRuntimeHealthSummary = {
  state: 'healthy',
  updatedAt: iso(now),
  runtime: {
    providerChildExpected: false,
    transports: {
      slack: { state: 'failed', since: iso(now - 60_000), observedAt: iso(now), attempts: 3, reason: 'invalid_auth' },
    },
  },
};
const slackUp: AgentRuntimeHealthSummary = {
  ...slackDown,
  runtime: {
    providerChildExpected: false,
    transports: { slack: { state: 'connected', since: iso(now - 60_000), observedAt: iso(now), attempts: 1 } },
  },
};

describe('Linear connection display', () => {
  it('is absent without an installation', () => {
    expect(linearConnectionDisplay(undefined, now)).toBeUndefined();
  });

  it('is normal while listening, with the last event when there was one', () => {
    expect(linearConnectionDisplay(linear({ lastSignedWebhookAt: iso(now - 5 * 60_000) }), now)).toEqual({
      label: 'Linear connected',
      detail: 'Last event 5 min ago.',
      severity: 'normal',
    });
    expect(linearConnectionDisplay(linear(), now)?.detail).toBe('No Linear events received yet.');
    // Unknown and stopped are what Profile shows without an alert: the runtime is starting or down,
    // and the runtime's own health says so.
    expect(linearConnectionDisplay(linear({ listener: 'unknown' }), now)?.severity).toBe('normal');
    expect(linearConnectionDisplay(linear({ listener: 'stopped' }), now)?.severity).toBe('normal');
  });

  it('calls out what stops the agent hearing Linear, revocation first', () => {
    expect(linearConnectionDisplay(linear({ listener: 'failed' }), now)).toMatchObject({ label: 'Linear not receiving', severity: 'error' });
    expect(linearConnectionDisplay(linear({ clientRejected: true, listener: 'failed' }), now)).toMatchObject({ label: 'Linear credentials not accepted', severity: 'error' });
    expect(linearConnectionDisplay(linear({ state: 'revoked', clientRejected: true }), now)).toMatchObject({ label: 'Linear access revoked', severity: 'error' });
  });
});

describe('Agent connection display across platforms', () => {
  it('shows a Linear-only agent its Linear problem', () => {
    expect(agentConnectionDisplay({ linear: linear({ listener: 'failed' }) }, now)).toMatchObject({ label: 'Linear not receiving', severity: 'error' });
  });

  it('shows the problem when the other platform is fine', () => {
    expect(agentConnectionDisplay({ health: slackUp, linear: linear({ listener: 'failed' }) }, now)?.label).toBe('Linear not receiving');
    expect(agentConnectionDisplay({ health: slackDown, linear: linear() }, now)?.label).toBe('Slack disconnected');
  });

  it('names every platform with a problem, the worst first', () => {
    const warning = { ...slackDown, runtime: { ...slackDown.runtime!, transports: { slack: { ...slackDown.runtime!.transports!.slack!, state: 'connecting' as const, disconnectedAt: iso(now - 10_000) } } } };
    expect(agentConnectionDisplay({ health: warning, linear: linear({ state: 'revoked' }) }, now)).toMatchObject({
      label: 'Linear access revoked · Slack connecting',
      severity: 'error',
    });
  });

  it('is a normal line when everything is fine, and absent without any platform', () => {
    expect(agentConnectionDisplay({ health: slackUp, linear: linear() }, now)?.severity).toBe('normal');
    expect(agentConnectionDisplay(undefined, now)).toBeUndefined();
  });
});
