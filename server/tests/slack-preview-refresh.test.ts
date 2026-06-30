import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebClient } from '@slack/web-api';

import { waitForSlackMessagePreviewAttachments } from '../inbox/slack-preview-refresh.js';
import { normalizeSlackMessage } from '../inbox/slack-events.js';

test('delayed Slack preview wait returns containing-message unfurl attachments before enqueue', async () => {
  const link = 'https://quinn-ai.slack.com/archives/C01KWJZHX1N/p1782746386955099';
  const text = `<${link}> can you see this?`;
  const calls: Array<{ channel?: string; latest?: string; oldest?: string }> = [];
  const client = {
    conversations: {
      history: async (args: { channel?: string; latest?: string; oldest?: string }) => {
        calls.push(args);
        return {
          messages: [{
            attachments: calls.length === 1 ? [] : [{
              author_id: 'U-ben',
              author_name: 'Ben',
              channel_id: 'C-private-target',
              from_url: link,
              is_msg_unfurl: true,
              text: 'Preview delivered by Slack after the realtime event',
              ts: '1782746386.955099',
            }],
            ts: '1782810152.448799',
          }],
        };
      },
    },
  } as unknown as Pick<WebClient, 'conversations'>;

  const attachments = await waitForSlackMessagePreviewAttachments({
    channelId: 'D-containing',
    client,
    messageTs: '1782810152.448799',
    retryDelaysMs: [0, 0],
    text,
  });

  assert.deepEqual(calls, [
    { channel: 'D-containing', inclusive: true, latest: '1782810152.448799', limit: 1, oldest: '1782810152.448799' },
    { channel: 'D-containing', inclusive: true, latest: '1782810152.448799', limit: 1, oldest: '1782810152.448799' },
  ]);

  const normalized = normalizeSlackMessage({
    envelope: { team_id: 'T-demo' },
    event: {
      attachments,
      channel: 'D-containing',
      text,
      ts: '1782810152.448799',
      type: 'message',
      user: 'U-owner',
    },
  });
  assert.deepEqual(normalized.previews, [{
    authorId: 'U-ben',
    authorName: 'Ben',
    channelId: 'C-private-target',
    fromUrl: link,
    messageTs: '1782746386.955099',
    text: 'Preview delivered by Slack after the realtime event',
  }]);
});

test('delayed Slack preview wait skips messages without Slack permalinks', async () => {
  let calls = 0;
  const client = {
    conversations: {
      history: async () => {
        calls += 1;
        return { messages: [] };
      },
    },
  } as unknown as Pick<WebClient, 'conversations'>;

  const attachments = await waitForSlackMessagePreviewAttachments({
    channelId: 'D-containing',
    client,
    messageTs: '1782810200.000001',
    retryDelaysMs: [0],
    text: 'plain text only',
  });

  assert.equal(attachments, undefined);
  assert.equal(calls, 0);
});
