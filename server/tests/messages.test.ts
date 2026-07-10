import test from 'node:test';
import assert from 'node:assert/strict';

import { slackMessagePreviewsFromAttachments } from '../slack/message-previews.js';
import { slackVisibleMessageText } from '../slack/message-text.js';
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

test('Slack visible message text restores complete rich text and tables from blocks', () => {
  const text = slackVisibleMessageText({
    blocks: [
      {
        elements: [{
          elements: [
            { type: 'user', user_id: 'UB0B1' },
            { text: ' finished ', type: 'text' },
            { style: { bold: true }, text: 'S1', type: 'text' },
            { text: '\n\nFiles', type: 'text' },
          ],
          type: 'rich_text_section',
        }, {
          elements: [
            { elements: [{ style: { code: true }, text: 'one.go', type: 'text' }], type: 'rich_text_section' },
          ],
          indent: 0,
          style: 'bullet',
          type: 'rich_text_list',
        }],
        type: 'rich_text',
      },
      {
        rows: [
          [richTextCell('Contract'), richTextCell('Code')],
          [richTextCell('Conservation'), richTextCell('placed | superseded')],
        ],
        type: 'table',
      },
      {
        elements: [{
          elements: [{ text: 'The complete ending survives.', type: 'text' }],
          type: 'rich_text_section',
        }],
        type: 'rich_text',
      },
    ],
    text: '<@UB0B1> finished **S1** …',
  });

  assert.equal(text, [
    '<@UB0B1> finished **S1**\n\nFiles\n- `one.go`',
    '| Contract | Code |\n| --- | --- |\n| Conservation | placed \\| superseded |',
    'The complete ending survives.',
  ].join('\n\n'));
});

test('Slack visible message text keeps fallback text when blocks contain app controls', () => {
  assert.equal(slackVisibleMessageText({
    blocks: [{ elements: [{ type: 'button', value: 'approve' }], type: 'actions' }],
    text: 'Approval requested',
  }), 'Approval requested');
});

test('Slack visible message text reads a realtime markdown block verbatim', () => {
  assert.equal(slackVisibleMessageText({
    blocks: [{ text: 'Complete markdown body after the fallback cutoff.', type: 'markdown' }],
    text: 'Complete markdown body…',
  }), 'Complete markdown body after the fallback cutoff.');
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

function richTextCell(text: string): object {
  return {
    elements: [{ elements: [{ text, type: 'text' }], type: 'rich_text_section' }],
    type: 'rich_text',
  };
}

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
