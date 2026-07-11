import { chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import dotenvx from '@dotenvx/dotenvx';
import { decrypt } from 'eciesjs';

import { ANIMA_MANAGED_PROVIDER_ENV_KEYS } from '../../shared/agent-config.js';
import { resolveAnimaHome } from '../anima-home.js';
import { withFileLock } from '../storage/lock.js';
import { AGENT_ID } from '../storage/schema/agent.store.js';
import { currentWriteRoot, ensureDirectoryUnderRoot } from '../storage/write-root.js';

export type AgentEnvKind = 'plain' | 'secret';

export interface AgentEnvRecord {
  key: string;
  kind: AgentEnvKind;
  value: string;
}

export interface AgentEnvSnapshot {
  plain: Record<string, string>;
  secret: Record<string, string>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENCRYPTED_PREFIX = 'encrypted:';
const PERMISSION_PRIVATE = 0o600;
const PERMISSION_DIR = 0o700;

const DOTENV_PUBLIC_KEY_SECRET = 'DOTENV_PUBLIC_KEY_SECRET';
const DOTENV_PRIVATE_KEY_SECRET = 'DOTENV_PRIVATE_KEY_SECRET';

const DANGEROUS_ENV_KEYS = new Set([
  'BASH_ENV',
  'DYLD_INSERT_LIBRARIES',
  'ENV',
  'HOME',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PATH',
  'PWD',
  'SHELL',
  'ZDOTDIR',
]);

export class AgentEnvExistsError extends Error {
  constructor(readonly key: string, readonly kind: AgentEnvKind) {
    super(`${key} already exists as a ${kind} env value`);
    this.name = 'AgentEnvExistsError';
  }
}

export function agentEnvDir(agentId: string, animaHome: string = resolveAnimaHome()): string {
  assertAgentId(agentId);
  return join(animaHome, 'agents', agentId, 'env');
}

export function agentEnvPaths(
  agentId: string,
  animaHome: string = resolveAnimaHome(),
): { dir: string; plain: string; secret: string; keys: string } {
  const dir = agentEnvDir(agentId, animaHome);
  return {
    dir,
    keys: join(dir, '.env.keys'),
    plain: join(dir, '.env'),
    secret: join(dir, '.env.secret'),
  };
}

export class AgentEnvStore {
  private readonly animaHome: string;
  private readonly paths: ReturnType<typeof agentEnvPaths>;
  private readonly lockPath: string;

  constructor(agentId: string, animaHome: string = currentWriteRoot()) {
    assertAgentId(agentId);
    this.animaHome = animaHome;
    this.paths = agentEnvPaths(agentId, animaHome);
    this.lockPath = join(this.paths.dir, '.env-store');
  }

  async list(): Promise<AgentEnvRecord[]> {
    const snapshot = await this.load();
    return [
      ...Object.entries(snapshot.plain).map(([key, value]) => ({ key, kind: 'plain' as const, value })),
      ...Object.entries(snapshot.secret).map(([key, value]) => ({ key, kind: 'secret' as const, value })),
    ].sort((a, b) => a.key.localeCompare(b.key));
  }

  async load(): Promise<AgentEnvSnapshot> {
    const [plainSrc, secretSrc, keysSrc] = await Promise.all([
      readTextIfExists(this.paths.plain),
      readTextIfExists(this.paths.secret),
      readTextIfExists(this.paths.keys),
    ]);

    const plain = parseDotenv(plainSrc);
    const secretEncrypted = parseDotenv(secretSrc);
    const privateKey = parseDotenv(keysSrc)[DOTENV_PRIVATE_KEY_SECRET];
    const secret = decryptSecretValues(secretEncrypted, privateKey);

    validateStoredKeys(plain, 'plain');
    validateStoredKeys(secret, 'secret');
    assertNoCrossFileDuplicates(plain, secret);

    return { plain, secret };
  }

  async set(
    key: string,
    value: string,
    kind: AgentEnvKind,
    options: { replace?: boolean } = {},
  ): Promise<void> {
    assertEnvKeyAllowed(key);
    await ensureDirectoryUnderRoot(this.paths.dir, this.animaHome);
    await chmodIfExists(this.paths.dir, PERMISSION_DIR);
    await withFileLock(this.lockPath, this.animaHome, async () => {
      const current = await this.load();
      const otherKind: AgentEnvKind = kind === 'plain' ? 'secret' : 'plain';
      if (current[otherKind][key] !== undefined) throw new AgentEnvExistsError(key, otherKind);
      if (!options.replace && current[kind][key] !== undefined) {
        throw new AgentEnvExistsError(key, kind);
      }

      if (kind === 'plain') {
        dotenvx.set(key, value, {
          encrypt: false,
          noArmor: true,
          path: this.paths.plain,
          plain: true,
          quiet: true,
        } as Parameters<typeof dotenvx.set>[2] & { quiet: boolean });
        await chmodIfExists(this.paths.plain, PERMISSION_PRIVATE);
        return;
      }

      dotenvx.set(key, value, {
        envKeysFile: this.paths.keys,
        noArmor: true,
        path: this.paths.secret,
        quiet: true,
      } as Parameters<typeof dotenvx.set>[2] & { quiet: boolean });
      await Promise.all([
        chmodIfExists(this.paths.secret, PERMISSION_PRIVATE),
        chmodIfExists(this.paths.keys, PERMISSION_PRIVATE),
      ]);
    });
  }

  async valuesFor(keys: string[] | undefined): Promise<Record<string, string>> {
    const snapshot = await this.load();
    const merged = { ...snapshot.plain, ...snapshot.secret };
    const selectedKeys = keys ?? Object.keys(merged).sort();
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const key of selectedKeys) {
      assertEnvKeyAllowed(key);
      if (merged[key] === undefined) missing.push(key);
      else values[key] = merged[key];
    }
    if (missing.length > 0) throw new Error(`Missing env value(s): ${missing.join(', ')}`);
    return values;
  }
}

export function assertEnvKeyAllowed(key: string): void {
  if (!ENV_NAME.test(key)) {
    throw new Error(`${key} is not a valid env key. Use shell-style names like OPENAI_API_KEY.`);
  }
  if (key.startsWith('ANIMA_') || isReservedEnvKey(key)) {
    throw new Error(`${key} is managed or unsafe and cannot be set with anima env`);
  }
}

export function maskEnvSecret(value: string): string {
  if (value.length <= 4) return '********';
  return `********${value.slice(-4)}`;
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID.test(agentId)) throw new Error(`agent id must match ${AGENT_ID}`);
}

