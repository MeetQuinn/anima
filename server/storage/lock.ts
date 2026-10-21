import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParentDirectory } from './write-root.js';

const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 5 * 60 * 1000;
const ROOT_RECORD = 'owner.json';

// A lock is a directory. Its holder is the last record in a chain of owner
// files inside it: `owner.json` names whoever created the lock, and
// `next-<id>.json` names whoever took it over from record <id>.
//
// A waiter that finds the holder stale (its process is gone, or it has held
// the lock for over 5 minutes) takes over by creating that holder's `next-`
// record. The create is exclusive, so only one waiter can follow a given
// holder. Taking over never deletes anything. A waiter acting on an old view
// can at worst add a record that nothing in the current chain points to, so
// the chain ignores it. Only the holder removes the directory, on release.

interface LockOwner {
  createdAt: number;
  pid: number;
  /** Absent in records written before takeover records existed. */
  token?: string;
}

interface LockRecord {
  id: string;
  stale: boolean;
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
    const token = await acquireLock(lockDir);
    try {
      return await operation();
    } finally {
      await releaseLock(lockDir, token);
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

async function acquireLock(lockDir: string): Promise<string> {
  while (true) {
    let created = false;
    try {
      await mkdir(lockDir);
      created = true;
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
    const token = created ? await addRootToNewLock(lockDir) : await takeOverIfStale(lockDir);
    if (token) return token;
    if (!created) await sleep(LOCK_WAIT_MS);
  }
}

async function addRootToNewLock(lockDir: string): Promise<string | undefined> {
  try {
    return await addRecord(lockDir, ROOT_RECORD);
  } catch (error) {
    await rm(lockDir, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function takeOverIfStale(lockDir: string): Promise<string | undefined> {
  const holder = await readHolder(lockDir);
  if (!holder) {
    // No root record: its creator is between mkdir and that first write, or
    // died there.
    if (!await isOlderThan(lockDir, LOCK_STALE_MS)) return undefined;
    return addRecord(lockDir, ROOT_RECORD);
  }
  if (!holder.stale) return undefined;
  const token = await addRecord(lockDir, `next-${holder.id}.json`);
  if (!token) return undefined;
  // The lock read above may have been released and created again since. The
  // new record then follows nothing in the current chain, and this waiter
  // keeps waiting.
  return (await readHolder(lockDir))?.id === token ? token : undefined;
}

async function releaseLock(lockDir: string, token: string): Promise<void> {
  // Only the holder removes the lock. A caller that ran past LOCK_STALE_MS
  // can be taken over while it still runs, and the lock is then its
  // successor's. With no root record left, a successor has released it already.
  if ((await readHolder(lockDir))?.id !== token) return;
  // Remove the root first. Until the directory is gone, waiters then read an
  // ownerless lock that was just modified and wait. A recursive remove that
  // deleted the last `next-` record first would briefly make an earlier, dead
  // holder look current.
  await rm(join(lockDir, ROOT_RECORD), { force: true });
  await rm(lockDir, { force: true, maxRetries: 3, recursive: true });
}

/**
 * Creates a record naming this process, unless a record of that name already
 * exists. Returns the record's token, or undefined if another waiter created it
 * first or the lock directory is gone.
 */
async function addRecord(lockDir: string, name: string): Promise<string | undefined> {
  const token = randomUUID();
  const owner: LockOwner = { createdAt: Date.now(), pid: process.pid, token };
  try {
    await writeFile(join(lockDir, name), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
    return token;
  } catch (error) {
    if (isEexist(error) || isEnoent(error)) return undefined;
    throw error;
  }
}

/** The end of the lock's chain, or undefined if it has no root record (or no longer exists). */
async function readHolder(lockDir: string): Promise<LockRecord | undefined> {
  let holder = await readRecord(join(lockDir, ROOT_RECORD));
  const seen = new Set<string>();
  while (holder && !seen.has(holder.id)) {
    seen.add(holder.id);
    const next = await readRecord(join(lockDir, `next-${holder.id}.json`));
    if (!next) return holder;
    holder = next;
  }
  return holder;
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const owner = parseOwner(text);
  if (owner) {
    return {
      id: owner.token ?? `${owner.pid}-${owner.createdAt}`,
      stale: Date.now() - owner.createdAt > LOCK_STALE_MS || !isPidRunning(owner.pid),
    };
  }
  // Unparseable: a record still being written, or a damaged one. Judged by age.
  try {
    const info = await stat(path);
    return { id: `ino-${info.ino}`, stale: Date.now() - info.mtimeMs > LOCK_STALE_MS };
  } catch {
    return undefined;
  }
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.pid)) return undefined;
    // The token becomes part of a file name.
    if (value.token !== undefined && !(typeof value.token === 'string' && /^[A-Za-z0-9-]+$/.test(value.token))) {
      return undefined;
    }
    return {
      createdAt: Number(value.createdAt),
      pid: Number(value.pid),
      ...(value.token ? { token: value.token } : {}),
    };
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

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
