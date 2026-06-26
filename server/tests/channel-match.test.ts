import test from 'node:test';
import assert from 'node:assert/strict';

import { messageMatchesChannel, normalizeChannelSearchTerm } from '../messages/channel-match.js';
import type { AgentMessageRecord } from '../../shared/messages.js';

function record(input: Partial<AgentMessageRecord>): AgentMessageRecord {
  return {
    direction: 'in',
    kind: 'message',
    messageId: input.messageId ?? 'm1',
    source: { id: input.messageId ?? 'm1', kind: 'activity' },
    text: 'hello',
    timestamp: '2026-05-11T00:00:00.000Z',
    ...input,
  };
}

test('normalizeChannelSearchTerm strips #, @, and the "DM with @" prefix', () => {
  assert.equal(normalizeChannelSearchTerm('#product'), 'product');
  assert.equal(normalizeChannelSearchTerm('@alice'), 'alice');
  assert.equal(normalizeChannelSearchTerm('DM with @alice'), 'alice');
  assert.equal(normalizeChannelSearchTerm('  PRODUCT  '), 'product');
});

test('messageMatchesChannel matches a channel by id, name, or display name', () => {
  const entry = record({ channelId: 'C-product', channelName: 'product', channelDisplayName: 'Product' });
  assert.ok(messageMatchesChannel(entry, 'C-product'));
  assert.ok(messageMatchesChannel(entry, 'product'));
  assert.ok(messageMatchesChannel(entry, '#product'));
  assert.ok(messageMatchesChannel(entry, 'Product'));
  assert.ok(!messageMatchesChannel(entry, 'random'));
  assert.ok(!messageMatchesChannel(entry, 'C-random'));
});

test('messageMatchesChannel matches a DM by channel id, handle, or user id', () => {
  const dm = record({ channelKind: 'dm', channelId: 'D-alice', dmHandle: 'alice', dmUserId: 'U-alice' });
  assert.ok(messageMatchesChannel(dm, 'D-alice'));
  assert.ok(messageMatchesChannel(dm, 'alice'));
  assert.ok(messageMatchesChannel(dm, '@alice'));
  assert.ok(messageMatchesChannel(dm, 'U-alice'));
  assert.ok(!messageMatchesChannel(dm, 'bob'));
});

test('messageMatchesChannel with an empty term matches everything (no scoping)', () => {
  const entry = record({ channelId: 'C-product' });
  assert.ok(messageMatchesChannel(entry, ''));
  assert.ok(messageMatchesChannel(entry, '   '));
});
