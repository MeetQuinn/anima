import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { JsonFile } from '../storage/json-file.js';
import { JsonlAppendLog } from '../storage/jsonl-log.js';

test('JsonFile cache invalidates when another writer changes the file on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonfile-cache-'));
  try {
    const path = join(dir, 'value.json');
    const reader = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));
    const writer = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));

    await writer.write({ count: 1 });
    assert.deepEqual(await reader.read(), { count: 1 });

    await new Promise((resolve) => setTimeout(resolve, 10));

    await writeFile(path, `${JSON.stringify({ count: 2 })}\n`, 'utf8');
    assert.deepEqual(await reader.read(), { count: 2 }, 'reader should see the external write via stat invalidation');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonlAppendLog cache invalidates when another writer appends to the file on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonl-cache-'));
  try {
    const path = join(dir, 'log.jsonl');
    const log = new JsonlAppendLog<{ id: string }>(path);

    await log.append({ id: 'a' });
    assert.deepEqual(await log.readAll(), [{ id: 'a' }]);

    await new Promise((resolve) => setTimeout(resolve, 10));

    await writeFile(path, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n`, 'utf8');
    assert.deepEqual(await log.readAll(), [{ id: 'a' }, { id: 'b' }], 'readAll should see the external append');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonlAppendLog rotates active files and reads archives chronologically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonl-rotate-'));
  const realNow = Date.now;
  try {
    Date.now = () => 1;
    const path = join(dir, 'activity.jsonl');
    const archiveDir = join(dir, 'activity.archive');
    const log = new JsonlAppendLog<{ id: string }>(path, { archiveDir, maxBytes: 1 });

    await log.append({ id: 'a' });
    await log.append({ id: 'b' });
    await log.append({ id: 'c' });

    const archives = await readdir(archiveDir);
    assert.equal(archives.length, 2);
    assert.deepEqual(await log.readAll(), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.deepEqual(await log.readTail(1), [{ id: 'c' }]);
    assert.deepEqual(await log.readTail(2), [{ id: 'b' }, { id: 'c' }]);
  } finally {
    Date.now = realNow;
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonlAppendLog keeps every archive by default (no maxArchives)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonl-no-prune-'));
  const realNow = Date.now;
  try {
    // Monotonic clock: each 10MB rotation gets a strictly greater stamp in
    // production, so archive names sort chronologically. Mirror that here.
    let now = 1;
    Date.now = () => now++;
    const path = join(dir, 'activity.jsonl');
    const archiveDir = join(dir, 'activity.archive');
    const log = new JsonlAppendLog<{ id: string }>(path, { archiveDir, maxBytes: 1 });

    // 5 appends ⇒ 4 rotations ⇒ 4 archive segments, none pruned.
    for (const id of ['a', 'b', 'c', 'd', 'e']) await log.append({ id });

    assert.equal((await readdir(archiveDir)).length, 4);
    assert.deepEqual((await log.readAll()).map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
  } finally {
    Date.now = realNow;
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonlAppendLog maxArchives prunes oldest segments past the cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonl-prune-'));
  const realNow = Date.now;
  try {
    let now = 1;
    Date.now = () => now++;
    const path = join(dir, 'activity.jsonl');
    const archiveDir = join(dir, 'activity.archive');
    const log = new JsonlAppendLog<{ id: string }>(path, { archiveDir, maxBytes: 1, maxArchives: 2 });

    // 5 appends ⇒ 4 rotations, but only the newest 2 archives survive.
    for (const id of ['a', 'b', 'c', 'd', 'e']) await log.append({ id });

    assert.equal((await readdir(archiveDir)).length, 2, 'only maxArchives segments retained');
    // a, b pruned; c, d archived; e active.
    assert.deepEqual((await log.readAll()).map((r) => r.id), ['c', 'd', 'e']);
  } finally {
    Date.now = realNow;
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonlAppendLog maxArchives prunes only its own segments in a shared archive dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonl-prune-scoped-'));
  const realNow = Date.now;
  try {
    let now = 100;
    Date.now = () => now++;
    const archiveDir = join(dir, 'shared.archive');
    // A foreign segment from another log living in the same archive dir.
    await mkdir(archiveDir, { recursive: true });
    const foreign = join(archiveDir, '0000000000001-other-000.jsonl');
    await writeFile(foreign, `${JSON.stringify({ id: 'foreign' })}\n`, 'utf8');

    const path = join(dir, 'activity.jsonl');
    const log = new JsonlAppendLog<{ id: string }>(path, { archiveDir, maxBytes: 1, maxArchives: 1 });

    for (const id of ['a', 'b', 'c']) await log.append({ id });

    const names = (await readdir(archiveDir)).sort();
    // Foreign file untouched; only this log's own newest segment kept.
    assert.ok(names.includes('0000000000001-other-000.jsonl'), 'foreign archive must survive');
    const ownArchives = names.filter((n) => /-activity-\d{3}\.jsonl$/.test(n));
    assert.equal(ownArchives.length, 1, 'only maxArchives of this log kept');
  } finally {
    Date.now = realNow;
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonlAppendLog appendIf dedupes across rotated archives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonl-rotate-dedupe-'));
  try {
    const path = join(dir, 'messages.jsonl');
    const log = new JsonlAppendLog<{ id: string }>(path, {
      archiveDir: join(dir, 'messages.archive'),
      maxBytes: 1,
    });

    await log.append({ id: 'a' });
    await log.append({ id: 'b' });
    const result = await log.appendIf({ id: 'a' }, (records) => !records.some((record) => record.id === 'a'));

    assert.equal(result.appended, false);
    assert.deepEqual(await log.readAll(), [{ id: 'a' }, { id: 'b' }]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonlAppendLog appendIfRecent dedupes only within the recent tail window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonl-recent-dedupe-'));
  try {
    const path = join(dir, 'messages.jsonl');
    const log = new JsonlAppendLog<{ id: string }>(path, {
      archiveDir: join(dir, 'messages.archive'),
      maxBytes: 1,
    });

    await log.append({ id: 'old' });
    await log.append({ id: 'recent' });
    const oldDuplicate = await log.appendIfRecent(
      { id: 'old' },
      (records) => !records.some((record) => record.id === 'old'),
      1,
    );
    const recentDuplicate = await log.appendIfRecent(
      { id: 'recent' },
      (records) => !records.some((record) => record.id === 'recent'),
      10,
    );

    assert.equal(oldDuplicate.appended, true);
    assert.equal(recentDuplicate.appended, false);
    assert.deepEqual((await log.readAll()).map((record) => record.id), ['old', 'recent', 'old']);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonFile cache serves the warm value across two readers in the same process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonfile-warm-'));
  try {
    const path = join(dir, 'cached.json');
    const writer = new JsonFile<{ n: number }>(path, () => ({ n: 0 }));
    const reader = new JsonFile<{ n: number }>(path, () => ({ n: 0 }));

    await writer.write({ n: 42 });
    const first = await reader.read();
    const second = await reader.read();
    assert.deepEqual(first, { n: 42 });
    assert.deepEqual(second, { n: 42 });
    assert.strictEqual(first, second, 'cached reads share a reference; callers must not mutate the returned value');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('JsonFile update skips same-reference writes and persists new objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-jsonfile-update-noop-'));
  try {
    const path = join(dir, 'value.json');
    const file = new JsonFile<{ count: number }>(path, () => ({ count: 0 }));

    await file.write({ count: 1 });
    const beforeStat = await stat(path);
    const beforeContent = await readFile(path, 'utf8');

    await new Promise((resolve) => setTimeout(resolve, 10));
    const same = await file.update((current) => current);
    const afterNoopStat = await stat(path);
    const afterNoopContent = await readFile(path, 'utf8');

    assert.deepEqual(same, { count: 1 });
    assert.equal(afterNoopStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterNoopContent, beforeContent);
    assert.deepEqual(await file.read(), { count: 1 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const changed = await file.update((current) => ({ count: current.count + 1 }));
    const afterWriteStat = await stat(path);

    assert.deepEqual(changed, { count: 2 });
    assert.ok(afterWriteStat.mtimeMs > afterNoopStat.mtimeMs);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { count: 2 });
    assert.deepEqual(await file.read(), { count: 2 });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
