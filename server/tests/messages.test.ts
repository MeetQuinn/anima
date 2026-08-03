import test from 'node:test';
import assert from 'node:assert/strict';

import { slackMessagePreviewsFromAttachments } from '../slack/message-previews.js';
import {
  slackEventMentionsUserId,
  slackVisibleMessageText,
  withCanonicalSlackVisibleText,
} from '../slack/message-text.js';
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

test('canonical Slack text restores trailing user mention past fallback cutoff', () => {
  const agentId = 'U0B3ZB0NCLA';
  const prefix = '界'.repeat(1_200);
  const fullBody = `${prefix}\nPlease take this <@${agentId}>`;
  const fallback = slackMessageContentForText(fullBody).text;
  assert.ok(fallback.endsWith('…'));
  assert.equal(slackEventMentionsUserId({ text: fallback }, agentId), false, 'fallback must cut off before the mention');

  const blocks = [{
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: `${prefix}\nPlease take this ` },
        { type: 'user', user_id: agentId },
      ],
    }],
  }];
  const canonical = withCanonicalSlackVisibleText({ blocks, text: fallback });
  assert.equal(slackEventMentionsUserId(canonical, agentId), true);
  assert.match(canonical.text ?? '', new RegExp(`<@${agentId}>$`));
  assert.ok((canonical.text ?? '').includes(prefix.slice(0, 20)));
});

test('literal/code mentions do not count as agent address; real entities and markdown tokens do', () => {
  const agentId = 'U0B3ZB0NCLA';

  // Markdown block: mention token only inside inline code
  assert.equal(
    slackEventMentionsUserId({
      blocks: [{ type: 'markdown', text: `example literal \`<@${agentId}>\`` }],
      text: `example literal \`<@${agentId}>\``,
    }, agentId),
    false,
  );

  // Rich-text code-styled text containing a mention token (renders as `…`)
  assert.equal(
    slackEventMentionsUserId({
      blocks: [{
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'example literal ' },
            { type: 'text', text: `<@${agentId}>`, style: { code: true } },
          ],
        }],
      }],
      text: `example literal \`<@${agentId}>\``,
    }, agentId),
    false,
  );

  // Real rich-text user entity (trailing mention after long body)
  assert.equal(
    slackEventMentionsUserId({
      blocks: [{
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'please handle ' },
            { type: 'user', user_id: agentId },
          ],
        }],
      }],
      text: 'please handle …',
    }, agentId),
    true,
  );

  // Plain rich-text text node with literal `<@U…>` — NOT a user entity, even after
  // blocks→text canonicalization would put that string in input.text.
  const literalRichText = {
    blocks: [{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [{ type: 'text', text: `literal <@${agentId}>` }],
      }],
    }],
    text: 'truncated …',
  };
  const canonicalLiteral = withCanonicalSlackVisibleText(literalRichText);
  assert.match(canonicalLiteral.text ?? '', new RegExp(`<@${agentId}>`));
  assert.equal(slackEventMentionsUserId(canonicalLiteral, agentId), false);

  // Markdown mention token outside code
  assert.equal(
    slackEventMentionsUserId({
      blocks: [{ type: 'markdown', text: `please handle <@${agentId}>` }],
      text: 'please handle …',
    }, agentId),
    true,
  );

  // Mixed: rich_text body without mention + section/mrkdwn real mention → wake
  assert.equal(
    slackEventMentionsUserId({
      blocks: [
        {
          type: 'rich_text',
          elements: [{
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'context only' }],
          }],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `please handle <@${agentId}>` },
        },
      ],
      text: 'context only…',
    }, agentId),
    true,
  );

  // Mixed: rich_text + section/mrkdwn with mention only inside code → no wake
  assert.equal(
    slackEventMentionsUserId({
      blocks: [
        {
          type: 'rich_text',
          elements: [{
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'context only' }],
          }],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `please handle \`<@${agentId}>\`` },
        },
      ],
      text: 'context only…',
    }, agentId),
    false,
  );

  // plain_text never parses entities — even with literal `<@U…>` after canonicalize
  for (const block of [
    { type: 'section', text: { type: 'plain_text', text: `literal <@${agentId}>` } },
    { type: 'header', text: { type: 'plain_text', text: `literal <@${agentId}>` } },
  ]) {
    const plain = withCanonicalSlackVisibleText({
      blocks: [block],
      text: 'fallback without mention',
    });
    assert.match(plain.text ?? '', new RegExp(`<@${agentId}>`));
    assert.equal(slackEventMentionsUserId(plain, agentId), false);
  }

  // Controls-only blocks: no renderable body → raw fallback may still address
  assert.equal(
    slackEventMentionsUserId({
      blocks: [{ type: 'actions', elements: [{ type: 'button', value: 'approve' }] }],
      text: `please <@${agentId}>`,
    }, agentId),
    true,
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

test('Slack visible message text degrades unsupported blocks and elements locally', () => {
  const prefix = '界'.repeat(1_200);
  const tail = 'TAIL KEPT after every unsupported node.';
  const fallback = slackMessageContentForText(`${prefix}\n${tail}`).text;
  assert.doesNotMatch(fallback, /TAIL KEPT/);

  const text = slackVisibleMessageText({
    blocks: [
      richTextBlock([{ type: 'text', text: prefix }]),
      { type: 'divider' },
      { type: 'header', text: { type: 'plain_text', text: 'Review findings' } },
      { type: 'image', alt_text: 'Evidence diagram', image_url: 'https://example.com/evidence.png' },
      { type: 'future_control_block', elements: [{ type: 'button', value: 'approve' }] },
      {
        elements: [
          {
            elements: [
              { type: 'text', text: 'Before inline. ' },
              { type: 'future_inline', text: 'Unknown inline words. ' },
              { type: 'link', text: 'Link label without a URL. ' },
              { type: 'future_opaque_inline', opaque: true },
              { type: 'text', text: 'After inline.' },
            ],
            type: 'rich_text_section',
          },
          { type: 'future_rich_text', text: 'Unknown rich-text words.' },
          {
            elements: [{ type: 'text', text: tail }],
            type: 'rich_text_section',
          },
        ],
        type: 'rich_text',
      },
    ],
    text: fallback,
  });

  assert.match(text ?? '', /^界+/);
  assert.match(text ?? '', /---/);
  assert.match(text ?? '', /Review findings/);
  assert.match(text ?? '', /Evidence diagram/);
  assert.match(text ?? '', /\[unsupported block: future_control_block\]/);
  assert.match(text ?? '', /Before inline\. Unknown inline words\. Link label without a URL\. \[unsupported inline element: future_opaque_inline\]After inline\./);
  assert.match(text ?? '', /Unknown rich-text words\./);
  assert.match(text ?? '', /TAIL KEPT after every unsupported node\.$/);
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

function richTextBlock(elements: object[]): object {
  return {
    elements: [{ elements, type: 'rich_text_section' }],
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
