import test from 'node:test';
import assert from 'node:assert/strict';

import {
  envelopeTime,
  formatUserLocalTime,
  quoteEnvelopeValue,
  renderEnvelope,
  renderPageFooter,
} from '../messages/envelope.js';

test('renderEnvelope joins fields in caller order and omits absent values', () => {
  assert.equal(
    renderEnvelope([
      { key: 'channel', value: '#team' },
      { key: 'channel_id', value: undefined },
      { key: 'thread_ts', value: '' },
      { key: 'message_ts', value: '1770000010.000001' },
      { key: 'wake', value: null },
      { key: 'time', value: '2026-01-01T00:00:00Z' },
    ]),
    '[channel=#team message_ts=1770000010.000001 time=2026-01-01T00:00:00Z]',
  );
});

test('renderEnvelope leaves values raw unless quoted, then applies the one quoting rule', () => {
  assert.equal(
    renderEnvelope([
      { key: 'slot', value: '05:47 agent-local' },
      { key: 'chat_name', value: '产品 "quoted" \\ group', quoted: true },
    ]),
    '[slot=05:47 agent-local chat_name="产品 \\"quoted\\" \\\\ group"]',
  );
  assert.equal(quoteEnvelopeValue('产品群'), '"产品群"');
});

test('envelopeTime trims to second granularity for Z and offset timestamps only', () => {
  assert.equal(envelopeTime('2026-05-18T17:00:00.123Z'), '2026-05-18T17:00:00Z');
  assert.equal(envelopeTime('2026-05-18T17:00:00.123+08:00'), '2026-05-18T17:00:00+08:00');
  assert.equal(envelopeTime('2026-05-18T17:00:00Z'), '2026-05-18T17:00:00Z');
  assert.equal(envelopeTime('not-a-timestamp'), 'not-a-timestamp');
});

test('formatUserLocalTime renders zone-local time with the DST-correct offset', () => {
  assert.equal(
    formatUserLocalTime('2026-05-19T23:59:30.000Z', { name: 'Asia/Shanghai', offsetSeconds: 28800 }),
    '2026-05-20T07:59:30+08:00',
  );
  // DST-aware: America/Los_Angeles is -07:00 in May regardless of a stale winter offset.
  assert.equal(
    formatUserLocalTime('2026-05-19T23:59:30.000Z', { name: 'America/Los_Angeles', offsetSeconds: -28800 }),
    '2026-05-19T16:59:30-07:00',
  );
});

test('formatUserLocalTime falls back to fixed offset, then to the raw timestamp', () => {
  assert.equal(
    formatUserLocalTime('2026-05-19T23:59:30.000Z', { name: 'Not/AZone', offsetSeconds: 28800 }),
    '2026-05-20T07:59:30+08:00',
  );
  assert.equal(
    formatUserLocalTime('2026-05-19T23:59:30.000Z', { name: 'Not/AZone' }),
    '2026-05-19T23:59:30.000Z',
  );
});

test('renderPageFooter renders has_more and a dash for a missing cursor', () => {
  assert.equal(
    renderPageFooter({ hasMore: true, nextCursor: '2026-05-11T00:05:00.000Z' }),
    '[page has_more=true next_cursor=2026-05-11T00:05:00.000Z]',
  );
  assert.equal(renderPageFooter({ hasMore: false }), '[page has_more=false next_cursor=-]');
  assert.equal(renderPageFooter({ hasMore: false, nextCursor: '' }), '[page has_more=false next_cursor=-]');
});
