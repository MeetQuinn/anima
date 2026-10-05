import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, copyFile, open, readdir, readFile, rename, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as jsonFile from '../storage/json-file.js';
import * as jsonlLog from '../storage/jsonl-log.js';
import { DEFAULT_JSONL_ROTATE_BYTES, JsonlAppendLog, type JsonlRotationOptions, type PositionedRecord }
  from '../storage/jsonl-log.js';
import { encodeHistoryCursor, type LogPosition } from '../storage/history-cursor.js';
import { withTempAnimaHome } from './helpers/harness.js';

// A live-segment page read may parse only the bytes appended since its cached
// read, and only when every cached byte is proven unchanged and ends at a line
// break. Every read below is compared with a cold full parse of the same files
// through the same page scan: rows, positions, hasMore and nextCursor, or the
// same error.
//
// The read counters and cache peek are reached through the module namespaces so
// this file also runs against the base revision, which has neither. That run
// must pass every comparison and fail only at the counter checks.

interface Rec { id: string; text: string }
const rec = (id: string, text = `text of ${id}`): Rec => ({ id, text });
const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
const recId = (record: Rec): string => record.id;

type Stats = { hit: number; full: number; incremental: number };
function readStats(): Stats | undefined {
  const stats = (jsonlLog as unknown as { jsonlPageReadStats?: Stats }).jsonlPageReadStats;
  return stats ? { ...stats } : undefined;
}
function peek(key: string): { records: unknown[]; bytes?: Buffer } | undefined {
  const cachePeek = (jsonFile as unknown as { cachePeek?: (key: string) => unknown }).cachePeek;
  assert.ok(cachePeek, 'cachePeek is exported');
  return cachePeek(key) as { records: unknown[]; bytes?: Buffer } | undefined;
}
async function pageKey(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return `${path}:${info.dev}:${info.ino}`;
}

/** Records how each step's page reads were served; checked at the end of a test. */
class ReadLedger {
  private readonly steps: { label: string; expected: Partial<Stats>; delta?: Stats }[] = [];

  async step(label: string, expected: Partial<Stats>, body: () => Promise<void>): Promise<void> {
    const before = readStats();
    await body();
    const after = readStats();
    this.steps.push({ label, expected, delta: before && after ? {
      hit: after.hit - before.hit, full: after.full - before.full, incremental: after.incremental - before.incremental,
    } : undefined });
  }

  verify(): void {
    for (const { label, expected, delta } of this.steps) {
      assert.ok(delta, `${label}: page read counters exist`);
      for (const key of Object.keys(expected) as (keyof Stats)[]) {
        assert.equal(delta[key], expected[key], `${label}: ${key} reads`);
      }
    }
  }
}

interface Pair<T> {
  log: JsonlAppendLog<T>;
  oracle: JsonlAppendLog<T>;
  idOf: (record: T) => string;
  coldReads: () => number;
}

/** The log under test, and a twin whose segment reads are always a cold full parse. */
function pairFor<T>(path: string, idOf: (record: T) => string, rotation: JsonlRotationOptions): Pair<T> {
  const log = new JsonlAppendLog<T>(path, rotation);
  const oracle = new JsonlAppendLog<T>(path, rotation);
  let coldReads = 0;
  (oracle as unknown as { readPageSegment: (segment: { path: string }) => Promise<T[]> }).readPageSegment =
    async (segment) => {
      coldReads += 1;
      return (await readFile(segment.path)).toString('utf8').split(/\r?\n/)
        .filter((s) => s.trim() !== '').map((s) => JSON.parse(s) as T);
    };
  return { log, oracle, idOf, coldReads: () => coldReads };
}

type ReadInput<T> = Parameters<JsonlAppendLog<T>['readPage']>[0];
type Outcome =
  | { ok: true; rows: PositionedRecord<unknown>[]; hasMore: boolean; nextCursor: string | null }
  | { ok: false; error: string };

