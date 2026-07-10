import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParentDirectory } from './write-root.js';

const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 5 * 60 * 1000;

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
      await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`, 'utf8');
      return;
    } catch (error) {
      if (!isEexist(error)) throw error;
      if (await removeStaleLock(lockDir)) continue;
      await sleep(LOCK_WAIT_MS);
    }
  }
}

async function removeStaleLock(lockDir: string): Promise<boolean> {
  const owner = await readLockOwner(lockDir);
  if (!owner) return false;
  const staleByAge = Date.now() - owner.createdAt > LOCK_STALE_MS;
  const staleByPid = !isPidRunning(owner.pid);
  if (!staleByAge && !staleByPid) return false;
  await rm(lockDir, { force: true, recursive: true });
  return true;
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
