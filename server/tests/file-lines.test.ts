import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { forEachFileLine } from '../file-lines.js';

async function withFile(contents: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anima-file-lines-'));
  try {
    const path = join(dir, 'lines.txt');
    await writeFile(path, contents, 'utf8');
    await run(path);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function collect(path: string, offset = 0): Promise<Array<[string, number]>> {
  const lines: Array<[string, number]> = [];
  await forEachFileLine(path, offset, (line, lineOffset) => {
    lines.push([line.toString('utf8'), lineOffset]);
  });
  return lines;
}

test('forEachFileLine passes each line and its byte offset across chunk boundaries', async () => {
  // Longer than two read chunks, with multi-byte text before and after.
  const long = 'x'.repeat(600_000);
  const lines = ['漢字', '', long, 'crlf\r', 'after', 'unterminated'];
  await withFile(lines.join('\n'), async (path) => {
    let offset = 0;
    const expected = lines.map((line): [string, number] => {
      const entry: [string, number] = [line, offset];
      offset += Buffer.byteLength(`${line}\n`);
      return entry;
    });
    assert.deepEqual(await collect(path), expected);
    assert.deepEqual(await collect(path, expected[3]![1]), expected.slice(3));
  });
});

test('forEachFileLine stops when the callback returns true', async () => {
  await withFile('a\nb\nc\n', async (path) => {
    const seen: string[] = [];
    await forEachFileLine(path, 0, (line) => {
      seen.push(line.toString('utf8'));
      return seen.length === 2;
    });
    assert.deepEqual(seen, ['a', 'b']);
  });
});

test('forEachFileLine reads from the start when the file is shorter than the offset', async () => {
  await withFile('a\nb\n', async (path) => {
    assert.deepEqual(await collect(path, 1_000), [['a', 0], ['b', 2]]);
  });
});