async function outcome<T>(log: JsonlAppendLog<T>, input: ReadInput<T>): Promise<Outcome> {
  try {
    const { rows, hasMore } = await log.readPage(input);
    const last = rows.at(-1);
    return { ok: true, rows, hasMore, nextCursor: hasMore && last
      ? encodeHistoryCursor({ k: 'messages', a: 'tail', f: {}, p: last.position, id: input.idOf(last.record) })
      : null };
  } catch (error) {
    const e = error as Error & { code?: string };
    return { ok: false, error: `${e.name}:${e.code ?? ''}:${e.message}` };
  }
}

/** Walk every page at several sizes and filters; the log must equal the cold parse at each one. */
async function assertSame<T>(pair: Pair<T>, label: string): Promise<void> {
  const coldBefore = pair.coldReads();
  for (const filter of ['all', 'even-length id'] as const) {
    const matches = filter === 'all' ? () => true : (record: T) => pair.idOf(record).length % 2 === 0;
    for (const limit of [1, 2, 5, 1000]) {
      let anchor: { p: LogPosition; id: string } | undefined;
      for (let page = 0; ; page += 1) {
        const input: ReadInput<T> = { limit, matches, idOf: pair.idOf, anchor };
        const actual = await outcome(pair.log, input);
        const expected = await outcome(pair.oracle, input);
        assert.deepEqual(actual, expected, `${label}: ${filter}, limit ${limit}, page ${page}`);
        if (!expected.ok || !expected.hasMore) break;
        const last = expected.rows.at(-1)!;
        anchor = { p: last.position, id: pair.idOf(last.record as T) };
      }
    }
  }
  assert.ok(pair.coldReads() > coldBefore, `${label}: the cold oracle ran`);
}

const ids = (result: Outcome): string[] | string =>
  result.ok ? result.rows.map((row) => (row.record as Rec).id) : result.error;
const all = <T>(pair: Pair<T>): ReadInput<T> => ({ limit: 1000, matches: () => true, idOf: pair.idOf });
const liveOnly = (dir: string): JsonlRotationOptions =>
  ({ archiveDir: join(dir, 'archive'), maxBytes: DEFAULT_JSONL_ROTATE_BYTES });

test('one-by-one appends parse only the appended bytes and equal a cold full parse', async () => {
  await withTempAnimaHome(async (dir) => {
    const pair = pairFor<Rec>(join(dir, 'log.jsonl'), recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await pair.log.append(rec('a0'));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    for (let i = 1; i <= 12; i += 1) {
      await pair.log.append(rec(`a${i}`, i % 3 === 0 ? 'naïve ✓ 漢字 🙂' : `plain ${i}`));
      await ledger.step(`append ${i}`, { full: 0, incremental: 1 }, () => assertSame(pair, `append ${i}`));
    }
    ledger.verify();
  });
});

test('appendManyByKey batches, including an all-duplicate batch that writes nothing', async () => {
  await withTempAnimaHome(async (dir) => {
    const pair = pairFor<Rec>(join(dir, 'log.jsonl'), recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await pair.log.appendManyByKey([rec('s0'), rec('s1'), rec('s2')], recId);
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    let next = 0;
    for (const size of [1, 5, 50]) {
      const batch = Array.from({ length: size }, () => rec(`b${next++}`));
      assert.equal((await pair.log.appendManyByKey(batch, recId)).appended, size);
      await ledger.step(`batch of ${size}`, { full: 0, incremental: 1 }, () => assertSame(pair, `batch of ${size}`));
    }
    assert.equal((await pair.log.appendManyByKey([rec('s1'), rec('b3')], recId)).appended, 0);
    await ledger.step('all-duplicate batch', { full: 0, incremental: 0 }, () => assertSame(pair, 'all-duplicate batch'));
    ledger.verify();
  });
});

test('rotation between reads: new archive and new live parse in full, then the live file goes incremental', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    // ~46 bytes per record: every third append renames live into the archive first.
    const pair = pairFor<Rec>(path, recId, { archiveDir: join(dir, 'archive'), maxBytes: 120 });
    const ledger = new ReadLedger();
    const archives = async (): Promise<string[]> => readdir(join(dir, 'archive')).catch(() => []);
    await pair.log.append(rec('r00'));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    let rotations = 0;
    let staleLiveKey: string | undefined;
    for (let i = 1; i <= 10; i += 1) {
      const before = (await archives()).length;
      const liveKey = await pageKey(path);
      await pair.log.append(rec(`r${String(i).padStart(2, '0')}`));
      const rotated = (await archives()).length > before;
      if (rotated) { rotations += 1; staleLiveKey = liveKey; }
      // A rotation leaves one new archive and a new live file: two cold reads.
      await ledger.step(`append ${i}${rotated ? ' (rotated)' : ''}`,
        rotated ? { full: 2, incremental: 0 } : { full: 0, incremental: 1 }, () => assertSame(pair, `append ${i}`));
    }
    assert.ok(rotations >= 2, `rotations happened (${rotations})`);
    ledger.verify();
    // Bytes are kept for the live file only, and the replaced live file's entry is dropped.
    assert.ok(peek(await pageKey(path))?.bytes, 'live entry keeps its bytes');
    const newest = (await archives()).sort().at(-1)!;
    const archived = peek(await pageKey(join(dir, 'archive', newest)));
    assert.ok(archived && archived.bytes === undefined, 'archive entry holds records only');
    assert.equal(peek(staleLiveKey!), undefined, 'entry for the rotated-away live file is gone');
  });
});

