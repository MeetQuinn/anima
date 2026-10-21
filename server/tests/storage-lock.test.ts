import { spawnSync } from 'node:child_process';
import fsPromises, { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { withFileLock } from '../storage/lock.js';

const realReadFile = fsPromises.readFile;
const realRm = fsPromises.rm;
const realWriteFile = fsPromises.writeFile;

function restoreFs(): void {
  fsPromises.readFile = realReadFile;
  fsPromises.rm = realRm;
  fsPromises.writeFile = realWriteFile;
  syncBuiltinESMExports();
}

// The pid of a process that has already exited, for a holder that died.
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (!child.pid) throw new Error('failed to spawn probe child');
  return child.pid;
}

async function writeRecord(path: string, owner: { pid: number; token?: string }): Promise<void> {
  await writeFile(path, `${JSON.stringify({ createdAt: Date.now(), ...owner })}\n`, 'utf8');
}

// Callers in one process that pass the same path share an in-process queue.
// Another spelling of the path (`dir/././value.json`) gets its own queue but
// the same lock directory, so it contends the way another process would.
function spelling(dir: string, copy: number): string {
  return `${dir}/${'./'.repeat(copy)}value.json`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolveFn) => {
    resolvePromise = resolveFn;
  });
  return { promise, resolve: resolvePromise };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

// Counts callers inside their locked operation at once.
function occupancy(): { max: () => number; hold: (until: Promise<void>) => Promise<void> } {
  let inside = 0;
  let max = 0;
  return {
    max: () => max,
    async hold(until) {
      inside += 1;
      max = Math.max(max, inside);
      try {
        await until;
      } finally {
        inside -= 1;
      }
    },
  };
}

test('a waiter acting on an old view of a dead holder leaves the lock that replaced it', { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-lock-replaced-'));
  try {
    const path = join(dir, 'value.json');
    const lockDir = `${path}.lock`;
    await mkdir(lockDir);
    await writeRecord(join(lockDir, 'owner.json'), { pid: deadPid() });

    // Just after this waiter reads the dead holder, another waiter takes the
    // lock and releases it, and a third creates it again. This process's pid
    // stands in for that live holder.
    let replaced = false;
    fsPromises.readFile = (async (...args: Parameters<typeof realReadFile>) => {
      const data = await realReadFile(...args);
      if (!replaced && String(args[0]) === join(lockDir, 'owner.json')) {
        replaced = true;
        await rm(lockDir, { force: true, recursive: true });
        await mkdir(lockDir);
        await writeRecord(join(lockDir, 'owner.json'), { pid: process.pid, token: 'live-holder' });
      }
      return data;
    }) as typeof realReadFile;
    syncBuiltinESMExports();

    let entered = false;
    const locked = withFileLock(path, dir, async () => {
      entered = true;
    });
    await delay(150);
    assert.equal(replaced, true);
    assert.equal(entered, false, 'the waiter entered while the new lock was held');
    const root = JSON.parse(await realReadFile(join(lockDir, 'owner.json'), 'utf8')) as { token: string };
    assert.equal(root.token, 'live-holder');

    await rm(lockDir, { force: true, recursive: true });
    await locked;
    assert.equal(entered, true);
  } finally {
    restoreFs();
    await rm(dir, { force: true, recursive: true });
  }
});

test('of two waiters that found the same dead holder, only one takes over', { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-lock-two-takers-'));
  try {
    const lockDir = join(dir, 'value.json.lock');
    await mkdir(lockDir);
    await writeRecord(join(lockDir, 'owner.json'), { pid: deadPid(), token: 'dead-holder' });

    // B pauses once its read of the lock ends at the dead holder, and resumes
    // after A has taken over and entered.
    const bSawDeadHolder = deferred();
    const resumeB = deferred();
    let paused = false;
    fsPromises.readFile = (async (...args: Parameters<typeof realReadFile>) => {
      try {
        return await realReadFile(...args);
      } catch (error) {
        if (!paused && String(args[0]) === join(lockDir, 'next-dead-holder.json')) {
          paused = true;
          bSawDeadHolder.resolve();
          await resumeB.promise;
        }
        throw error;
      }
    }) as typeof realReadFile;
    syncBuiltinESMExports();

    const seen = occupancy();
    const aEntered = deferred();
    const releaseA = deferred();
    const b = withFileLock(spelling(dir, 1), dir, () => seen.hold(Promise.resolve()));
    await bSawDeadHolder.promise;
    const a = withFileLock(spelling(dir, 2), dir, async () => {
      aEntered.resolve();
      await seen.hold(releaseA.promise);
    });
    await aEntered.promise;
    resumeB.resolve();
    await delay(150);
    releaseA.resolve();
    await Promise.all([a, b]);
    assert.equal(seen.max(), 1, 'both waiters held the lock at once');
  } finally {
    restoreFs();
    await rm(dir, { force: true, recursive: true });
  }
});

