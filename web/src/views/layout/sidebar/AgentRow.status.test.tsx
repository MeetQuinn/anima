import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { agentConfigSchema } from '@shared/agent-config';
import type { AgentStatusSummary } from '@shared/snapshot';
import { AgentRow } from './AgentRow';

const agent = agentConfigSchema('milo').parse({
  id: 'milo',
  profile: { displayName: 'Milo', role: 'Engineering lead' },
  slack: { appToken: 'xapp-test', botToken: 'xoxb-test' },
});

function healthyStatus(state: 'background' | 'working'): AgentStatusSummary {
  return {
    agentId: 'milo',
    health: {
      runtime: {
        providerChildExpected: false,
        providerWork: { backgroundTaskCount: 2, state },
      },
      state: 'healthy',
      updatedAt: '2026-09-01T08:00:00.000Z',
    },
    itemCount: 1,
    queueDepth: 0,
  };
}

describe('AgentRow provider work status', () => {
  it('keeps Background static and only animates active Working state', () => {
    const view = render(
      <AgentRow
        active={false}
        agent={agent}
        enabled
        index={0}
        onClick={() => {}}
        status={healthyStatus('background')}
      />,
    );

    expect(view.container.querySelector('[title="background · 2"]')).toBeTruthy();
    expect(view.container.querySelector('.anima-dot-halo')).toBeNull();

    view.rerender(
      <AgentRow
        active={false}
        agent={agent}
        enabled
        index={0}
        onClick={() => {}}
        status={healthyStatus('working')}
      />,
    );

    expect(view.container.querySelector('[title="working"]')).toBeTruthy();
    expect(view.container.querySelector('.anima-dot-halo')).toBeTruthy();
  });
});