test('rotation inside an incremental read retries the scan and equals a cold parse', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const rotator = new JsonlAppendLog<Rec>(path, { archiveDir: join(dir, 'archive'), maxBytes: 1 });
    const ledger = new ReadLedger();
    await writeFile(path, ['A', 'B', 'C', 'D'].map((id) => line(rec(id))).join(''));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    const oldLiveKey = await pageKey(path);
    await appendFile(path, line(rec('E')));
    const hooked = pair.log as unknown as { readPageSegment: (segment: unknown) => Promise<Rec[]> };
    const original = hooked.readPageSegment.bind(pair.log);
    let rotated = false;
    hooked.readPageSegment = async (segment) => {
      const records = await original(segment);
      if (!rotated) { rotated = true; await rotator.append(rec('F')); }
      return records;
    };
    // Attempt 1 reads A–E incrementally, then F's append renames that file away;
    // the retry reads the new live file and the new archive cold.
    await ledger.step('append, then rotation inside the read', { full: 2, incremental: 1 }, async () => {
      const actual = await outcome(pair.log, all(pair));
      assert.ok(rotated, 'the rotation ran inside the read');
      assert.deepEqual(actual, await outcome(pair.oracle, all(pair)));
      assert.deepEqual(ids(actual), ['F', 'E', 'D', 'C', 'B', 'A']);
    });
    await ledger.step('after rotation', { full: 0, incremental: 0 }, () => assertSame(pair, 'after rotation'));
    ledger.verify();
    assert.equal(peek(oldLiveKey), undefined, 'entry for the rotated-away live file is gone');
  });
});

test('a duplicate id written across the cached boundary keeps both append positions', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, ['A', 'X', 'B'].map((id) => line(rec(id))).join(''));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    await appendFile(path, line(rec('X', 'second X')));
    await ledger.step('append X again', { full: 0, incremental: 1 }, async () => {
      await assertSame(pair, 'append X again');
      const page = await outcome(pair.log, all(pair));
      assert.deepEqual(ids(page), ['X', 'B', 'X', 'A']);
      assert.deepEqual(page.ok && page.rows.map((row) => row.position.line), [3, 2, 1, 0]);
      // A stale position forces the id fallback: X is ambiguous, B is unique.
      const p = page.ok ? { ...page.rows[0]!.position, line: 99 } : undefined;
      for (const id of ['X', 'B']) {
        const input = { ...all(pair), anchor: { p: p!, id } };
        assert.deepEqual(await outcome(pair.log, input), await outcome(pair.oracle, input), `fallback ${id}`);
      }
      assert.match(String(ids(await outcome(pair.log, { ...all(pair), anchor: { p: p!, id: 'X' } }))), /anchor_ambiguous/);
    });
    ledger.verify();
  });
});

