import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServiceSpec } from './supervisor.js';

const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const LOG_ROTATE_KEEP = 5;

export function serviceLogDir(spec: Pick<ServiceSpec, 'animaHome'>): string {
  return join(spec.animaHome, 'logs');
}

export function serviceLogPath(spec: Pick<ServiceSpec, 'animaHome' | 'logName'>): string {
  return join(serviceLogDir(spec), spec.logName);
}

/**
 * Rotate a service log that has reached the size limit: the log becomes
 * `<log>.1`, older generations move up one, and `<log>.<keep>` is dropped.
 *
 * Call this only before a start, while no process has the log open: a running
 * process keeps writing to the renamed file. Rotation is best effort. A failure
 * prints a warning and the start goes on with the old log, so a log problem
 * never keeps a service down.
 */
export async function rotateServiceLogIfNeeded(
  path: string,
  options: { keep?: number; maxBytes?: number } = {},
): Promise<void> {
  const keep = options.keep ?? LOG_ROTATE_KEEP;
  const maxBytes = options.maxBytes ?? LOG_ROTATE_BYTES;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;

  try {
    await rm(`${path}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      try {
        await rename(`${path}.${index}`, `${path}.${index + 1}`);
      } catch {
        // Missing older generations are fine.
      }
    }
    await rename(path, `${path}.1`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`log rotation skipped for ${path}: ${reason}`);
  }
}
