import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { AgentConfig } from '../../shared/agent-config.js';
import type {
  ClaudeCodeAccountConfig,
  ClaudeCodeAccountRegistry,
} from '../../shared/provider-accounts.js';

export const CLAUDE_CONFIG_DIR_KEY = 'CLAUDE_CONFIG_DIR';
const execFileAsync = promisify(execFile);

export function effectiveClaudeAccountRegistry(
  configured: ClaudeCodeAccountRegistry | undefined,
  agents: AgentConfig[],
  discovered: ClaudeCodeAccountConfig[] = [],
): ClaudeCodeAccountRegistry {
  const configuredDirs = [...new Set(
    agents
      .filter((agent) => agent.provider.kind === 'claude-code')
      .map((agent) => normalizedConfigDir(agent.provider.env?.[CLAUDE_CONFIG_DIR_KEY]))
      .filter((value): value is string => Boolean(value) && value !== defaultClaudeConfigDir()),
  )].sort();
  const accounts = configured ? [...configured.accounts] : [{ id: 'primary', label: 'Primary' }];
  const knownDirs = new Set(accounts.map((account) => effectiveAccountConfigDir(account)));
  const knownIds = new Set(accounts.map((account) => account.id));
  for (const configDir of configuredDirs) addAccount(accounts, knownDirs, knownIds, inferredAccount(configDir));
  for (const account of discovered) {
    addAccount(accounts, knownDirs, knownIds, account);
  }

  if (configured) return validateClaudeAccountRegistry({ ...configured, accounts });

  const claudeAgents = agents.filter((agent) => agent.provider.kind === 'claude-code');
  const activeConfigDirs = new Set(
    claudeAgents.map(
      (agent) => normalizedConfigDir(agent.provider.env?.[CLAUDE_CONFIG_DIR_KEY]) ?? defaultClaudeConfigDir(),
    ),
  );
  const activeConfigDir = activeConfigDirs.size === 1 ? [...activeConfigDirs][0] : undefined;
  const activeAccount = activeConfigDir
    ? accounts.find((account) => effectiveAccountConfigDir(account) === activeConfigDir)
    : accounts[0];

  return {
    accounts,
    activeAccountId: activeAccount?.id ?? 'primary',
  };
}

export async function discoverClaudeAccounts(
  profilesRoot = join(homedir(), '.claude-profiles'),
): Promise<ClaudeCodeAccountConfig[]> {
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  const accounts: ClaudeCodeAccountConfig[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const configDir = join(profilesRoot, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!await stat(configDir).then((value) => value.isDirectory(), () => false)) continue;
    const account = inferredAccount(configDir);
    if (await readClaudeAccountName(account)) accounts.push(account);
  }
  return accounts;
}

export function validateClaudeAccountRegistry(registry: ClaudeCodeAccountRegistry): ClaudeCodeAccountRegistry {
  const ids = new Set<string>();
  const configDirs = new Set<string>();
  for (const account of registry.accounts) {
    if (ids.has(account.id)) throw new Error(`Duplicate Claude account id: ${account.id}`);
    ids.add(account.id);
    const configDir = effectiveAccountConfigDir(account);
    if (configDirs.has(configDir)) throw new Error(`Duplicate Claude account config directory: ${configDir}`);
    configDirs.add(configDir);
  }
  if (!ids.has(registry.activeAccountId)) {
    throw new Error(`Active Claude account not found: ${registry.activeAccountId}`);
  }
  if (registry.switch && !ids.has(registry.switch.accountId)) {
    throw new Error(`Claude account switch target not found: ${registry.switch.accountId}`);
  }
  return registry;
}

export function selectedClaudeAccount(registry: ClaudeCodeAccountRegistry): ClaudeCodeAccountConfig {
  const account = registry.accounts.find((candidate) => candidate.id === registry.activeAccountId);
  if (!account) throw new Error(`Active Claude account not found: ${registry.activeAccountId}`);
  return account;
}

export function applyClaudeAccountToAgent(
  agent: AgentConfig,
  registry: ClaudeCodeAccountRegistry | undefined,
): AgentConfig {
  if (!registry || agent.provider.kind !== 'claude-code') return agent;
  const account = selectedClaudeAccount(validateClaudeAccountRegistry(registry));
  const env = { ...(agent.provider.env ?? {}) };
  delete env[CLAUDE_CONFIG_DIR_KEY];
  const configDir = normalizedConfigDir(account.configDir);
  if (configDir) env[CLAUDE_CONFIG_DIR_KEY] = configDir;
  const provider = {
    ...agent.provider,
    ...(Object.keys(env).length > 0 ? { env } : { env: undefined }),
  };
  return { ...agent, provider };
}

