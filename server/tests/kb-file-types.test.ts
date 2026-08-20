import test from 'node:test';
import assert from 'node:assert/strict';

import { kbFileKind } from '../../shared/kb-file-types.js';
import { contentTypeFor } from '../kb/kb.helper.js';

test('kbFileKind classifies pdf separately from binary', () => {
  assert.equal(kbFileKind('docs/guide.pdf'), 'pdf');
  assert.equal(kbFileKind('Guide.PDF'), 'pdf');
  assert.equal(kbFileKind('data.bin'), 'binary');
});

test('contentTypeFor serves application/pdf for pdf paths', () => {
  assert.equal(contentTypeFor('docs/guide.pdf'), 'application/pdf');
  assert.equal(contentTypeFor('data.bin'), 'application/octet-stream');
});
