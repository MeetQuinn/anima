import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChatTargetOptions } from '../tools/chat-target-options.js';

test('normalizeChatTargetOptions maps Feishu --chat-id onto channel', () => {
  assert.deepEqual(
    normalizeChatTargetOptions({
      chatId: ' oc_team ',
      threadTs: 'om_topic',
    }, 'message send'),
    {
      channel: 'oc_team',
      threadTs: 'om_topic',
    },
  );
});

test('normalizeChatTargetOptions keeps Slack --channel unchanged', () => {
  assert.deepEqual(
    normalizeChatTargetOptions({
      channel: ' C-team ',
      messageTs: '1770000200.000123',
    }, 'message update'),
    {
      channel: 'C-team',
      messageTs: '1770000200.000123',
    },
  );
});

test('normalizeChatTargetOptions fails closed for ambiguous or non-Feishu chat ids', () => {
  assert.throws(
    () => normalizeChatTargetOptions({ channel: 'C-team', chatId: 'oc_team' }, 'message read'),
    /message read accepts either --channel or --chat-id, not both/,
  );
  assert.throws(
    () => normalizeChatTargetOptions({ chatId: 'C-team' }, 'message read'),
    /message read --chat-id must be a Feishu chat_id \(oc_\.\.\.\)/,
  );
});
