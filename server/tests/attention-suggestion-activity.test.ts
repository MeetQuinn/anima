import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordAttentionSuggestionActivity,
  slackAttentionSuggestionPayload,
} from '../inbox/attention-suggestion-activity.js';
import { slackChannelAttentionNote } from '../runtime/delivery-notes.js';
import { withAnimaHome } from './anima-home.js';
import { allActivities, loadState } from './helpers/state.js';
import type { SlackInboxItem } from '../../shared/inbox.js';

test('attention suggestion activity records Slack surface and suggestion payload', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-attention-suggestion-activity-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const item: SlackInboxItem = {
        channelId: 'C123',
        channelName: 'build',
        handling: {
          createdAt: '2026-07-04T14:00:00.000Z',
          status: 'queued',
          updatedAt: '2026-07-04T14:00:00.000Z',
        },
        id: 'slack:T123:C123:1770000010.000001',
        kind: 'slack',
        messageTs: '1770000010.000001',
        receivedAt: '2026-07-04T14:00:00.000Z',
        teamId: 'T123',
        text: 'wake',
        threadTs: '1770000010.000001',
      };
      const suggestion = slackChannelAttentionNote('C123');

      await recordAttentionSuggestionActivity('scout', slackAttentionSuggestionPayload(item, suggestion));

      const [activity] = allActivities(await loadState());
      assert.ok(activity);
      assert.equal(activity.type, 'anima.attention.suggestion');
      assert.deepEqual(activity.payload, {
        channelId: 'C123',
        channelName: 'build',
        platform: 'slack',
        suggestion,
        threadTs: '1770000010.000001',
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});
