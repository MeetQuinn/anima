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

  it('offers Retry now only for retryable deferred wakes', async () => {
    const status: AgentStatusSummary = {
      agentId: 'milo',
      deferredWakes: [
        {
          deferrals: 1,
          id: 'slack:T:C:1.0',
          kind: 'slack',
          notBefore: '2099-01-01T00:00:00.000Z',
          retryable: true,
        },
        {
          deferrals: 1,
          id: 'reminder:penny:fire:1',
          kind: 'reminder',
          notBefore: '2099-01-01T00:00:00.000Z',
          retryable: false,
        },
      ],
      itemCount: 2,
      queueDepth: 2,
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

    expect(screen.getByText('2 deferred')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Retry now' });
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    expect(onRetryDeferred).toHaveBeenCalledWith('slack:T:C:1.0');
  });

  it('shows deferred count without a Retry now button when nothing is retryable', () => {
    const status: AgentStatusSummary = {
      agentId: 'milo',
      deferredWakes: [
        {
          id: 'reminder:penny:fire:1',
          kind: 'reminder',
          notBefore: '2099-01-01T00:00:00.000Z',
          retryable: false,
        },
      ],
      itemCount: 1,
      queueDepth: 1,
    };

    render(
      <ActivityStatusSummary
        latestActivity={undefined}
        now={new Date('2026-09-01T08:00:01.000Z')}
        onRetryDeferred={vi.fn()}
        status={status}
      />,
    );

    expect(screen.getByText('1 deferred')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
  });
});