test('duplicate ids at different append positions inside one appended write', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, ['Z', 'A', 'Z'].map((id) => line(rec(id))).join(''));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    await appendFile(path, ['Y', 'C', 'Y'].map((id) => line(rec(id))).join(''));
    await ledger.step('append Y C Y', { full: 0, incremental: 1 }, async () => {
      await assertSame(pair, 'append Y C Y');
      const page = await outcome(pair.log, all(pair));
      assert.deepEqual(ids(page), ['Y', 'C', 'Y', 'Z', 'A', 'Z']);
      assert.deepEqual(page.ok && page.rows.map((row) => row.position.line), [5, 4, 3, 2, 1, 0]);
    });
    ledger.verify();
  });
});

test('blank lines and CRLF on both sides of the cached boundary', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, `\n${JSON.stringify(rec('a'))}\r\n\r\n${JSON.stringify(rec('b'))}\n`);
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    const appends = [`\r\n${JSON.stringify(rec('c'))}\r\n\n`, `${JSON.stringify(rec('d'))}\r\n`, '   \n', `\n\n${JSON.stringify(rec('e'))}\n`];
    for (const [i, text] of appends.entries()) {
      await appendFile(path, text);
      await ledger.step(`append ${i}`, { full: 0, incremental: 1 }, () => assertSame(pair, `append ${i}`));
    }
    assert.deepEqual(ids(await outcome(pair.log, all(pair))), ['e', 'd', 'c', 'b', 'a']);
    ledger.verify();
  });
});

async function editInPlace(path: string, from: string, to: string): Promise<void> {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const at = (await readFile(path)).indexOf(from);
  assert.ok(at >= 0, `found ${from}`);
  const handle = await open(path, 'r+');
  try { await handle.write(Buffer.from(to), 0, Buffer.byteLength(to), at); } finally { await handle.close(); }
}

test('Nicholas counterexample: same file, same tail and ids, middle edited, then an append', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, [rec('a', 'one'), rec('b', 'two'), rec('c', 'tri')].map(line).join(''));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    const before = await stat(path, { bigint: true });
    const tail = (await readFile(path)).subarray(-line(rec('c', 'tri')).length);
    await editInPlace(path, '"text":"two"', '"text":"TWO"');
    await appendFile(path, line(rec('d', 'new')));
    // Preconditions: nothing but the bytes themselves tells this from an append.
    const after = await stat(path, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.ok(after.size > before.size);
    assert.ok((await readFile(path)).subarray(0, Number(before.size)).subarray(-tail.length).equals(tail));
    await ledger.step('edit + append', { full: 1, incremental: 0 }, async () => {
      await assertSame(pair, 'edit + append');
      const page = await outcome(pair.log, all(pair));
      assert.deepEqual(ids(page), ['d', 'c', 'b', 'a']);
      assert.equal(page.ok && (page.rows[2]!.record as Rec).text, 'TWO');
    });
    ledger.verify();
  });
});

test('same-size rewrite, shrink, and shrink-then-grow past the cached size all parse in full', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, ['a', 'b', 'c'].map((id) => line(rec(id))).join(''));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));

    const sizeBefore = (await stat(path)).size;
    await editInPlace(path, '"text of b"', '"TEXT OF B"');
    // The page cache stamp is size + mtime; pin a distinct mtime so a coarse
    // filesystem clock cannot make this rewrite look unchanged.
    await utimes(path, new Date(), new Date('2030-01-01T00:00:00Z'));
    assert.equal((await stat(path)).size, sizeBefore);
    await ledger.step('same-size rewrite', { full: 1, incremental: 0 }, () => assertSame(pair, 'same-size rewrite'));

    await truncate(path, line(rec('a')).length + line(rec('b')).length);
    await ledger.step('shrink', { full: 1, incremental: 0 }, () => assertSame(pair, 'shrink'));
    await appendFile(path, line(rec('d')));
    await ledger.step('append after shrink', { full: 0, incremental: 1 }, () => assertSame(pair, 'append after shrink'));

    const cachedSize = (await stat(path)).size;
    await truncate(path, line(rec('a')).length);
    await appendFile(path, ['x', 'y', 'z'].map((id) => line(rec(id))).join(''));
    assert.ok((await stat(path)).size > cachedSize, 'grew past the cached size');
    await ledger.step('shrink then grow', { full: 1, incremental: 0 }, async () => {
      await assertSame(pair, 'shrink then grow');
      assert.deepEqual(ids(await outcome(pair.log, all(pair))), ['z', 'y', 'x', 'a']);
    });
    ledger.verify();
  });
});

