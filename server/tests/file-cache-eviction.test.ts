import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PLATFORM_FILE_CACHE_PIN_MS,
  sweepPlatformFileCacheRoot,
  triggerPlatformFileCacheEviction,
} from '../storage/file-cache-eviction.js';
import { FeishuFileService } from '../feishu/feishu-file.service.js';
import { SlackFileService } from '../slack/slack-file.service.js';
import { slackFileCacheDir } from '../storage/schema/cache.js';
import { withAnimaHome } from './anima-home.js';

test('file cache sweep does not delete entries under the 24h pin floor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-file-cache-pin-'));
  try {
    const nowMs = Date.UTC(2026, 0, 2);
    const oldEntry = await writeEntry(root, 'old', 10, nowMs - PLATFORM_FILE_CACHE_PIN_MS - 1_000);
    const freshEntry = await writeEntry(root, 'fresh', 100, nowMs - 5_000);

    await sweepPlatformFileCacheRoot({ entryDepth: 1, maxBytes: 1, nowMs, rootDir: root });

    await assert.rejects(stat(oldEntry), /ENOENT/);
    assert.ok((await stat(freshEntry)).isDirectory());
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('file cache sweep evicts oldest entries first and keeps newest entries that fit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-file-cache-lru-'));
  try {
    const nowMs = Date.UTC(2026, 0, 2);
    const oldEntry = await writeEntry(root, 'T1/F-old', 10, nowMs - PLATFORM_FILE_CACHE_PIN_MS - 3_000);
    const middleEntry = await writeEntry(root, 'T1/F-middle', 10, nowMs - PLATFORM_FILE_CACHE_PIN_MS - 2_000);
    const newEntry = await writeEntry(root, 'T2/F-new', 10, nowMs - PLATFORM_FILE_CACHE_PIN_MS - 1_000);

    await sweepPlatformFileCacheRoot({ entryDepth: 2, maxBytes: 25, nowMs, rootDir: root });

    await assert.rejects(stat(oldEntry), /ENOENT/);
    assert.ok((await stat(middleEntry)).isDirectory());
    assert.ok((await stat(newEntry)).isDirectory());
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('fire-and-forget cache eviction logs sweep failures without rejecting the trigger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-file-cache-trigger-'));
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    triggerPlatformFileCacheEviction({
      entryDepth: 1,
      rootDir: root,
      runSweep: async () => {
        throw new Error('sweep failed');
      },
    });

    await waitForMicrotasks();
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /sweep failed/);
  } finally {
    console.warn = originalWarn;
    await rm(root, { force: true, recursive: true });
  }
});

test('fire-and-forget cache eviction is single-flight and throttled per root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-file-cache-single-flight-'));
  try {
    let runs = 0;
    let resolveFirstRun: (() => void) | undefined;
    const firstRun = new Promise<void>((resolve) => {
      resolveFirstRun = resolve;
    });
    const runSweep = async () => {
      runs += 1;
      await firstRun;
    };

    triggerPlatformFileCacheEviction({ entryDepth: 1, rootDir: root, runSweep });
    triggerPlatformFileCacheEviction({ entryDepth: 1, rootDir: root, runSweep });
    await waitForMicrotasks();
    assert.equal(runs, 1);

    resolveFirstRun?.();
    await waitForMicrotasks();

    triggerPlatformFileCacheEviction({ entryDepth: 1, rootDir: root, runSweep });
    await waitForMicrotasks();
    assert.equal(runs, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Slack file download caches bytes and metadata before triggering isolated eviction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-file-cache-slack-service-'));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(Buffer.from('hello'), {
      status: 200,
      headers: { 'content-length': '5' },
    })) as typeof fetch;

    await withAnimaHome(home, async () => {
      const service = new SlackFileService();
      const result = await service.downloadToCache({
        file: {
          id: 'F1',
          mimetype: 'text/plain',
          name: 'hello.txt',
          sizeBytes: 5,
          urlPrivate: 'https://files.slack.com/F1',
        },
        teamId: 'T1',
        token: 'xoxb-token',
      });

      assert.equal('downloadError' in result, false);
      assert.equal(await readFile(join(slackFileCacheDir('T1', 'F1'), 'hello.txt'), 'utf8'), 'hello');
      const meta = JSON.parse(await readFile(join(slackFileCacheDir('T1', 'F1'), 'meta.json'), 'utf8')) as { sizeBytes?: number };
      assert.equal(meta.sizeBytes, 5);
      await waitForMicrotasks();
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { force: true, recursive: true });
  }
});

test('Feishu file writes keep bytes and metadata together before triggering isolated eviction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-file-cache-feishu-service-'));
  try {
    await withAnimaHome(home, async () => {
      const service = new FeishuFileService();
      const path = await service.writeToCache({
        file: {
          bytes: Buffer.from('feishu'),
          contentType: 'text/plain',
          filename: 'note.txt',
        },
        ref: {
          fileId: 'feishu:message:om_1:file:file_1',
          fileKey: 'file_1',
          messageId: 'om_1',
          resourceType: 'file',
        },
      });

      assert.equal(await readFile(path, 'utf8'), 'feishu');
      const meta = JSON.parse(await readFile(join(path, '..', 'meta.json'), 'utf8')) as { fileId?: string; sizeBytes?: number };
      assert.equal(meta.fileId, 'feishu:message:om_1:file:file_1');
      assert.equal(meta.sizeBytes, 6);
      await waitForMicrotasks();
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

async function writeEntry(root: string, relativeDir: string, sizeBytes: number, mtimeMs: number): Promise<string> {
  const dir = join(root, relativeDir);
  const bytesPath = join(dir, 'bytes.bin');
  const metaPath = join(dir, 'meta.json');
  await mkdir(dir, { recursive: true });
  await writeFile(bytesPath, Buffer.alloc(sizeBytes));
  await writeFile(metaPath, '{}');
  await touch(bytesPath, mtimeMs);
  await touch(metaPath, mtimeMs);
  await touch(dir, mtimeMs);
  return dir;
}

async function touch(path: string, mtimeMs: number): Promise<void> {
  const date = new Date(mtimeMs);
  await utimes(path, date, date);
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
