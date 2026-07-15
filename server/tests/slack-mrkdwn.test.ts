import assert from 'node:assert/strict';
import test from 'node:test';

import { slackMrkdwnForMarkdown } from '../tools/slack-mrkdwn.js';

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
