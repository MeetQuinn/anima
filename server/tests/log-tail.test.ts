import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readLastLogLines } from '../diagnostics/log-tail.js';

// The diagnostics bundle's previous reader: the whole file, split.
function wholeFileLines(content: Buffer, limit: number): string[] {
  return content.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
}

// The non-empty lines that start in the last `maxReadBytes` bytes.
function linesStartingInLast(content: Buffer, maxReadBytes: number, limit: number): string[] {
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content[index] !== 0x0a) continue;
    let lineEnd = index;
    if (index < content.length && lineEnd > lineStart && content[lineEnd - 1] === 0x0d) lineEnd -= 1;
    if (lineStart >= content.length - maxReadBytes) lines.push(content.toString('utf8', lineStart, lineEnd));
    lineStart = index + 1;
  }
  return lines.filter(Boolean).slice(-limit);
}

function randomLog(seed: number): Buffer {
  let state = seed;
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  // Multi-byte characters land on read boundaries; '\r' also appears alone.
  const pieces = ['a', 'b', ' ', '=', '日', 'é', '😀', '\r'];
  const lines: string[] = [];
  for (let count = next(60); lines.length < count;) {
    let line = '';
    for (let length = next(5) === 0 ? 0 : next(90); line.length < length;) line += pieces[next(pieces.length)];
    lines.push(line + (next(3) === 0 ? '\r\n' : '\n'));
  }
  if (lines.length > 0 && next(2) === 0) lines[lines.length - 1] = lines[lines.length - 1]!.replace(/\r?\n$/, '');
  return Buffer.from(lines.join(''), 'utf8');
}

test('the last log lines match a whole-file read, and the byte cap keeps only lines that start inside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-log-tail-test-'));
  try {
    const path = join(dir, 'agent.log');
    assert.deepEqual(await readLastLogLines(path, 5), []);

    // A cap one byte short of the file: the first line starts outside it.
    await writeFile(path, 'a\nb\n');
    assert.deepEqual(await readLastLogLines(path, 5, { maxReadBytes: 3 }), ['b']);

    const contents = [
      Buffer.alloc(0),
      Buffer.from('\n\n\r\n'),
      Buffer.from('one line, no break'),
      Buffer.from('a\r\nb\r\n\r\nc\n'),
      ...Array.from({ length: 40 }, (_, seed) => randomLog(seed + 1)),
    ];
    let compared = 0;
    for (const content of contents) {
      await writeFile(path, content);
      for (const limit of [1, 3, 240]) {
        for (const firstReadBytes of [1, 2, 3, 7, 64, 65_536]) {
          assert.deepEqual(
            await readLastLogLines(path, limit, { firstReadBytes }),
            wholeFileLines(content, limit),
            `limit ${limit}, first read ${firstReadBytes}, ${content.length} bytes`,
          );
          compared += 1;
        }
        // Caps just below, at and above the file size, and one byte inside it.
        const caps = [1, 2, 5, 40, 300, content.length - 1, content.length, content.length + 1].filter((cap) => cap > 0);
        for (const maxReadBytes of caps) {
          assert.deepEqual(
            await readLastLogLines(path, limit, { firstReadBytes: 3, maxReadBytes }),
            linesStartingInLast(content, maxReadBytes, limit),
            `limit ${limit}, cap ${maxReadBytes}, ${content.length} bytes`,
          );
          compared += 1;
        }
      }
    }
    assert.ok(compared > contents.length * 3 * 11, `${compared} comparisons`);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
