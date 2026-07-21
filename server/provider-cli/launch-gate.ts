import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProviderUsageKind } from '../../shared/provider-usage.js';

// Provider binaries are shared by every Anima process owned by this machine
// user, even when those processes use different ANIMA_HOME values.
const LOCK_ROOT = join(
  homedir(),
  '.cache',
  'anima',
  'provider-cli-locks-v1',
);
const LOCK_WAIT_MS = 50;
const LOCK_FD = 3;

export interface ProviderCliMachineLease {
  release(): Promise<void>;
}

interface AdvisoryLockCommand {
  args: string[];
  conflictExitCode: number;
  executable: string;
}

let advisoryLockCommandPromise: Promise<AdvisoryLockCommand> | undefined;

export async function tryAcquireProviderCliUpgradeLease(
  provider: ProviderUsageKind,
): Promise<ProviderCliMachineLease | undefined> {
  return tryAcquireLock('upgrade', provider);
}

export async function providerCliUpgradeLocked(): Promise<boolean> {
  const lease = await tryAcquireLock('upgrade', 'claude-code');
  if (!lease) return true;
  await lease.release();
  return false;
}

export async function withProviderCliInstallGate<T>(
  provider: ProviderUsageKind,
  task: () => Promise<T>,
): Promise<T> {
  const lease = await acquireLock(`provider-${provider}`, provider);
  try {
    return await task();
  } finally {
    await lease.release();
  }
}

export async function withProviderCliConfigurationGate<T>(
  provider: ProviderUsageKind,
  task: () => Promise<T>,
): Promise<T> {
  const lease = await acquireLock(`provider-${provider}`, provider);
  try {
    return await task();
  } finally {
    await lease.release();
  }
}

export async function withProviderCliLaunchPermit<T>(
  provider: ProviderUsageKind,
  signal: AbortSignal | undefined,
  task: () => T | Promise<T>,
): Promise<T> {
  const lease = await acquireLock(`provider-${provider}`, provider, signal);
  try {
    return await task();
  } finally {
    await lease.release();
  }
}

async function acquireLock(
  name: string,
  provider: ProviderUsageKind,
  signal?: AbortSignal,
): Promise<ProviderCliMachineLease> {
  while (true) {
    if (signal?.aborted)
      throw signal.reason ?? new Error('Provider launch aborted');
    const lease = await tryAcquireLock(name, provider);
    if (lease) {
      if (signal?.aborted) {
        await lease.release();
        throw signal.reason ?? new Error('Provider launch aborted');
      }
      return lease;
    }
    await abortableSleep(LOCK_WAIT_MS, signal);
  }
}

async function tryAcquireLock(
  name: string,
  _provider: ProviderUsageKind,
): Promise<ProviderCliMachineLease | undefined> {
  await mkdir(LOCK_ROOT, { mode: 0o700, recursive: true });
  const file = await open(join(LOCK_ROOT, `${name}.lock`), 'a+', 0o600);
  const command = await advisoryLockCommand();
  try {
    const child = spawn(
      command.executable,
      [...command.args, String(LOCK_FD)],
      {
        stdio: ['ignore', 'ignore', 'pipe', file.fd],
      },
    );
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const [code, signal] = (await once(child, 'exit')) as [
      number | null,
      NodeJS.Signals | null,
    ];
    if (code === 0) return fileLease(file);
    await file.close();
    if (code === command.conflictExitCode) return undefined;
    throw new Error(
      `Provider CLI machine lock failed (${code ?? signal ?? 'unknown'})${stderr ? `: ${stderr.trim()}` : ''}`,
    );
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

function fileLease(file: FileHandle): ProviderCliMachineLease {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await file.close();
    },
  };
}

function advisoryLockCommand(): Promise<AdvisoryLockCommand> {
  advisoryLockCommandPromise ??= resolveAdvisoryLockCommand();
  return advisoryLockCommandPromise;
}

async function resolveAdvisoryLockCommand(): Promise<AdvisoryLockCommand> {
  if (process.platform === 'darwin') {
    await access('/usr/bin/lockf');
    return {
      args: ['-s', '-t', '0'],
      conflictExitCode: 75,
      executable: '/usr/bin/lockf',
    };
  }
  if (process.platform === 'linux') {
    for (const executable of ['/usr/bin/flock', '/bin/flock']) {
      try {
        await access(executable);
        return {
          args: ['-n'],
          conflictExitCode: 1,
          executable,
        };
      } catch {
        // Try the next standard util-linux location.
      }
    }
  }
  throw new Error(
    `Provider CLI updates require an OS advisory lock utility on ${process.platform}`,
  );
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted)
    throw signal.reason ?? new Error('Provider launch aborted');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Provider launch aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
