import { describe, expect, it } from 'vitest';

import { buildActivityFeed } from './activity-feed';
import type { AgentActivityFeedPage } from '@shared/activity';

describe('buildActivityFeed', () => {
  it('renders attention suggestion traces as centered system events', () => {
    const page: AgentActivityFeedPage = {
      events: [{
        activity: {
          activityId: 'actv_attention_1',
          createdAt: '2026-07-04T14:00:00.000Z',
          payload: {
            channelId: 'C123',
            channelName: 'build',
            platform: 'slack',
            suggestion: 'Attention suggestion: run `anima subscription mute --channel C123`.',
            threadTs: '1770000010.000001',
          },
          type: 'anima.attention.suggestion',
        },
        kind: 'activity',
        timestamp: '2026-07-04T14:00:00.000Z',
      }],
      nextCursor: null,
    };

    const [item] = buildActivityFeed(page);

    expect(item?.kind).toBe('system-event');
    if (item?.kind !== 'system-event') throw new Error('expected system event');
    expect(item.eventKind).toBe('attention');
    expect(item.label).toBe('Attention');
    expect(item.body).toBe('#build · thread suggestion attached');
    expect(item.meta).toBe('Attention suggestion: run `anima subscription mute --channel C123`.');
    expect(item.timestamp).toBe('2026-07-04T14:00:00.000Z');
  });
});
