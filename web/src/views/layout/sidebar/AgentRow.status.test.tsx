import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { agentConfigSchema } from '@shared/agent-config';
import type { AgentRuntimeHealthSummary, AgentStatusSummary } from '@shared/snapshot';
import { AgentRow, sidebarAnimatesWorking, sidebarDotColor, sidebarUsesBackgroundRing } from './AgentRow';

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

const healthy: AgentRuntimeHealthSummary = {
  state: 'healthy',
  updatedAt: '2026-09-01T08:00:00.000Z',
};

describe('AgentRow provider work status', () => {
  it('uses a static ring for Background and only animates active Working state', () => {
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

    const background = view.container.querySelector<HTMLElement>('[title="background · 2"]');
    expect(background).toBeTruthy();
    expect(background?.classList.contains('border-2')).toBe(true);
    expect(background?.classList.contains('bg-transparent')).toBe(true);
    expect(background?.style.borderColor).toBe('var(--color-health-warn)');
    expect(view.container.querySelector('.anima-dot-halo')).toBeNull();
    expect(screen.getByRole('button', { name: /Milo.*background · 2/ })).toBeTruthy();
    // Exact: the avatar initial is decorative and must not lead the name.
    expect(screen.getByRole('button', { name: 'Milo background · 2' })).toBeTruthy();

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

    expect(view.container.querySelector('[title="working · background 2"]')).toBeTruthy();
    expect(view.container.querySelector('.anima-dot-halo')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Milo.*working · background 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Milo working · background 2' })).toBeTruthy();
  });

  it('pins Background to warn and Queued to idle colors', () => {
    expect(sidebarDotColor(healthy, 'background')).toBe('var(--color-health-warn)');
    expect(sidebarDotColor(healthy, 'queued')).toBe('var(--color-health-idle)');
  });

  it('uses the ring only for healthy Background work', () => {
    expect(sidebarUsesBackgroundRing(healthy, 'background')).toBe(true);
    expect(sidebarUsesBackgroundRing({ ...healthy, state: 'unhealthy' }, 'background')).toBe(false);
    expect(sidebarUsesBackgroundRing(healthy, 'working')).toBe(false);

    const unhealthyStatus = healthyStatus('background');
    if (!unhealthyStatus.health) throw new Error('expected health fixture');
    unhealthyStatus.health = { ...unhealthyStatus.health, state: 'unhealthy' };
    const view = render(
      <AgentRow
        active={false}
        agent={agent}
        enabled
        index={0}
        onClick={() => {}}
        status={unhealthyStatus}
      />,
    );
    const unhealthy = view.container.querySelector<HTMLElement>('[title="needs attention"]');
    expect(unhealthy?.classList.contains('border-2')).toBe(false);
    expect(unhealthy?.style.background).toBe('var(--color-health-error)');
  });
  it('never animates an unhealthy agent, whatever the work state', () => {
    expect(sidebarAnimatesWorking(healthy, 'working')).toBe(true);
    expect(sidebarAnimatesWorking({ ...healthy, state: 'unhealthy' }, 'working')).toBe(false);
    expect(sidebarAnimatesWorking({ ...healthy, state: 'degraded' }, 'working')).toBe(false);
    expect(sidebarAnimatesWorking({ ...healthy, state: 'starting' }, 'working')).toBe(false);
    expect(sidebarAnimatesWorking({ ...healthy, state: 'unknown' }, 'working')).toBe(false);
    expect(sidebarAnimatesWorking(undefined, 'working')).toBe(false);
    expect(sidebarAnimatesWorking(healthy, 'background')).toBe(false);

    for (const state of ['working', 'background'] as const) {
      const status = healthyStatus(state);
      if (!status.health) throw new Error('expected health fixture');
      status.health = { ...status.health, state: 'unhealthy' };
      const view = render(
        <AgentRow
          active={false}
          agent={agent}
          enabled
          index={0}
          onClick={() => {}}
          status={status}
        />,
      );
      // Health owns the shape: a solid error dot, no halo and no ring.
      expect(view.container.querySelector('.anima-dot-halo')).toBeNull();
      const dot = view.container.querySelector<HTMLElement>('[title="needs attention"]');
      expect(dot?.classList.contains('border-2')).toBe(false);
      expect(dot?.style.background).toBe('var(--color-health-error)');
      expect(screen.getByRole('button', { name: /Milo.*needs attention/ })).toBeTruthy();
      view.unmount();
    }
  });
});
