import { randomUUID } from 'node:crypto';
import { chmod, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PrivateKey } from 'eciesjs';

import {
  MAX_HANDOFF_EXPIRY_MS,
  MIN_HANDOFF_EXPIRY_MS,
  decryptHumanHandoffSecret,
  encodeHumanHandoffPublicKey,
  humanHandoffKeyId,
  parseHumanHandoffBox,
  parseHumanHandoffPublicKey,
  type HumanHandoffSecretPayload,
} from '../../shared/secret-handoff.js';
import { withFileLock } from '../storage/lock.js';
import { currentWriteRoot, ensureDirectoryUnderRoot } from '../storage/write-root.js';

const HUMAN_ID = /^h_[A-Za-z0-9_-]{22}$/;
const AGENT_ID = /^[A-Za-z0-9._-]+$/;
const PRIVATE_KEY = /^[0-9a-f]{64}$/;
const PERMISSION_PRIVATE = 0o600;
const PERMISSION_DIR = 0o700;

interface PendingHumanHandoffRecord {
  v: 1;
  state: 'pending' | 'consuming';
  publicKey: string;
  privateKey: string;
  createdAt: string;
  expiresAt: string;
  consumingAt?: string;
}

export class HumanSecretHandoffPendingStore {
  private readonly directory: string;

  constructor(
    agentId: string,
    private readonly animaHome: string = currentWriteRoot(),
  ) {
    if (!AGENT_ID.test(agentId)) throw new Error('Handoff agent id is invalid');
    this.directory = join(animaHome, 'agents', agentId, 'env', 'handoff', 'human');
  }

