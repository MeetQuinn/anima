import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonlAppendLog } from '../storage/jsonl-log.js';

// A writer that dies partway through an append leaves a line with no end.
// The log must stay readable, and later appends must not join that line.

interface Rec { id: string; text?: string }
const line = (id: string, text?: string): string => `${JSON.stringify(text ? { id, text } : { id })}\n`;
const TORN = '{"id":"torn","te';

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonl-torn-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

// Each read path, on a fresh log object so no read is served from another's parse.
async function reads(path: string): Promise<Record<string, string[]>> {
  const fresh = () => new JsonlAppendLog<Rec>(path);
  const ids = (records: Rec[]) => records.map((record) => record.id);
  return {
    readAll: ids(await fresh().readAll()),
    readTail: ids(await fresh().readTail(2)),
    readNewestMatching: ids(await fresh().readNewestMatching(10, () => true)),
    readNewestUntil: ids(await fresh().readNewestUntil(() => false)),
    readPage: (await fresh().readPage({ limit: 10, matches: () => true, idOf: (record) => record.id }))
      .rows.map((row) => row.record.id),
  };
}

test('every read skips a torn last line', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'log.jsonl');
    await writeFile(path, line('a') + line('b') + TORN);
    assert.deepEqual(await reads(path), {
      readAll: ['a', 'b'],
      readTail: ['a', 'b'],
      readNewestMatching: ['b', 'a'],
      readNewestUntil: ['b', 'a'],
      readPage: ['b', 'a'],
    });
  });
});

const appends: Record<string, (log: JsonlAppendLog<Rec>, record: Rec) => Promise<unknown>> = {
  append: (log, record) => log.append(record),
  appendBuilt: (log, record) => log.appendBuilt(() => record),
  appendIf: (log, record) => log.appendIf(record, () => true),
  appendIfRecent: (log, record) => log.appendIfRecent(record, () => true, 5),
  appendManyByKey: (log, record) => log.appendManyByKey([record], (row) => row.id),
};

for (const [name, appendOne] of Object.entries(appends)) {
  test(`${name} after a torn line starts a new line, and every read skips the torn one`, async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'log.jsonl');
      await writeFile(path, line('a') + TORN);
      await appendOne(new JsonlAppendLog<Rec>(path), { id: 'b' });
      assert.equal(await readFile(path, 'utf8'), `${line('a')}${TORN}\n${line('b')}`);
      assert.deepEqual(await reads(path), {
        readAll: ['a', 'b'],
        readTail: ['a', 'b'],
        readNewestMatching: ['b', 'a'],
        readNewestUntil: ['b', 'a'],
        readPage: ['b', 'a'],
      });
    });
  });
}

test('an append to a file that ends with a newline adds nothing before the record', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const log = new JsonlAppendLog<Rec>(path);
    await log.append({ id: 'a' });
    await log.append({ id: 'b' });
    assert.equal(await readFile(path, 'utf8'), line('a') + line('b'));
  });
});

test('a tail read that seeks from the end of a large file skips a torn line', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const filler = 'x'.repeat(200);
    const head = Array.from({ length: 100 }, (_, i) => line(`r${i}`, filler)).join('');
    await writeFile(path, `${head}${TORN}\n${line('last', filler)}`);
    const ids = (records: Rec[]) => records.map((record) => record.id);
    assert.deepEqual(ids(await new JsonlAppendLog<Rec>(path).readTail(2)), ['r99', 'last']);
    assert.deepEqual(ids(await new JsonlAppendLog<Rec>(path).readTail(1)), ['last']);
  });
});
