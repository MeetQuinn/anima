import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParentDirectory } from './write-root.js';

const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 5 * 60 * 1000;
const ROOT_RECORD = 'owner.json';

// A lock is a directory. Its holder is the last record in a chain of owner
// files inside it: `owner.json` names whoever created the lock, and
// `next-<id>.json` names whoever took it over from record <id>.
//
// The directory never exists without its root record. A new lock is built
// under a private name and renamed into place, which fails if a lock is already
// there. Release renames the lock aside the same way before deleting it. So no
// waiter ever sees a lock half made or half removed.
//
// A waiter that finds the holder stale (its process is gone, or it has held
// the lock for over 5 minutes) takes over by creating that holder's `next-`
// record. The create is exclusive, so only one waiter can follow a given
// holder. Only the holder's release removes a lock. A waiter acting on an old
// view can at worst add a record that nothing in the current chain points to,
// so the chain ignores it.

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
    const token = await tryAcquire(lockDir);
    if (token) return token;
    await sleep(LOCK_WAIT_MS);
  }
}

async function tryAcquire(lockDir: string): Promise<string | undefined> {
  const dir = await statOrUndefined(lockDir);
  if (!dir) return createLock(lockDir);
  const holder = await readHolder(lockDir);
  if (holder) return holder.stale ? takeOver(lockDir, holder) : undefined;
  // A lock directory with no root record was made by an older version, which
  // writes the record after its mkdir. Its creator gets 5 minutes to write
  // it. After that the rename replaces the directory, but only if it is still
  // empty.
  return Date.now() - dir.mtimeMs > LOCK_STALE_MS ? createLock(lockDir) : undefined;
}

/** Returns the new lock's token, or undefined if a lock is already there. */
async function createLock(lockDir: string): Promise<string | undefined> {
  const token = randomUUID();
  const staged = `${lockDir}.new-${token}`;
  await mkdir(staged);
  let placed = false;
  try {
    await writeFile(join(staged, ROOT_RECORD), ownerRecord(token), 'utf8');
    await rename(staged, lockDir);
    placed = true;
    return token;
  } catch (error) {
    if (isEexist(error) || isEnotempty(error)) return undefined;
    throw error;
  } finally {
    if (!placed) await rm(staged, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function takeOver(lockDir: string, holder: LockRecord): Promise<string | undefined> {
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
  // successor's.
  if ((await readHolder(lockDir))?.id !== token) return;
  const removed = `${lockDir}.released-${token}`;
  try {
    await rename(lockDir, removed);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  await rm(removed, { force: true, maxRetries: 3, recursive: true });
}

/**
 * Creates a record naming this process, unless a record of that name already
 * exists. Returns the record's token, or undefined if another waiter created it
 * first or the lock directory is gone.
 */
async function addRecord(lockDir: string, name: string): Promise<string | undefined> {
  const token = randomUUID();
  try {
    await writeFile(join(lockDir, name), ownerRecord(token), { encoding: 'utf8', flag: 'wx' });
    return token;
  } catch (error) {
    if (isEexist(error) || isEnoent(error)) return undefined;
    throw error;
  }
}

function ownerRecord(token: string): string {
  const owner: LockOwner = { createdAt: Date.now(), pid: process.pid, token };
  return `${JSON.stringify(owner)}\n`;
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

async function statOrUndefined(path: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
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

function isEnotempty(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOTEMPTY');
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