  async create(
    publicKey: string,
    privateKey: string,
    expiresAt: Date,
    now: Date = new Date(),
  ): Promise<string> {
    const canonicalPublicKey = parseHumanHandoffPublicKey(encodeHumanHandoffPublicKey(publicKey));
    if (!PRIVATE_KEY.test(privateKey)) throw new Error('Human handoff private key is invalid');
    if (PrivateKey.fromHex(privateKey).publicKey.toHex() !== canonicalPublicKey)
      throw new Error('Human handoff key pair does not match');
    const lifetime = expiresAt.getTime() - now.getTime();
    if (lifetime < MIN_HANDOFF_EXPIRY_MS || lifetime > MAX_HANDOFF_EXPIRY_MS)
      throw new Error('Human handoff lifetime must be between 5m and 7d');
    const id = await humanHandoffKeyId(canonicalPublicKey);
    await this.cleanupExpired(now);
    await this.ensureDirectory();
    const path = this.path(id);
    await withFileLock(path, this.animaHome, async () => {
      if (await fileExists(path)) throw new Error('Human handoff public key already exists');
      await writeRecord(path, {
        v: 1,
        state: 'pending',
        publicKey: canonicalPublicKey,
        privateKey,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
    });
    return id;
  }

  async consume<T>(
    boxInput: string,
    operation: (payload: HumanHandoffSecretPayload) => Promise<T>,
  ): Promise<T> {
    const box = parseHumanHandoffBox(boxInput);
    const id = await humanHandoffKeyId(box.publicKey);
    if (!(await directoryExists(this.directory)))
      throw new Error('Pending human handoff was not found');
    const path = this.path(id);
    return withFileLock(path, this.animaHome, async () => {
      const record = await readRecord(path);
      if (!record) throw new Error('Pending human handoff was not found');
      if (record.publicKey !== box.publicKey)
        throw new Error('Human handoff public key does not match');
      if (isExpired(record)) {
        await rm(path, { force: true });
        throw new Error('Human handoff has expired');
      }
      if (record.state === 'consuming') {
        throw new Error(
          'Human handoff acceptance has an uncertain prior outcome. Inspect the target env key, then cancel and create a new link.',
        );
      }
      const payload = decryptHumanHandoffSecret(record.privateKey, boxInput);
      await writeRecord(path, {
        ...record,
        state: 'consuming',
        consumingAt: new Date().toISOString(),
      });
      const result = await operation(payload);
      await rm(path);
      return result;
    });
  }

  async resetRejectedWrite(boxInput: string): Promise<void> {
    const box = parseHumanHandoffBox(boxInput);
    const id = await humanHandoffKeyId(box.publicKey);
    if (!(await directoryExists(this.directory))) return;
    const path = this.path(id);
    await withFileLock(path, this.animaHome, async () => {
      const record = await readRecord(path);
      if (!record || record.state !== 'consuming') return;
      if (isExpired(record)) {
        await rm(path, { force: true });
        return;
      }
      const { consumingAt: _, ...pending } = record;
      await writeRecord(path, { ...pending, state: 'pending' });
    });
  }

  async cancel(id: string): Promise<boolean> {
    if (!(await directoryExists(this.directory))) return false;
    const path = this.path(id);
    return withFileLock(path, this.animaHome, async () => {
      if (!(await fileExists(path))) return false;
      await rm(path, { force: true });
      return true;
    });
  }

  async cleanupExpired(now: Date = new Date()): Promise<number> {
    if (!(await directoryExists(this.directory))) return 0;
    const entries = await readdir(this.directory, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.directory, entry.name);
      await withFileLock(path, this.animaHome, async () => {
        const record = await readRecord(path);
        if (!record || Date.parse(record.expiresAt) > now.getTime()) return;
        await rm(path, { force: true });
        removed += 1;
      });
    }
    return removed;
  }

  pendingPath(id: string): string {
    return this.path(id);
  }

  private path(id: string): string {
    if (!HUMAN_ID.test(id)) throw new Error('Human handoff id is invalid');
    return join(this.directory, `${id}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    await ensureDirectoryUnderRoot(this.directory, this.animaHome);
    await chmod(this.directory, PERMISSION_DIR);
  }
}

async function writeRecord(path: string, record: PendingHumanHandoffRecord): Promise<void> {
  const parsed = validateRecord(record);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PERMISSION_PRIVATE,
    });
    await rename(temp, path);
    await chmod(path, PERMISSION_PRIVATE);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readRecord(path: string): Promise<PendingHumanHandoffRecord | undefined> {
  try {
    return validateRecord(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function validateRecord(value: unknown): PendingHumanHandoffRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Pending human handoff record is invalid');
  }
  const object = value as Record<string, unknown>;
  const state = object.state;
  const expected =
    state === 'consuming'
      ? ['consumingAt', 'createdAt', 'expiresAt', 'privateKey', 'publicKey', 'state', 'v']
      : ['createdAt', 'expiresAt', 'privateKey', 'publicKey', 'state', 'v'];
  const actual = Object.keys(object).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Pending human handoff record fields are invalid');
  }
  if (object.v !== 1 || (state !== 'pending' && state !== 'consuming')) {
    throw new Error('Pending human handoff record version or state is invalid');
  }
  if (typeof object.privateKey !== 'string' || !PRIVATE_KEY.test(object.privateKey)) {
    throw new Error('Pending human handoff private key is invalid');
  }
  if (typeof object.publicKey !== 'string')
    throw new Error('Pending human handoff public key is invalid');
  const publicKey = parseHumanHandoffPublicKey(encodeHumanHandoffPublicKey(object.publicKey));
  const createdAt = validTimestamp(object.createdAt, 'created');
  const expiresAt = validTimestamp(object.expiresAt, 'expiry');
  if (Date.parse(expiresAt) <= Date.parse(createdAt))
    throw new Error('Pending human handoff lifetime is invalid');
  const base = {
    v: 1 as const,
    state,
    publicKey,
    privateKey: object.privateKey,
    createdAt,
    expiresAt,
  };
  if (state === 'consuming') {
    const consumingAt = validTimestamp(object.consumingAt, 'consuming');
    return { ...base, state, consumingAt };
  }
  return { ...base, state };
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error(`Pending human handoff ${label} timestamp is invalid`);
  return value;
}

function isExpired(record: PendingHumanHandoffRecord): boolean {
  return Date.parse(record.expiresAt) <= Date.now();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
