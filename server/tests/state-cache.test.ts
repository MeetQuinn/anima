import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
