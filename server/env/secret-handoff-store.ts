import { randomUUID } from 'node:crypto';
import {
  chmod,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  decryptHandoffSecret,
  encodeHandoffRequest,
  parseHandoffRequest,
  type HandoffRequest,
  type HandoffSecretPayload,
} from '../../shared/secret-handoff.js';
import { withFileLock } from '../storage/lock.js';
import {
  currentWriteRoot,
  ensureDirectoryUnderRoot,
} from '../storage/write-root.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const AGENT_ID = /^[A-Za-z0-9._-]+$/;
const PRIVATE_KEY = /^[0-9a-f]{64}$/;
const PERMISSION_PRIVATE = 0o600;
const PERMISSION_DIR = 0o700;

interface PendingHandoffRecord {
  v: 1;
  state: 'pending' | 'consuming';
  request: HandoffRequest;
  privateKey: string;
  consumingAt?: string;
}

export class SecretHandoffPendingStore {
  private readonly directory: string;

  constructor(
    private readonly agentId: string,
    private readonly animaHome: string = currentWriteRoot(),
  ) {
    if (!AGENT_ID.test(agentId)) throw new Error('Handoff agent id is invalid');
    this.directory = join(animaHome, 'agents', agentId, 'env', 'handoff');
  }

  async create(request: HandoffRequest, privateKey: string): Promise<void> {
    if (request.recipientAgentId !== this.agentId) {
      throw new Error(
        'Handoff request recipient does not match pending store agent',
      );
    }
    if (!PRIVATE_KEY.test(privateKey))
      throw new Error('Handoff private key is invalid');
    await this.cleanupExpired();
    await this.ensureDirectory();
    const path = this.path(request.requestId);
    await withFileLock(path, this.animaHome, async () => {
      if (await fileExists(path))
        throw new Error('Handoff request id already exists');
      await writeRecord(path, {
        v: 1,
        state: 'pending',
        request: parseHandoffRequest(encodeHandoffRequest(request)),
        privateKey,
      });
    });
  }

  async consume<T>(
    requestId: string,
    boxInput: string,
    operation: (payload: HandoffSecretPayload) => Promise<T>,
  ): Promise<T> {
    if (!(await directoryExists(this.directory)))
      throw new Error('Pending handoff request was not found');
    const path = this.path(requestId);
    return withFileLock(path, this.animaHome, async () => {
      const record = await readRecord(path);
      if (!record) throw new Error('Pending handoff request was not found');
      if (isExpired(record.request)) {
        await rm(path, { force: true });
        throw new Error('Handoff request has expired');
      }
      if (record.state === 'consuming') {
        throw new Error(
          'Handoff acceptance has an uncertain prior outcome. Inspect the target env key, then cancel and reissue the request.',
        );
      }
      const payload = await decryptHandoffSecret(
        record.request,
        record.privateKey,
        boxInput,
      );
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

  async resetRejectedWrite(requestId: string): Promise<void> {
    if (!(await directoryExists(this.directory))) return;
    const path = this.path(requestId);
    await withFileLock(path, this.animaHome, async () => {
      const record = await readRecord(path);
      if (!record || record.state !== 'consuming') return;
      if (isExpired(record.request)) {
        await rm(path, { force: true });
        return;
      }
      const { consumingAt: _, ...pending } = record;
      await writeRecord(path, { ...pending, state: 'pending' });
    });
  }

  async cancel(requestId: string): Promise<boolean> {
    if (!(await directoryExists(this.directory))) return false;
    const path = this.path(requestId);
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
        if (!record || Date.parse(record.request.expiresAt) > now.getTime())
          return;
        await rm(path, { force: true });
        removed += 1;
      });
    }
    return removed;
  }

  pendingPath(requestId: string): string {
    return this.path(requestId);
  }

  private path(requestId: string): string {
    if (!REQUEST_ID.test(requestId))
      throw new Error('Handoff request id is invalid');
    return join(this.directory, `${requestId}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    await ensureDirectoryUnderRoot(this.directory, this.animaHome);
    await chmod(this.directory, PERMISSION_DIR);
  }
}

async function writeRecord(
  path: string,
  record: PendingHandoffRecord,
): Promise<void> {
  const parsed = validateRecord(record);
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
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

async function readRecord(
  path: string,
): Promise<PendingHandoffRecord | undefined> {
  try {
    return validateRecord(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function validateRecord(value: unknown): PendingHandoffRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Pending handoff record is invalid');
  }
  const object = value as Record<string, unknown>;
  const state = object.state;
  const expected =
    state === 'consuming'
      ? ['consumingAt', 'privateKey', 'request', 'state', 'v']
      : ['privateKey', 'request', 'state', 'v'];
  const actual = Object.keys(object).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('Pending handoff record fields are invalid');
  }
  if (object.v !== 1 || (state !== 'pending' && state !== 'consuming')) {
    throw new Error('Pending handoff record version or state is invalid');
  }
  if (
    typeof object.privateKey !== 'string' ||
    !PRIVATE_KEY.test(object.privateKey)
  ) {
    throw new Error('Pending handoff private key is invalid');
  }
  const request = parseHandoffRequest(
    encodeHandoffRequest(object.request as HandoffRequest),
  );
  if (state === 'consuming') {
    if (
      typeof object.consumingAt !== 'string' ||
      !Number.isFinite(Date.parse(object.consumingAt))
    ) {
      throw new Error('Pending handoff consuming timestamp is invalid');
    }
    return {
      v: 1,
      state,
      request,
      privateKey: object.privateKey,
      consumingAt: object.consumingAt,
    };
  }
  return { v: 1, state, request, privateKey: object.privateKey };
}

function isExpired(request: HandoffRequest): boolean {
  return Date.parse(request.expiresAt) <= Date.now();
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
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code,
  );
}
