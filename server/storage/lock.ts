import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParentDirectory } from './write-root.js';

const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 5 * 60 * 1000;
// A steal takes milliseconds; a steal marker this old was left by a waiter that died mid-steal.
const STEAL_STALE_MS = 30 * 1000;

interface LockOwner {
  createdAt: number;
  pid: number;
}

const inProcessLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  targetPath: string,
  writeRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  return chainInProcess(targetPath, async () => {
    await ensureParentDirectory(targetPath, writeRoot);
    const lockDir = `${targetPath}.lock`;
    await acquireLock(lockDir);
    try {
      return await operation();
    } finally {
      await rm(lockDir, { force: true, recursive: true });
    }
  });
}

async function chainInProcess<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  inProcessLocks.set(key, next);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (inProcessLocks.get(key) === next) {
      inProcessLocks.delete(key);
    }
  }
}

async function acquireLock(lockDir: string): Promise<void> {
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(
          join(lockDir, 'owner.json'),
          `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`,
          'utf8',
        );
      } catch (error) {
        await rm(lockDir, { force: true, recursive: true }).catch(() => undefined);
        throw error;
      }
      return;
    } catch (error) {
      if (!isEexist(error)) throw error;
      if (await removeStaleLock(lockDir)) continue;
      await sleep(LOCK_WAIT_MS);
    }
  }
}

// Waiters that find the same stale lock must not each remove it: the first
// one removes it and takes a fresh lock, and a second removal would delete
// that fresh lock, leaving two holders. So removal happens under a steal
// marker (a second mkdir lock), one waiter at a time, and only after checking
// again under the marker that the lock is still stale.
async function removeStaleLock(lockDir: string): Promise<boolean> {
  if (!await isStaleLock(lockDir)) return false;
  const stealDir = `${lockDir}.steal`;
  try {
    await mkdir(stealDir);
  } catch (error) {
    if (!isEexist(error)) throw error;
    if (await isOlderThan(stealDir, STEAL_STALE_MS)) await rm(stealDir, { force: true, recursive: true });
    return false;
  }
  try {
    if (!await isStaleLock(lockDir)) return false;
    await rm(lockDir, { force: true, recursive: true });
    return true;
  } finally {
    await rm(stealDir, { force: true, recursive: true });
  }
}

async function isStaleLock(lockDir: string): Promise<boolean> {
  const owner = await readLockOwner(lockDir);
  if (!owner) return isOlderThan(lockDir, LOCK_STALE_MS);
  return Date.now() - owner.createdAt > LOCK_STALE_MS || !isPidRunning(owner.pid);
}

async function readLockOwner(lockDir: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')) as Partial<LockOwner>;
    if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.pid)) return undefined;
    return { createdAt: Number(value.createdAt), pid: Number(value.pid) };
  } catch {
    return undefined;
  }
}

async function isOlderThan(path: string, ms: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > ms;
  } catch {
    return false;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isEexist(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
