import test from 'node:test';
import assert from 'node:assert/strict';

import { slackMessagePreviewsFromAttachments } from '../slack/message-previews.js';
import { slackTranscriptOutput } from '../tools/slack-transcript.js';
import { slackMessageContentForText } from '../tools/slack-message-format.js';

test('Slack markdown block content enforces body and fallback limits', () => {
  const content = slackMessageContentForText(`Report\n${'é'.repeat(2_000)}`);
  assert.equal(content.format, 'markdown');
  assert.equal(content.blockCount, 1);
  assert.deepEqual(content.blocks, [{ type: 'markdown', text: `Report\n${'é'.repeat(2_000)}` }]);
  assert.ok(Buffer.byteLength(content.text, 'utf8') <= 3500);
  assert.ok(content.text.endsWith('…'));

  assert.throws(
    () => slackMessageContentForText('X'.repeat(12_001)),
    /message is too long for Slack markdown block: 12001 characters, Slack allows 12000; send a file instead/,
  );
});

test('Slack message unfurl attachments normalize into explicit previews', () => {
  const previews = slackMessagePreviewsFromAttachments([
    {
      author_id: 'U-iris',
      author_name: 'Iris',
      channel_id: 'D-private',
      from_url: 'https://example.slack.com/archives/D-private/p1770000100000001',
      is_msg_unfurl: true,
      private_channel_prompt: true,
      text: 'Private note preview',
      ts: '1770000100.000001',
    },
    {
      is_msg_unfurl: true,
      text: 'missing target is ignored',
    },
  ]);

  assert.deepEqual(previews, [{
    authorId: 'U-iris',
    authorName: 'Iris',
    channelId: 'D-private',
    fromUrl: 'https://example.slack.com/archives/D-private/p1770000100000001',
    isPrivate: true,
    messageTs: '1770000100.000001',
    text: 'Private note preview',
  }]);
});

test('Slack transcript output includes message preview annotations without reading the target channel', () => {
  const output = slackTranscriptOutput(
    [{
      attachments: [{
        author_name: 'Iris',
        channel_id: 'D-private',
        from_url: 'https://example.slack.com/archives/D-private/p1770000100000001',
        is_msg_unfurl: true,
        private_channel_prompt: true,
        text: 'Preview delivered by Slack',
        ts: '1770000100.000001',
      }],
      text: 'can you see this?',
      ts: '1770000200.000001',
      user: 'U-today',
    }],
    { channel: 'D-milo', limit: 1 },
    { actors: new Map([['U-today', '@totoday']]), channelMentions: new Map(), timezones: new Map(), userMentions: new Map() },
    { hasMore: false, nextCursor: '' },
  );

  assert.match(output, /preview: slack_preview private=true author="Iris" channel_id=D-private message_ts=1770000100\.000001/);
  assert.match(output, /> Preview delivered by Slack/);
});
