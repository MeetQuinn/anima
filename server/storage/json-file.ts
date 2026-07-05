import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { withFileLock } from './lock.js';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

export function cacheHit<T>(path: string, stat: { mtimeMs: number; size: number }): T | undefined {
  const entry = cache.get(path);
  if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
    return entry.value as T;
  }
  return undefined;
}

export function cacheSet(path: string, value: unknown, stat: { mtimeMs: number; size: number }): void {
  cache.set(path, { value, mtimeMs: stat.mtimeMs, size: stat.size });
}

export function cacheDelete(path: string): void {
  cache.delete(path);
}

export class JsonFile<T> {
  constructor(
    readonly path: string,
    private readonly empty: () => T,
  ) {}

  async read(): Promise<T> {
    const fileStat = await statOrNull(this.path);
    if (fileStat) {
      const hit = cacheHit<T>(this.path, fileStat);
      if (hit !== undefined) return hit;
    }
    const value = await this.readUnlocked();
    if (fileStat) {
      cacheSet(this.path, value, fileStat);
    }
    return value;
  }

  async write(value: T): Promise<void> {
    await withFileLock(this.path, async () => {
      await writeAtomic(this.path, value);
      await this.refreshCache(value);
    });
  }

  async update(op: (current: T) => T | Promise<T>): Promise<T> {
    return withFileLock(this.path, async () => {
      const current = await this.readUnlocked();
      const next = await op(current);
      if (next === current) return next;
      await writeAtomic(this.path, next);
      await this.refreshCache(next);
      return next;
    });
  }

  private async refreshCache(value: T): Promise<void> {
    const fileStat = await statOrNull(this.path);
    if (fileStat) {
      cacheSet(this.path, value, fileStat);
    } else {
      cacheDelete(this.path);
    }
  }

  private async readUnlocked(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as T;
    } catch (error) {
      if (isMissingFile(error)) return this.empty();
      throw error;
    }
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function statOrNull(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const result = await stat(path);
    return { mtimeMs: result.mtimeMs, size: result.size };
  } catch {
    return undefined;
  }
}

export function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
