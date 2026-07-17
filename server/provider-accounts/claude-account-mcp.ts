import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ClaudeCodeAccountConfig } from '../../shared/provider-accounts.js';
import { claudeAccountMetadataPath } from './claude-account-config.js';
import { ClaudeAccountContinuityError } from './claude-account-continuity.js';

const PROJECT_MCP_FIELDS = [
  'disabledMcpServers',
  'disabledMcpjsonServers',
  'enabledMcpjsonServers',
  'mcpServers',
] as const;

type JsonObject = Record<string, unknown>;

interface MetadataSnapshot {
  bytes: Buffer;
  mode: number;
  parsed: JsonObject;
  path: string;
}

export async function synchronizeClaudeAccountMcpState(
  sourceAccount: ClaudeCodeAccountConfig,
  targetAccount: ClaudeCodeAccountConfig,
): Promise<void> {
  return synchronizeClaudeAccountMcpStateAtPaths(
    claudeAccountMetadataPath(sourceAccount),
    claudeAccountMetadataPath(targetAccount),
  );
}

export async function synchronizeClaudeAccountMcpStateAtPaths(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  if (sourcePath === targetPath) return;

  const [source, target] = await Promise.all([
    readMetadata(sourcePath, 'source'),
    readMetadata(targetPath, 'target'),
  ]);
  const next = mergeMcpState(source.parsed, target.parsed);
  if (isDeepStrictEqual(next, target.parsed)) return;

  const nextBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
  const currentBytes = await readFile(target.path);
  if (!currentBytes.equals(target.bytes)) {
    throw new ClaudeAccountContinuityError(
      `Claude account metadata changed while MCP settings were being prepared: ${target.path}`,
    );
  }
  const backupPath = `${target.path}.anima-account-backup`;
  await assertWritableMetadataPath(backupPath, 'backup');
  await writeAtomicFile(backupPath, target.bytes, target.mode & 0o600, 'backup');

  await writeAtomicFile(target.path, nextBytes, target.mode, 'target', target.bytes);
}

function mergeMcpState(source: JsonObject, target: JsonObject): JsonObject {
  const next = structuredClone(target);
  copyOptionalField(source, next, 'mcpServers');

  const sourceProjects = readProjects(source, 'source');
  const targetProjects = readProjects(target, 'target');
  const nextProjects = targetProjects ? structuredClone(targetProjects) : {};
  const projectPaths = new Set([
    ...Object.keys(sourceProjects ?? {}),
    ...Object.keys(targetProjects ?? {}),
  ]);

  for (const projectPath of projectPaths) {
    const sourceProject = readProject(sourceProjects?.[projectPath], projectPath, 'source');
    const targetProject = readProject(targetProjects?.[projectPath], projectPath, 'target');
    const nextProject = targetProject ? structuredClone(targetProject) : {};
    for (const field of PROJECT_MCP_FIELDS) copyOptionalField(sourceProject, nextProject, field);

    if (Object.keys(nextProject).length > 0) nextProjects[projectPath] = nextProject;
    else delete nextProjects[projectPath];
  }

  if (Object.keys(nextProjects).length > 0 || Object.hasOwn(target, 'projects')) {
    next.projects = nextProjects;
  } else {
    delete next.projects;
  }
  return next;
}

function readProjects(value: JsonObject, role: 'source' | 'target'): JsonObject | undefined {
  if (!Object.hasOwn(value, 'projects')) return undefined;
  const projects = value.projects;
  if (!isJsonObject(projects)) {
    throw new ClaudeAccountContinuityError(
      `Claude ${role} account metadata has a non-object projects field`,
    );
  }
  return projects;
}

function readProject(
  value: unknown,
  projectPath: string,
  role: 'source' | 'target',
): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw new ClaudeAccountContinuityError(
      `Claude ${role} account metadata has a non-object project entry: ${projectPath}`,
    );
  }
  return value;
}

function copyOptionalField(
  source: JsonObject | undefined,
  target: JsonObject,
  field: string,
): void {
  if (source && Object.hasOwn(source, field)) target[field] = structuredClone(source[field]);
  else delete target[field];
}

async function readMetadata(path: string, role: 'source' | 'target'): Promise<MetadataSnapshot> {
  const fileStat = await lstat(path).catch(() => undefined);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
    throw new ClaudeAccountContinuityError(
      `Claude ${role} account metadata is not a regular file: ${path}`,
    );
  }
  const bytes = await readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ClaudeAccountContinuityError(
      `Claude ${role} account metadata is not valid JSON: ${path}`,
    );
  }
  if (!isJsonObject(parsed)) {
    throw new ClaudeAccountContinuityError(
      `Claude ${role} account metadata is not a JSON object: ${path}`,
    );
  }
  return { bytes, mode: fileStat.mode & 0o777, parsed, path };
}

async function assertWritableMetadataPath(path: string, role: 'backup' | 'target'): Promise<void> {
  const fileStat = await lstat(path).catch(() => undefined);
  if (fileStat && (!fileStat.isFile() || fileStat.isSymbolicLink())) {
    throw new ClaudeAccountContinuityError(
      `Claude account metadata ${role} is not a regular file: ${path}`,
    );
  }
}

async function writeAtomicFile(
  path: string,
  bytes: Buffer,
  mode: number,
  role: 'backup' | 'target',
  expectedCurrentBytes?: Buffer,
): Promise<void> {
  await assertWritableMetadataPath(path, role);
  for (let index = 0; index < 1_000; index += 1) {
    const candidate = `${path}.anima-account-temp-${process.pid}-${index}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(candidate, 'wx', mode);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      if (expectedCurrentBytes) {
        await assertWritableMetadataPath(path, role);
        const currentBytes = await readFile(path);
        if (!currentBytes.equals(expectedCurrentBytes)) {
          throw new ClaudeAccountContinuityError(
            `Claude account metadata changed before its MCP settings could be committed: ${path}`,
          );
        }
      }
      await rename(candidate, path);
      await syncParentDirectory(path);
      return;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(candidate, { force: true }).catch(() => undefined);
      if (errorCode(error) === 'EEXIST') continue;
      throw error;
    }
  }
  throw new ClaudeAccountContinuityError(
    `Could not allocate a temporary Claude account metadata file in ${dirname(path)}`,
  );
}

async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dirname(path), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
