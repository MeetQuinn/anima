import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ClaudeCodeAccountConfig } from '../../shared/provider-accounts.js';
import { claudeConfigDir, defaultClaudeConfigDir } from './claude-account-config.js';

const SHARED_CLAUDE_STATE = [
  'history.jsonl',
  'plugins',
  'projects',
  'scheduled-tasks',
  'settings.json',
  'skills',
  'tasks',
] as const;

export class ClaudeAccountContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeAccountContinuityError';
  }
}

export async function ensureClaudeAccountContinuity(account: ClaudeCodeAccountConfig): Promise<void> {
  return ensureClaudeAccountsContinuity([account]);
}

export async function ensureClaudeAccountsContinuity(
  accounts: ClaudeCodeAccountConfig[],
): Promise<void> {
  return ensureClaudeAccountsContinuityWithRoot(accounts, defaultClaudeConfigDir());
}

export async function claudeAccountContinuityNeedsSetup(
  account: ClaudeCodeAccountConfig,
): Promise<boolean> {
  return claudeAccountContinuityNeedsSetupWithRoot(account, defaultClaudeConfigDir());
}

export async function claudeAccountContinuityNeedsSetupWithRoot(
  account: ClaudeCodeAccountConfig,
  canonicalRoot: string,
): Promise<boolean> {
  if (!account.configDir) return false;
  const profileRoot = claudeConfigDir(account);
  if (await rootsAreEqual(profileRoot, canonicalRoot)) return false;
  for (const entry of SHARED_CLAUDE_STATE) {
    const source = join(canonicalRoot, entry);
    const destination = join(profileRoot, entry);
    const [sourceExists, destinationStat] = await Promise.all([
      pathExists(source),
      lstat(destination).catch(() => undefined),
    ]);
    if (!sourceExists && !destinationStat) continue;
    if (!sourceExists || !destinationStat?.isSymbolicLink()) return true;
    const target = resolve(dirname(destination), await readlink(destination));
    if (target !== source) return true;
  }
  return false;
}

export async function ensureClaudeAccountContinuityWithRoot(
  account: ClaudeCodeAccountConfig,
  canonicalRoot: string,
): Promise<void> {
  return ensureClaudeAccountsContinuityWithRoot([account], canonicalRoot);
}

export async function ensureClaudeAccountsContinuityWithRoot(
  accounts: ClaudeCodeAccountConfig[],
  canonicalRoot: string,
): Promise<void> {
  const profileRoots = new Map<string, string>();
  const canonicalIdentity = await rootIdentity(canonicalRoot);
  for (const account of accounts) {
    if (!account.configDir) continue;
    const profileRoot = claudeConfigDir(account);
    const profileIdentity = await rootIdentity(profileRoot);
    if (profileIdentity === canonicalIdentity) continue;
    profileRoots.set(profileIdentity, profileRoot);
  }
  const actions: SharedEntryAction[] = [];

  // Plan every profile before changing any of them. A conflict in a later account
  // must not leave an earlier account partially linked to the canonical state.
  for (const profileRoot of profileRoots.values()) {
    for (const entry of SHARED_CLAUDE_STATE) {
      const action = await planSharedEntry(
        join(canonicalRoot, entry),
        join(profileRoot, entry),
      );
      if (action) actions.push(action);
    }
  }

  for (const profileRoot of profileRoots.values()) await mkdir(profileRoot, { recursive: true });
  for (const action of actions) await applySharedEntry(action);
}

interface SharedEntryAction {
  backup?: string;
  destination: string;
  source: string;
  type: 'dir' | 'file';
}

async function planSharedEntry(
  source: string,
  destination: string,
): Promise<SharedEntryAction | undefined> {
  const sourceStat = await lstat(source).catch(() => undefined);
  const destinationStat = await lstat(destination).catch(() => undefined);
  if (!sourceStat) {
    if (destinationStat) {
      throw new ClaudeAccountContinuityError(
        `Claude account state exists only in the selected profile at ${destination}; refusing to hide it`,
      );
    }
    return undefined;
  }
  const type = sourceStat.isDirectory() ? 'dir' : 'file';
  if (!destinationStat) {
    return { destination, source, type };
  }
  if (destinationStat.isSymbolicLink()) {
    const target = resolve(dirname(destination), await readlink(destination));
    if (target === source) return undefined;
    throw new ClaudeAccountContinuityError(
      `Claude account state path points somewhere else: ${destination} -> ${target}`,
    );
  }

  const replaceable = sourceStat.isDirectory() && destinationStat.isDirectory()
    ? await directoryIsRedundantOverlay(source, destination)
    : sourceStat.isFile() && destinationStat.isFile()
      ? await filesEqual(source, destination)
      : false;
  if (!replaceable) {
    throw new ClaudeAccountContinuityError(
      `Claude account state already contains independent data at ${destination}; refusing to overwrite it`,
    );
  }

  return {
    backup: await unusedBackupPath(destination),
    destination,
    source,
    type,
  };
}

async function applySharedEntry(action: SharedEntryAction): Promise<void> {
  if (!action.backup) {
    await symlink(action.source, action.destination, action.type);
    return;
  }
  await rename(action.destination, action.backup);
  try {
    await symlink(action.source, action.destination, action.type);
  } catch (error) {
    await rename(action.backup, action.destination).catch(() => undefined);
    throw error;
  }
}

async function directoryIsRedundantOverlay(source: string, destination: string): Promise<boolean> {
  const entries = await readdir(destination, { withFileTypes: true });
  for (const entry of entries) {
    const destinationEntry = join(destination, entry.name);
    if (!entry.isSymbolicLink()) return false;
    const target = resolve(dirname(destinationEntry), await readlink(destinationEntry));
    const expected = join(source, entry.name);
    if (target !== expected) return false;
  }
  return true;
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
  return leftBytes.equals(rightBytes);
}

async function unusedBackupPath(path: string): Promise<string> {
  for (let index = 0; index < 1_000; index += 1) {
    const candidate = `${path}.anima-account-backup${index === 0 ? '' : `-${index}`}`;
    if (!await pathExists(candidate)) return candidate;
  }
  throw new ClaudeAccountContinuityError(`Could not allocate a backup path for ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function rootsAreEqual(left: string, right: string): Promise<boolean> {
  return await rootIdentity(left) === await rootIdentity(right);
}

async function rootIdentity(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}
