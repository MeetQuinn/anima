import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentStatusSummary } from '@shared/snapshot';
import { ActivityStatusSummary } from './index';

describe('ActivityStatusSummary', () => {
  it('renders the Claude background task count after the queue item completes', () => {
    const status: AgentStatusSummary = {
      agentId: 'milo',
      health: {
        runtime: {
          providerChildExpected: false,
          providerWork: { backgroundTaskCount: 2, state: 'background' },
        },
        state: 'healthy',
        updatedAt: '2026-09-01T08:00:00.000Z',
      },
      itemCount: 1,
      queueDepth: 0,
    };

    render(
      <ActivityStatusSummary
        latestActivity={undefined}
        now={new Date('2026-09-01T08:00:01.000Z')}
        status={status}
      />,
    );

    expect(screen.getByText('Background · 2')).toBeTruthy();
    expect(screen.queryByText('Idle')).toBeNull();
  });

  it('offers Retry now for deferred rate-limit wakes', async () => {
    const status: AgentStatusSummary = {
      agentId: 'milo',
      deferredWakes: [
        {
          deferrals: 1,
          id: 'slack:T:C:1.0',
          kind: 'slack',
          notBefore: '2099-01-01T00:00:00.000Z',
        },
      ],
      itemCount: 1,
      queueDepth: 1,
    };
    const onRetryDeferred = vi.fn();

    render(
      <ActivityStatusSummary
        latestActivity={undefined}
        now={new Date('2026-09-01T08:00:01.000Z')}
        onRetryDeferred={onRetryDeferred}
        status={status}
      />,
    );

    expect(screen.getByText('1 deferred')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Retry now' });
    button.click();
    expect(onRetryDeferred).toHaveBeenCalledWith('slack:T:C:1.0');
  });
});
