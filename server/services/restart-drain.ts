import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { resolveAnimaHome } from '../anima-home.js';
import { JsonStore } from '../storage/json-store.js';
import { cacheDelete } from '../storage/json-file.js';

const RestartDrainRequest = z.object({
  expiresAt: z.string(),
  requestedAt: z.string(),
});

type RestartDrainRequest = z.infer<typeof RestartDrainRequest>;

const restartDrainStore = new JsonStore<RestartDrainRequest | undefined>({
  empty: () => undefined,
  parse: (value) => value === undefined ? undefined : RestartDrainRequest.parse(value),
  path: restartDrainPath,
});

export async function requestRestartDrain(ttlMs: number): Promise<void> {
  const requestedAt = Date.now();
  await restartDrainStore.write({
    expiresAt: new Date(requestedAt + ttlMs).toISOString(),
    requestedAt: new Date(requestedAt).toISOString(),
  });
}

export async function clearRestartDrain(): Promise<void> {
  const path = restartDrainPath();
  await rm(path, { force: true });
  cacheDelete(path);
}

export async function isRestartDrainActive(): Promise<boolean> {
  const request = await restartDrainStore.read();
  if (!request) return false;
  if (Date.parse(request.expiresAt) > Date.now()) return true;
  await clearRestartDrain().catch(() => {});
  return false;
}

function restartDrainPath(): string {
  return join(resolveAnimaHome(), 'run', 'restart-drain.json');
}
