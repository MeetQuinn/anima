import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentStatusSummary } from '@shared/snapshot';
import { ActivityStatusSummary, deferredRetryAccessibleName } from './index';

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

  it('renders Codex foreground work with its background terminal count', () => {
    const status: AgentStatusSummary = {
      agentId: 'felix',
      currentItemId: 'reminder:shadow-regrade',
      health: {
        runtime: {
          providerChildExpected: true,
          providerWork: { backgroundTaskCount: 2, state: 'working' },
        },
        state: 'healthy',
        updatedAt: '2026-09-03T12:00:00.000Z',
      },
      itemCount: 1,
      queueDepth: 0,
    };

    render(
      <ActivityStatusSummary
        latestActivity={undefined}
        now={new Date('2026-09-03T12:00:01.000Z')}
        status={status}
      />,
    );

    expect(screen.getByText('Working · Background 2')).toBeTruthy();
  });

  it('offers Retry now only for retryable deferred wakes', async () => {
    const status: AgentStatusSummary = {
      agentId: 'milo',
      deferredWakes: [
        {
          deferrals: 1,
          id: 'slack:T:C:1.0',
          kind: 'slack',
          notBefore: '2099-01-01T09:00:00.000Z',
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
    const buttons = screen.getAllByRole('button', { name: /Retry Slack wake now/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('title')).toMatch(/deferred until/);
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
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('renders no Retry now control when there is no handler', () => {
    const status: AgentStatusSummary = {
      agentId: 'milo',
      deferredWakes: [
        {
          deferrals: 1,
          id: 'slack:T:C:1.0',
          kind: 'slack',
          notBefore: '2099-01-01T09:00:00.000Z',
          retryable: true,
        },
      ],
      itemCount: 1,
      queueDepth: 1,
    };

    render(
      <ActivityStatusSummary
        latestActivity={undefined}
        now={new Date('2026-09-01T08:00:01.000Z')}
        status={status}
      />,
    );

    expect(screen.getByText('1 deferred')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('disables every Retry now control while one retry is in flight', () => {
    const status: AgentStatusSummary = {
      agentId: 'milo',
      deferredWakes: [
        {
          deferrals: 1,
          id: 'slack:T:C:1.0',
          kind: 'slack',
          notBefore: '2099-01-01T09:00:00.000Z',
          retryable: true,
        },
        {
          deferrals: 2,
          id: 'slack:T:C:2.0',
          kind: 'slack',
          notBefore: '2099-01-01T10:00:00.000Z',
          retryable: true,
        },
      ],
      itemCount: 2,
      queueDepth: 2,
    };

    render(
      <ActivityStatusSummary
        latestActivity={undefined}
        now={new Date('2026-09-01T08:00:01.000Z')}
        onRetryDeferred={vi.fn()}
        retryingDeferredId="slack:T:C:1.0"
        status={status}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: /Retry Slack wake now/ });
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText('Retrying…')).toBeTruthy();
    expect(screen.getAllByText('Retry now')).toHaveLength(1);
  });

  it('builds distinct accessible names from kind, until, and deferrals', () => {
    expect(
      deferredRetryAccessibleName({
        deferrals: 1,
        id: 'slack:T:C:1.0',
        kind: 'slack',
        notBefore: '2099-01-01T09:00:00.000Z',
        retryable: true,
      }),
    ).toMatch(/^Retry Slack wake now \(deferred until \d{2}:\d{2}, 1 deferral\)$/);
  });
});
