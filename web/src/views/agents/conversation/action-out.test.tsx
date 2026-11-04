import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActivityFeedItem } from '@/lib/activity-feed';
import type { MessageGroup } from '@/lib/message-model';
import { MessageGroupRow } from './SlackTimeline';

describe('Linear write rows in the conversation', () => {
  it('show the requested action under the agent byline with the issue as the place', () => {
    const write: ActivityFeedItem = {
      kind: 'action-out',
      label: 'Update ANI-5',
      timestamp: '2026-11-04T01:00:00.000Z',
      surface: { kind: 'channel', label: 'ANI-5' },
    };
    const group: MessageGroup = {
      author: { key: 'agent', name: 'Nora', initial: 'N', isAgent: true },
      surfaceKey: 'channel:ANI-5',
      surface: write.surface,
      startTs: write.timestamp,
      items: [{ item: write, key: '0' }],
    };
    const { container } = render(<MessageGroupRow group={group} agentId="nora" />);

    expect(screen.getByText('Nora')).toBeTruthy();
    expect(screen.getByText('ANI-5')).toBeTruthy();
    expect(screen.getByText('Update ANI-5')).toBeTruthy();
    expect(container.textContent).not.toContain('(empty message)');
  });
});
