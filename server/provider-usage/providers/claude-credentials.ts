import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Normalize a Claude config dir path; empty/whitespace becomes undefined. */
export function normalizedConfigDir(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

/**
 * Keychain service name Claude Code uses for OAuth credentials.
 * Non-default config dirs get a path-derived suffix (same scheme as Claude Code).
 */
export function claudeKeychainService(configDir: string | undefined): string {
  const normalized = normalizedConfigDir(configDir);
  if (!normalized) return 'Claude Code-credentials';
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}
