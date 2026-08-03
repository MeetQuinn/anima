import { execFile } from 'node:child_process';
import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { ClaudeCodeAccountConfig } from '../../shared/provider-accounts.js';
import { claudeKeychainService, normalizedConfigDir } from './claude-account-config.js';

const execFileAsync = promisify(execFile);

export class ClaudeAccountRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeAccountRemovalError';
  }
}

export interface StagedClaudeAccountRemoval {
  readonly archivedPath?: string;
  finalize(): Promise<void>;
  restore(): Promise<void>;
}

export interface StageClaudeAccountRemovalOptions {
  archiveRoot?: string;
  deleteKeychain?: (service: string) => Promise<void>;
  now?: () => Date;
  profilesRoot?: string;
}

/**
 * Move one isolated Claude profile out of discovery before the registry update.
 * Credential deletion is deferred until the caller persists that update. Keychain
 * cleanup runs before the credentials file is unlinked, so any cleanup failure can
 * restore a profile that still has its file-based credential.
 */
export async function stageClaudeAccountRemoval(
  account: ClaudeCodeAccountConfig,
  options: StageClaudeAccountRemovalOptions = {},
): Promise<StagedClaudeAccountRemoval> {
  const configDir = normalizedConfigDir(account.configDir);
  if (!configDir) {
    throw new ClaudeAccountRemovalError('The Primary Claude account cannot be removed');
  }

  const profilesRoot = resolve(options.profilesRoot ?? join(homedir(), '.claude-profiles'));
  if (dirname(configDir) !== profilesRoot) {
    throw new ClaudeAccountRemovalError('Only isolated Claude profiles managed by Anima can be removed');
  }

  const archiveRoot = resolve(options.archiveRoot ?? `${profilesRoot}.archive`);
  if (pathIsWithin(profilesRoot, archiveRoot)) {
    throw new ClaudeAccountRemovalError('Claude account archive must be outside the profile discovery root');
  }

  const metadata = await lstat(configDir).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (metadata?.isSymbolicLink() || (metadata && !metadata.isDirectory())) {
    throw new ClaudeAccountRemovalError('Claude account profile must be a real directory');
  }

  let archivedPath: string | undefined;
  if (metadata) {
    await mkdir(archiveRoot, { mode: 0o700, recursive: true });
    const archiveMetadata = await lstat(archiveRoot);
    if (!archiveMetadata.isDirectory() || archiveMetadata.isSymbolicLink()) {
      throw new ClaudeAccountRemovalError('Claude account archive root must be a real directory');
    }
    archivedPath = await unusedArchivePath(
      archiveRoot,
      `${basename(configDir)}-${timestamp(options.now?.() ?? new Date())}`,
    );
    await rename(configDir, archivedPath);
  }

  const deleteKeychain = options.deleteKeychain ?? deleteClaudeKeychainCredential;
  let finalized = false;

  return {
    archivedPath,
    async finalize() {
      if (finalized) return;
      await deleteKeychain(claudeKeychainService(configDir));
      if (archivedPath) {
        await unlink(join(archivedPath, '.credentials.json')).catch((error: unknown) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      }
      finalized = true;
    },
    async restore() {
      if (finalized || !archivedPath) return;
      await rename(archivedPath, configDir);
      archivedPath = undefined;
    },
  };
}

async function deleteClaudeKeychainCredential(service: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync(
      'security',
      ['delete-generic-password', '-s', service],
      { encoding: 'utf8', timeout: 5_000 },
    );
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';
    if (/could not be found|item not found/i.test(stderr)) return;
    throw new Error('Could not remove the Claude account credential from Keychain');
  }
}

async function unusedArchivePath(root: string, stem: string): Promise<string> {
  for (let index = 0; index < 1_000; index += 1) {
    const candidate = join(root, index === 0 ? stem : `${stem}-${index}`);
    if (!await lstat(candidate).then(() => true, () => false)) return candidate;
  }
  throw new ClaudeAccountRemovalError('Could not allocate a Claude account archive path');
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function timestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