test('a waiter that died after taking over is taken over in turn', { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-lock-dead-taker-'));
  try {
    const path = join(dir, 'value.json');
    const lockDir = `${path}.lock`;
    await mkdir(lockDir);
    await writeRecord(join(lockDir, 'owner.json'), { pid: deadPid(), token: 'first' });
    await writeRecord(join(lockDir, 'next-first.json'), { pid: deadPid(), token: 'second' });

    assert.equal(await withFileLock(path, dir, async () => 'entered'), 'entered');
    await assert.rejects(stat(lockDir), /ENOENT/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('a holder that was taken over leaves the lock to its successor', { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-lock-successor-'));
  try {
    const path = join(dir, 'value.json');
    const lockDir = `${path}.lock`;
    await withFileLock(path, dir, async () => {
      // As if this caller had run past the 5-minute limit and been taken over.
      const root = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')) as { token: string };
      await writeRecord(join(lockDir, `next-${root.token}.json`), { pid: process.pid, token: 'successor' });
    });
    assert.equal((await readdir(lockDir)).length, 2, 'the successor\'s lock was removed');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// Pauses the first recursive removal of a lock that the caller spelled as
// `lockPath`, just before it runs. Release goes through this removal, wherever
// it deletes from.
function pauseRemoval(lockPath: string, beforePause?: (path: string) => Promise<void>): {
  paused: Promise<void>;
  resume: () => void;
} {
  const paused = deferred();
  const resume = deferred();
  let pausedOnce = false;
  fsPromises.rm = (async (...args: Parameters<typeof realRm>) => {
    const path = String(args[0]);
    if (!pausedOnce && path.startsWith(lockPath) && args[1]?.recursive) {
      pausedOnce = true;
      await beforePause?.(path);
      paused.resolve();
      await resume.promise;
    }
    return realRm(...args);
  }) as typeof realRm;
  syncBuiltinESMExports();
  return { paused: paused.promise, resume: resume.resolve };
}

test('a releasing holder never makes an earlier dead holder look current', { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-lock-release-order-'));
  try {
    const lockDir = join(dir, 'value.json.lock');
    await mkdir(lockDir);
    await writeRecord(join(lockDir, 'owner.json'), { pid: deadPid(), token: 'dead-root' });

    // The first caller takes over from the dead root. When it releases, the
    // removal deletes that caller's own record first and then pauses: the
    // worst order a recursive remove could take.
    const removal = pauseRemoval(`${spelling(dir, 1)}.lock`, async (path) => {
      await realRm(join(path, 'next-dead-root.json'), { force: true });
    });

    const seen = occupancy();
    const first = withFileLock(spelling(dir, 1), dir, () => seen.hold(Promise.resolve()));
    await removal.paused;

    const releaseSecond = deferred();
    const second = withFileLock(spelling(dir, 2), dir, () => seen.hold(releaseSecond.promise));
    await delay(150);
    removal.resume();
    await first;
    const third = withFileLock(spelling(dir, 3), dir, () => seen.hold(Promise.resolve()));
    await delay(150);
    releaseSecond.resolve();
    await Promise.all([second, third]);
    assert.equal(seen.max(), 1, 'two callers held the lock at once');
  } finally {
    restoreFs();
    await rm(dir, { force: true, recursive: true });
  }
});

test('a waiter that found an old ownerless lock is not removed by a release in progress', { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-lock-ownerless-release-'));
  try {
    // A lock directory left with no root record, over 5 minutes ago.
    const lockDir = join(dir, 'value.json.lock');
    await mkdir(lockDir);
    const staleAt = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(lockDir, staleAt, staleAt);

    // A decides the lock is free and pauses just before writing its root
    // record (the first root record written). B then takes the lock, leaves,
    // and pauses partway through removing it. A resumes and enters, then B
    // finishes.
    const aDecided = deferred();
    const resumeA = deferred();
    let aPaused = false;
    fsPromises.writeFile = (async (...args: Parameters<typeof realWriteFile>) => {
      if (!aPaused && String(args[0]).endsWith('/owner.json')) {
        aPaused = true;
        aDecided.resolve();
        await resumeA.promise;
      }
      return realWriteFile(...args);
    }) as typeof realWriteFile;
    const removal = pauseRemoval(`${spelling(dir, 2)}.lock`);

    const seen = occupancy();
    const aEntered = deferred();
    const releaseA = deferred();
    const a = withFileLock(spelling(dir, 1), dir, async () => {
      aEntered.resolve();
      await seen.hold(releaseA.promise);
    });
    await aDecided.promise;
    const b = withFileLock(spelling(dir, 2), dir, () => seen.hold(Promise.resolve()));
    await removal.paused;
    resumeA.resolve();
    await aEntered.promise;
    removal.resume();
    await b;

    const c = withFileLock(spelling(dir, 3), dir, () => seen.hold(Promise.resolve()));
    await delay(150);
    releaseA.resolve();
    await Promise.all([a, c]);
    assert.equal(seen.max(), 1, 'two callers held the lock at once');
  } finally {
    restoreFs();
    await rm(dir, { force: true, recursive: true });
  }
});
