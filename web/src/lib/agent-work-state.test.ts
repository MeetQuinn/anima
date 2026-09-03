import { describe, expect, it } from 'vitest';

import type { AgentStatusSummary } from '@shared/snapshot';
import { agentWorkState, agentWorkStateLabel } from './agent-work-state';

function status(overrides: Partial<AgentStatusSummary> = {}): AgentStatusSummary {
  return {
    agentId: 'milo',
    itemCount: 0,
    queueDepth: 0,
    ...overrides,
  };
}

describe('agentWorkState', () => {
  it('shows native provider work even after the Anima queue item completed', () => {
    const background = agentWorkState(status({
      health: {
        runtime: {
          providerChildExpected: false,
          providerWork: { backgroundTaskCount: 2, state: 'background' },
        },
        state: 'healthy',
        updatedAt: '2026-09-01T08:00:00.000Z',
      },
    }));

    expect(background).toEqual({ backgroundTaskCount: 2, state: 'background' });
    expect(agentWorkStateLabel(background)).toBe('Background · 2');
  });

  it('shows a provider-native rewake as working without inventing a current item', () => {
    expect(agentWorkState(status({
      health: {
        runtime: {
          providerChildExpected: false,
          providerWork: { state: 'working' },
        },
        state: 'healthy',
        updatedAt: '2026-09-01T08:00:00.000Z',
      },
    }))).toEqual({ state: 'working' });
  });

  it('keeps current work ahead of background, then falls back to queued and idle', () => {
    const workingWithBackground = agentWorkState(status({
      currentItemId: 'item-1',
      health: {
        runtime: {
          providerChildExpected: false,
          providerWork: { backgroundTaskCount: 1, state: 'background' },
        },
        state: 'healthy',
        updatedAt: '2026-09-01T08:00:00.000Z',
      },
    }));
    expect(workingWithBackground).toEqual({ backgroundTaskCount: 1, state: 'working' });
    expect(agentWorkStateLabel(workingWithBackground)).toBe('Working · Background 1');
    expect(agentWorkState(status({ queueDepth: 1 }))).toEqual({ state: 'queued' });
    expect(agentWorkState(status())).toEqual({ state: 'idle' });
  });
});
