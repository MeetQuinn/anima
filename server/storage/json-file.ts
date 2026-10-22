import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { withFileLock } from './lock.js';
import { currentWriteRoot, ensureParentDirectory } from './write-root.js';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: unknown;
}

const MAX_CACHE_ENTRIES = 256;
const cache = new Map<string, CacheEntry>();

export function cacheHit<T>(path: string, stat: { mtimeMs: number; size: number }): T | undefined {
  const entry = cache.get(path);
  if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
    cache.delete(path);
    cache.set(path, entry);
    return entry.value as T;
  }
  return undefined;
}

export function cacheSet(path: string, value: unknown, stat: { mtimeMs: number; size: number }): void {
  cache.delete(path);
  cache.set(path, { value, mtimeMs: stat.mtimeMs, size: stat.size });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** The cached value for `path` whatever its stamp, without refreshing its LRU slot. */
export function cachePeek<T>(path: string): T | undefined {
  return cache.get(path)?.value as T | undefined;
}

export function cacheDelete(path: string): void {
  cache.delete(path);
}

export class JsonFile<T> {
  /**
   * The write root as it stood when this store was created. Captured once, on
   * purpose: an explicit env or async scope may change after construction,
   * but this file must keep protecting the root its path belongs to.
   * See storage/write-root.ts.
   */
  private readonly writeRoot: string;

  constructor(
    readonly path: string,
    private readonly empty: () => T,
    writeRoot: string = currentWriteRoot(),
    private readonly mode?: number,
  ) {
    this.writeRoot = writeRoot;
  }

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
    await withFileLock(this.path, this.writeRoot, async () => {
      await writeAtomic(this.path, serializeJson(value), this.writeRoot, this.mode);
      await this.refreshCache(value);
    });
  }

  /**
   * Read, transform and write under the file lock. An op that returns the
   * object it was given writes nothing. A new object (what every JsonStore
   * passes, since it re-parses each result) is written unless it serializes
   * to the bytes already on disk; then the mtime stays and every process's
   * cached copy stays valid. For a new object, a missing file is always
   * written. When the bytes match, a store with a file mode corrects the
   * file's permissions in place rather than rewriting it.
   */
  async update(op: (current: T) => T | Promise<T>): Promise<T> {
    return withFileLock(this.path, this.writeRoot, async () => {
      const { text, value: current } = await this.readUnlockedText();
      const next = await op(current);
      if (next === current) return next;
      const serialized = serializeJson(next);
      if (serialized === text) {
        if (this.mode !== undefined) await applyMode(this.path, this.mode);
        return next;
      }
      await writeAtomic(this.path, serialized, this.writeRoot, this.mode);
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
    return (await this.readUnlockedText()).value;
  }

  /** `text` is the file's exact bytes, or undefined when the file is missing. */
  private async readUnlockedText(): Promise<{ text?: string; value: T }> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return { value: this.empty() };
      throw error;
    }
    return { text, value: JSON.parse(text) as T };
  }
}

async function applyMode(path: string, mode: number): Promise<void> {
  try {
    if (((await stat(path)).mode & 0o777) !== mode) await chmod(path, mode);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Defense in depth. Every public caller reaches withFileLock's guard first, so
// this one is unreachable as the operative check today. It is here for a future
// caller that writes outside the lock.
async function writeAtomic(path: string, serialized: string, writeRoot: string, mode?: number): Promise<void> {
  await ensureParentDirectory(path, writeRoot);
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, serialized, { encoding: 'utf8', mode });
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
