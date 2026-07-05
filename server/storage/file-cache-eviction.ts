import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveAnimaHome } from '../anima-home.js';

// Platform file caches are reconstructable, so keep each platform under 1 GiB.
export const PLATFORM_FILE_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
// Fresh entries are pinned to avoid deleting concurrent downloads or bursts.
export const PLATFORM_FILE_CACHE_PIN_MS = 24 * 60 * 60 * 1000;
// Sweeps are best-effort background work; avoid scanning the same root repeatedly.
export const PLATFORM_FILE_CACHE_SWEEP_THROTTLE_MS = 60 * 60 * 1000;

export interface SweepPlatformFileCacheInput {
  entryDepth: number;
  maxBytes?: number;
  nowMs?: number;
  rootDir: string;
}

interface FileCacheEntry {
  mtimeMs: number;
  path: string;
  sizeBytes: number;
}

const runningSweeps = new Map<string, Promise<void>>();
const lastSweepMs = new Map<string, number>();

export function triggerSlackFileCacheEviction(): void {
  triggerPlatformFileCacheEviction({
    entryDepth: 2,
    rootDir: slackFileCacheRoot(),
  });
}

export function triggerFeishuFileCacheEviction(): void {
  triggerPlatformFileCacheEviction({
    entryDepth: 1,
    rootDir: feishuFileCacheRoot(),
  });
}

export function triggerPlatformFileCacheEviction(input: SweepPlatformFileCacheInput & {
  runSweep?: () => Promise<void>;
}): void {
  if (runningSweeps.has(input.rootDir)) return;
  const nowMs = input.nowMs ?? Date.now();
  const lastRunMs = lastSweepMs.get(input.rootDir);
  if (lastRunMs !== undefined && nowMs - lastRunMs < PLATFORM_FILE_CACHE_SWEEP_THROTTLE_MS) return;

  lastSweepMs.set(input.rootDir, nowMs);
  const runSweep = input.runSweep ?? (() => sweepPlatformFileCacheRoot(input));
  const sweep = Promise.resolve()
    .then(runSweep)
    .catch((error: unknown) => {
      console.warn(`File cache eviction failed for ${input.rootDir}: ${errorMessage(error)}`);
    })
    .finally(() => {
      if (runningSweeps.get(input.rootDir) === sweep) runningSweeps.delete(input.rootDir);
    });
  runningSweeps.set(input.rootDir, sweep);
}

export async function sweepPlatformFileCacheRoot(input: SweepPlatformFileCacheInput): Promise<void> {
  const maxBytes = input.maxBytes ?? PLATFORM_FILE_CACHE_MAX_BYTES;
  const nowMs = input.nowMs ?? Date.now();
  const entries = await collectFileCacheEntries(input.rootDir, input.entryDepth);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (totalBytes <= maxBytes) return;

  const pinnedAfterMs = nowMs - PLATFORM_FILE_CACHE_PIN_MS;
  const candidates = entries
    .filter((entry) => entry.mtimeMs <= pinnedAfterMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const entry of candidates) {
    await rm(entry.path, { force: true, recursive: true });
    totalBytes -= entry.sizeBytes;
    if (totalBytes <= maxBytes) return;
  }
}

export function slackFileCacheRoot(): string {
  return join(resolveAnimaHome(), 'cache', 'slack', 'files');
}

export function feishuFileCacheRoot(): string {
  return join(resolveAnimaHome(), 'cache', 'feishu', 'files');
}

async function collectFileCacheEntries(rootDir: string, entryDepth: number): Promise<FileCacheEntry[]> {
  const entryDirs = await collectEntryDirs(rootDir, entryDepth);
  return await Promise.all(entryDirs.map(scanFileCacheEntry));
}

async function collectEntryDirs(rootDir: string, entryDepth: number): Promise<string[]> {
  let dirs = [rootDir];
  for (let depth = 0; depth < entryDepth; depth += 1) {
    const nextDirs: string[] = [];
    for (const dir of dirs) {
      let dirents: { isDirectory(): boolean; name: string }[];
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      for (const dirent of dirents) {
        if (dirent.isDirectory()) nextDirs.push(join(dir, dirent.name));
      }
    }
    dirs = nextDirs;
  }
  return dirs;
}

async function scanFileCacheEntry(entryDir: string): Promise<FileCacheEntry> {
  const entryStat = await stat(entryDir);
  const stack = [entryDir];
  let mtimeMs = entryStat.mtimeMs;
  let sizeBytes = 0;

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!dirent.isFile()) continue;
      const fileStat = await stat(path);
      sizeBytes += fileStat.size;
      mtimeMs = Math.max(mtimeMs, fileStat.mtimeMs);
    }
  }

  return { mtimeMs, path: entryDir, sizeBytes };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