export function defaultClaudeConfigDir(): string {
  return join(homedir(), '.claude');
}

export function claudeConfigDir(account: ClaudeCodeAccountConfig): string {
  return normalizedConfigDir(account.configDir) ?? defaultClaudeConfigDir();
}

export function claudeAccountMetadataPath(account: ClaudeCodeAccountConfig): string {
  return account.configDir
    ? join(claudeConfigDir(account), '.claude.json')
    : join(homedir(), '.claude.json');
}

export async function readClaudeAccountName(account: ClaudeCodeAccountConfig): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(claudeAccountMetadataPath(account), 'utf8')) as {
      oauthAccount?: { displayName?: unknown; emailAddress?: unknown };
    };
    const email = parsed.oauthAccount?.emailAddress;
    if (typeof email === 'string' && email.trim()) return email.trim();
    const displayName = parsed.oauthAccount?.displayName;
    return typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function claudeAccountIsConfigured(account: ClaudeCodeAccountConfig): Promise<boolean> {
  if (!await readClaudeAccountName(account)) return false;
  const configDir = claudeConfigDir(account);
  if (!await pathExists(configDir)) return false;
  const credentialsPath = join(configDir, '.credentials.json');
  if (await credentialsFileHasOAuth(credentialsPath)) return true;
  if (process.platform !== 'darwin') return false;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', claudeKeychainService(account.configDir), '-w'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return credentialsPayloadHasOAuth(parseJsonOrHex(stdout));
  } catch {
    return false;
  }
}

export function claudeKeychainService(configDir: string | undefined): string {
  const normalized = normalizedConfigDir(configDir);
  if (!normalized) return 'Claude Code-credentials';
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

export function normalizedConfigDir(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function inferredAccount(configDir: string): ClaudeCodeAccountConfig {
  const name = basename(configDir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    configDir,
    id: name === 'secondary' ? 'secondary' : `account-${accountPathHash(configDir)}`,
    label: name === 'secondary' ? 'Secondary' : titleCaseAccountName(name),
  };
}

function addAccount(
  accounts: ClaudeCodeAccountConfig[],
  knownDirs: Set<string>,
  knownIds: Set<string>,
  candidate: ClaudeCodeAccountConfig,
): void {
  const configDir = normalizedConfigDir(candidate.configDir);
  if (!configDir || knownDirs.has(configDir)) return;
  const id = uniqueAccountId(candidate.id, configDir, knownIds);
  accounts.push({ ...candidate, configDir, id });
  knownDirs.add(configDir);
  knownIds.add(id);
}

function effectiveAccountConfigDir(account: ClaudeCodeAccountConfig): string {
  return normalizedConfigDir(account.configDir) ?? defaultClaudeConfigDir();
}

function accountPathHash(configDir: string): string {
  return createHash('sha256').update(configDir).digest('hex').slice(0, 8);
}

function uniqueAccountId(candidateId: string, configDir: string, knownIds: Set<string>): string {
  if (!knownIds.has(candidateId)) return candidateId;
  const hash = createHash('sha256').update(configDir).digest('hex');
  for (const length of [8, 12, 16, 24]) {
    const id = `account-${hash.slice(0, length)}`;
    if (!knownIds.has(id)) return id;
  }
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const id = `account-${hash.slice(0, 24)}-${suffix}`;
    if (!knownIds.has(id)) return id;
  }
  throw new Error(`Could not allocate a unique Claude account id for ${configDir}`);
}

function titleCaseAccountName(name: string): string {
  const words = name.split('-').filter(Boolean);
  if (words.length === 0) return 'Claude account';
  return words.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join(' ');
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function credentialsFileHasOAuth(path: string): Promise<boolean> {
  try {
    return credentialsPayloadHasOAuth(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return false;
  }
}

function credentialsPayloadHasOAuth(value: unknown): boolean {
  const oauth = value && typeof value === 'object'
    ? (value as { claudeAiOauth?: unknown }).claudeAiOauth
    : undefined;
  if (!oauth || typeof oauth !== 'object') return false;
  const credentials = oauth as { accessToken?: unknown; refreshToken?: unknown };
  return typeof credentials.accessToken === 'string' || typeof credentials.refreshToken === 'string';
}

function parseJsonOrHex(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const hex = text.trim().replace(/^0x/i, '');
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
    try {
      return JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
    } catch {
      return undefined;
    }
  }
}
