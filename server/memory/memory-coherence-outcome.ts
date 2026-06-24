import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { activityServiceForAgent } from '../activities/activity.service.js';
import { truncateForActivity } from '../activities/format.js';
import { errorMessage, nowIso } from '../ids.js';
import type { MemoryCoherenceInboxItem } from '../../shared/inbox.js';
import type { MemoryCoherenceOutcome, MemoryCoherenceOutcomePayload } from '../../shared/activity.js';

export function memoryCoherenceSummary(text: string | undefined): string | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  return truncateForActivity(trimmed);
}

export function determineMemoryCoherenceOutcome(memoryChanged: boolean): MemoryCoherenceOutcome {
  return memoryChanged ? 'completed' : 'quiet_skipped';
}

export async function memoryCoherenceDigest(homePath: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update('memory-coherence-v1\0');
  await hashPath(hash, homePath, 'MEMORY.md');
  await hashDirectory(hash, homePath, 'notes');
  return hash.digest('hex');
}

export async function recordMemoryCoherenceCompleted(input: {
  agentId: string;
  completedAt?: string;
  item: MemoryCoherenceInboxItem;
  memoryChanged: boolean;
  resultText?: string;
  startedAt: string;
}): Promise<void> {
  const payload = basePayload(input);
  const summary = memoryCoherenceSummary(input.resultText);
  await activityServiceForAgent(input.agentId).record({
    payload: {
      ...payload,
      outcome: determineMemoryCoherenceOutcome(input.memoryChanged),
      ...(summary ? { summary } : {}),
    },
    type: 'memory_coherence.outcome',
  });
}

export async function recordMemoryCoherenceFailed(input: {
  agentId: string;
  completedAt?: string;
  error: unknown;
  item: MemoryCoherenceInboxItem;
  startedAt: string;
}): Promise<void> {
  await activityServiceForAgent(input.agentId).record({
    payload: {
      ...basePayload(input),
      failureReason: errorMessage(input.error),
      outcome: 'failed',
    },
    type: 'memory_coherence.outcome',
  });
}

function basePayload(input: {
  completedAt?: string;
  item: MemoryCoherenceInboxItem;
  startedAt: string;
}): Omit<MemoryCoherenceOutcomePayload, 'outcome'> {
  const completedAt = input.completedAt ?? nowIso();
  const delay = delayMs(input.startedAt, input.item.scheduledSlotAt);
  return {
    completedAt,
    ...(delay > 0 ? { delayMs: delay } : {}),
    scheduledSlotAt: input.item.scheduledSlotAt,
    scheduledSlotLabel: input.item.scheduledSlotLabel,
    startedAt: input.startedAt,
  };
}

function delayMs(startedAt: string, scheduledSlotAt: string): number {
  const start = Date.parse(startedAt);
  const scheduled = Date.parse(scheduledSlotAt);
  if (!Number.isFinite(start) || !Number.isFinite(scheduled)) return 0;
  return Math.max(0, start - scheduled);
}

async function hashDirectory(hash: ReturnType<typeof createHash>, homePath: string, relativePath: string): Promise<void> {
  const fullPath = join(homePath, relativePath);
  const stats = await safeLstat(fullPath);
  if (!stats) {
    hash.update(`missing-dir\0${relativePath}\0`);
    return;
  }
  if (!stats.isDirectory()) {
    await hashPath(hash, homePath, relativePath);
    return;
  }
  const entries = await safeReaddir(fullPath);
  if (!entries) {
    hash.update(`missing-dir\0${relativePath}\0`);
    return;
  }
  hash.update(`dir\0${relativePath}\0`);
  for (const entry of entries) {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) {
      await hashDirectory(hash, homePath, child);
    } else {
      await hashPath(hash, homePath, child);
    }
  }
}

async function hashPath(hash: ReturnType<typeof createHash>, homePath: string, relativePath: string): Promise<void> {
  const fullPath = join(homePath, relativePath);
  const stats = await safeLstat(fullPath);
  if (!stats) {
    hash.update(`missing\0${relativePath}\0`);
    return;
  }
  if (stats.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${await readlink(fullPath)}\0`);
    return;
  }
  if (!stats.isFile()) {
    hash.update(`non-file\0${relativePath}\0`);
    return;
  }
  hash.update(`file\0${relativePath}\0`);
  hash.update(await readFile(fullPath));
  hash.update('\0');
}

async function safeReaddir(path: string): Promise<Array<{ isDirectory(): boolean; name: string }> | undefined> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
