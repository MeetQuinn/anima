import assert from 'node:assert/strict';
import test from 'node:test';

import { slackCaptionText, slackMrkdwnForMarkdown } from '../tools/slack-mrkdwn.js';

test('Slack file captions convert standard Markdown to mrkdwn', () => {
  const markdown = [
    '# Heading',
    '',
    '**bold** and `code`',
    '',
    '- one',
    '- two',
    '',
    '[Docs](https://example.com)',
    '',
    'cc @totodayqiang',
  ].join('\n');

  assert.equal(slackMrkdwnForMarkdown(markdown), [
    '*Heading*',
    '',
    '\u200b*bold*\u200b and `code`',
    '',
    '•   one',
    '•   two',
    '',
    '<https://example.com|Docs>',
    '',
    'cc @totodayqiang',
  ].join('\n'));
});

test('Slack file caption conversion removes only its generated trailing newline', () => {
  assert.equal(slackMrkdwnForMarkdown('plain text'), 'plain text');
  assert.equal(slackMrkdwnForMarkdown('   '), '');
});

// The case list below is drawn from the real caption/message corpus (anima
// outbox), not from what the converter was designed to handle. #540 shipped a
// regression because its cases came from the author's intent: every input the
// converter was built for passed, and the inputs people actually send were
// never in the list. Frequencies are from that corpus.
test('captions carrying Slack entity syntax go to Slack verbatim', () => {
  const raw = [
    '<@U0B3ZB0NCLA>', // user mention: 16x in corpus, the single most common entity
    'cc <@U0B3ZB0NCLA> and <@U0B4B0EFDFC>',
    '<#C0B8U0ZR2AW|code-review>', // channel link: slackify escapes the `>` -> dead entity
    '<https://example.com|Docs>', // labelled URL: slackify strips brackets -> label leaks
    '<!here>', // broadcast
    '<https://example.com\\|Docs>', // escaped pipe: forced by Markdown table cells
    '<@U>', // malformed entity; real, I have sent one
    'see `<@U0B3ZB0NCLA>` in a code span',
    '**bold** cc <@U0B3ZB0NCLA>', // mixed: entity survives, GFM deliberately not rendered
    'a < b', // bare `<`, no entity: raw path == pre-#540 behaviour, which rendered fine
  ];

  for (const caption of raw) {
    assert.equal(slackCaptionText(caption), caption, `must pass through verbatim: ${caption}`);
  }
});

test('captions without Slack entity syntax still convert GFM to mrkdwn', () => {
  assert.equal(slackCaptionText('**bold**'), '​*bold*​');
  assert.equal(slackCaptionText('- one\n- two'), '•   one\n•   two');
  assert.equal(slackCaptionText('# Heading'), '*Heading*');
  assert.equal(slackCaptionText('[Docs](https://example.com)'), '<https://example.com|Docs>');
});

// `&` and `>` are not the entity-forming character; only `<` is. slackify
// escapes them to `&amp;`/`&gt;`, which LOOKS like mangling and is not: Slack
// unescapes both on render. Verified against real Slack, not reasoned about.
// These stay on the conversion path deliberately — a bypass here would be a
// bypass for the majority of ordinary prose.
test('ampersand and close-angle alone do not trigger the raw path', () => {
  assert.equal(slackCaptionText('a & b'), 'a &amp; b');
  assert.equal(slackCaptionText('100% > 50%'), '100% &gt; 50%');
});