function isReservedEnvKey(key: string): boolean {
  return (
    DANGEROUS_ENV_KEYS.has(key)
    || (ANIMA_MANAGED_PROVIDER_ENV_KEYS as readonly string[]).includes(key)
    || key === 'DOTENV_KEY'
    || key === 'DOTENV_PRIVATE_KEY'
    || key === 'DOTENV_PUBLIC_KEY'
    || key.startsWith('DOTENV_PRIVATE_KEY_')
    || key.startsWith('DOTENV_PUBLIC_KEY_')
  );
}

function validateStoredKeys(values: Record<string, string>, kind: AgentEnvKind): void {
  for (const key of Object.keys(values)) {
    try {
      assertEnvKeyAllowed(key);
    } catch (error) {
      throw new Error(`${kind} env file contains unsupported key ${key}: ${(error as Error).message}`);
    }
  }
}

function assertNoCrossFileDuplicates(plain: Record<string, string>, secret: Record<string, string>): void {
  const duplicates = Object.keys(plain).filter((key) => secret[key] !== undefined).sort();
  if (duplicates.length > 0) {
    throw new Error(`Env key(s) cannot appear in both .env and .env.secret: ${duplicates.join(', ')}`);
  }
}

async function readTextIfExists(path: string): Promise<string> {
  if (!existsSync(path)) return '';
  return readFile(path, 'utf8');
}

async function chmodIfExists(path: string, mode: number): Promise<void> {
  if (!existsSync(path)) return;
  await chmod(path, mode).catch(() => undefined);
}

function decryptSecretValues(values: Record<string, string>, privateKey: string | undefined): Record<string, string> {
  const decrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === DOTENV_PUBLIC_KEY_SECRET) continue;
    if (value.startsWith(ENCRYPTED_PREFIX)) {
      if (!privateKey) throw new Error(`Missing ${DOTENV_PRIVATE_KEY_SECRET} for .env.secret`);
      decrypted[key] = decryptDotenvxValue(key, value, privateKey);
    } else {
      decrypted[key] = value;
    }
  }
  return decrypted;
}

function decryptDotenvxValue(key: string, value: string, privateKey: string): string {
  const encoded = value.slice(ENCRYPTED_PREFIX.length);
  const ciphertext = Buffer.from(encoded, 'base64');
  let lastError: unknown;
  for (const candidate of privateKey.split(',').map((part) => part.trim()).filter(Boolean)) {
    try {
      const secret = Buffer.from(candidate, 'hex');
      return Buffer.from(decrypt(secret, ciphertext)).toString();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not decrypt secret env key ${key}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function parseDotenv(src: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const exportStripped = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const separatorIndex = exportStripped.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = exportStripped.slice(0, separatorIndex).trim();
    if (!key) continue;
    const rawValue = exportStripped.slice(separatorIndex + 1).trimStart();
    parsed[key] = parseDotenvValue(rawValue);
  }
  return parsed;
}

function parseDotenvValue(rawValue: string): string {
  if (!rawValue) return '';
  const quote = rawValue[0];
  if (quote === '"' || quote === '\'' || quote === '`') {
    const closingIndex = findClosingQuote(rawValue, quote);
    const body = closingIndex >= 0 ? rawValue.slice(1, closingIndex) : rawValue.slice(1);
    if (quote === '"') return unescapeDoubleQuoted(body);
    return body;
  }
  return stripUnquotedComment(rawValue).trim();
}

function findClosingQuote(value: string, quote: string): number {
  for (let index = value.length - 1; index > 0; index -= 1) {
    if (value[index] === quote && value[index - 1] !== '\\') return index;
  }
  return -1;
}

function stripUnquotedComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/.test(value[index - 1] ?? ''))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function unescapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