test('a half-written trailing line fails like the full parse, then completes incrementally', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, ['a', 'b'].map((id) => line(rec(id))).join(''));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    await appendFile(path, '{"id":"c","text":"hal');
    await ledger.step('half line', { full: 0, incremental: 0 }, async () => {
      await assertSame(pair, 'half line');
      assert.match(String(ids(await outcome(pair.log, all(pair)))), /^SyntaxError::/);
    });
    await appendFile(path, 'f"}\n');
    await ledger.step('line completed', { full: 0, incremental: 1 }, async () => {
      await assertSame(pair, 'line completed');
      assert.deepEqual(ids(await outcome(pair.log, all(pair))), ['c', 'b', 'a']);
    });
    ledger.verify();
  });
});

test('a cached read without a trailing newline is never extended: objects, the joined line throws', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, line(rec('a')) + JSON.stringify(rec('b')));
    await ledger.step('seed without newline', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    await appendFile(path, line(rec('c')));
    await ledger.step('append continues line', { full: 0, incremental: 0 }, async () => {
      await assertSame(pair, 'append continues line');
      assert.match(String(ids(await outcome(pair.log, all(pair)))), /^SyntaxError::/);
    });
    ledger.verify();
  });
});

test('a cached read without a trailing newline is never extended: numbers, the joined line parses as 23', async () => {
  await withTempAnimaHome(async (dir) => {
    const ledger = new ReadLedger();
    const numbers = pairFor<number>(join(dir, 'numbers.jsonl'), String, liveOnly(dir));
    await writeFile(numbers.log.path, '1\n2');
    await ledger.step('numbers seed', { full: 1, incremental: 0 }, () => assertSame(numbers, 'numbers seed'));
    await appendFile(numbers.log.path, '3\n');
    await ledger.step('numbers append', { full: 1, incremental: 0 }, async () => {
      await assertSame(numbers, 'numbers append');
      const page = await outcome(numbers.log, all(numbers));
      assert.deepEqual(page.ok && page.rows.map((row) => row.record), [23, 1]);
    });
    ledger.verify();
  });
});

test('a new file at the live path with the same leading bytes is read cold', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, ['a', 'b'].map((id) => line(rec(id))).join(''));
    await ledger.step('seed', { full: 1, incremental: 0 }, () => assertSame(pair, 'seed'));
    const oldKey = await pageKey(path);
    const copy = join(dir, 'copy.jsonl');
    await copyFile(path, copy);
    await appendFile(copy, line(rec('c')));
    await rename(copy, path);
    assert.notEqual(await pageKey(path), oldKey, 'a different file now sits at the path');
    await ledger.step('replaced by a longer copy', { full: 1, incremental: 0 }, () => assertSame(pair, 'replaced'));
    await appendFile(path, line(rec('d')));
    await ledger.step('append to the copy', { full: 0, incremental: 1 }, () => assertSame(pair, 'append to the copy'));
    ledger.verify();
    assert.equal(peek(oldKey), undefined, 'entry for the replaced file is gone');
  });
});

test('a continuation anchor taken before appends continues identically after them', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    const pair = pairFor<Rec>(path, recId, liveOnly(dir));
    const ledger = new ReadLedger();
    await writeFile(path, ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => line(rec(id))).join(''));
    const first = await outcome(pair.log, { ...all(pair), limit: 2 });
    assert.deepEqual(ids(first), ['F', 'E']);
    const last = first.ok ? first.rows[1]! : undefined;
    const anchor = { p: last!.position, id: 'E' };
    await pair.log.append(rec('G'));
    await pair.log.append(rec('H'));
    await ledger.step('continuation after appends', { full: 0, incremental: 1 }, async () => {
      const input = { ...all(pair), limit: 2, anchor };
      const actual = await outcome(pair.log, input);
      assert.deepEqual(actual, await outcome(pair.oracle, input));
      assert.deepEqual(ids(actual), ['D', 'C']);
      await assertSame(pair, 'after appends');
    });
    ledger.verify();
  });
});
