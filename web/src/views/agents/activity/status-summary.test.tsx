import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
});
