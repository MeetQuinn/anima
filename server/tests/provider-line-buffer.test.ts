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

test('line buffer matches a whole-text split however the stream is chunked', () => {
  const text = 'a\r\n\nbb\rb\r\n\r\nccc\ndd\r';
  for (let first = 0; first <= text.length; first += 1) {
    for (let second = first; second <= text.length; second += 1) {
      const buffer = new LineBuffer();
      const lines = [
        ...buffer.accept(text.slice(0, first)),
        ...buffer.accept(text.slice(first, second)),
        ...buffer.accept(text.slice(second)),
        ...buffer.accept('\n'),
      ];
      assert.deepEqual(lines, `${text}\n`.split(/\r?\n/).slice(0, -1), `chunks at ${first},${second}`);
    }
  }
});

test('line buffer takes linear time for a long line that arrives in many chunks', () => {
  // A provider CLI writes one event line of 32 Mi characters, which arrives in
  // 2048 chunks of 16 Ki characters. Re-splitting the pending text on every
  // chunk scans about 32 Gi characters in all and takes seconds; scanning only
  // each new chunk takes milliseconds.
  const buffer = new LineBuffer();
  const piece = 'é'.repeat(16 * 1024);
  const started = performance.now();
  for (let index = 0; index < 2048; index += 1) {
    assert.deepEqual(buffer.accept(piece), []);
  }
  const lines = buffer.accept('\nnext');
  const elapsedMs = performance.now() - started;
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.length, 32 * 1024 * 1024);
  assert.ok(elapsedMs < 1_000, `took ${Math.round(elapsedMs)} ms`);
});
