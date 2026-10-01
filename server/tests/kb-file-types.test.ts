import test from 'node:test';
import assert from 'node:assert/strict';

import { kbFileKind } from '../../shared/kb-file-types.js';
import { contentTypeFor, looksLikeUtf8Text } from '../kb/kb.helper.js';

test('kbFileKind classifies pdf separately from binary', () => {
  assert.equal(kbFileKind('docs/guide.pdf'), 'pdf');
  assert.equal(kbFileKind('Guide.PDF'), 'pdf');
  assert.equal(kbFileKind('data.bin'), 'binary');
});

test('kbFileKind treats common config extensions as text', () => {
  assert.equal(kbFileKind('home/surge/default.conf'), 'text');
  assert.equal(kbFileKind('setup.cfg'), 'text');
  assert.equal(kbFileKind('php.INI'), 'text');
});

test('looksLikeUtf8Text accepts UTF-8 text and rejects NUL bytes or invalid sequences', () => {
  assert.equal(looksLikeUtf8Text(Buffer.from('[General]\nloglevel = notify\n# 代理规则\n')), true);
  assert.equal(looksLikeUtf8Text(Buffer.alloc(0)), true);
  assert.equal(looksLikeUtf8Text(Buffer.from([0x61, 0x00, 0x62])), false);
  assert.equal(looksLikeUtf8Text(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  // A prefix sample may end mid-character: fine as a sample, not as a whole file.
  const cut = Buffer.from('代', 'utf8').subarray(0, 2);
  assert.equal(looksLikeUtf8Text(cut, { partial: true }), true);
  assert.equal(looksLikeUtf8Text(cut), false);
});

test('contentTypeFor serves application/pdf for pdf paths', () => {
  assert.equal(contentTypeFor('docs/guide.pdf'), 'application/pdf');
  assert.equal(contentTypeFor('data.bin'), 'application/octet-stream');
});
