import test from 'node:test';
import assert from 'node:assert/strict';

import { LineBuffer } from '../providers/line-buffer.js';

test('line buffer emits complete lines and holds partial lines', () => {
  const buffer = new LineBuffer();

  assert.deepEqual(buffer.accept('first'), []);
  assert.deepEqual(buffer.accept(' line\nsecond'), ['first line']);
  assert.deepEqual(buffer.accept(' line\nthird\nfourth'), ['second line', 'third']);
  assert.deepEqual(buffer.accept(' line\n'), ['fourth line']);
});

test('line buffer handles CRLF boundaries across chunks', () => {
  const buffer = new LineBuffer();

  assert.deepEqual(buffer.accept('one\r'), []);
  assert.deepEqual(buffer.accept('\ntwo\r\nthree'), ['one', 'two']);
  assert.deepEqual(buffer.accept('\r\n'), ['three']);
});
