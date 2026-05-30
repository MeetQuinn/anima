import test from 'node:test';
import assert from 'node:assert/strict';

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
