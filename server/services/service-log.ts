import {
  constants,
  copyFileSync,
  fstatSync,
  ftruncateSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServiceSpec } from './supervisor.js';

const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const LOG_ROTATE_KEEP = 5;
const LIVE_ROTATE_CHECK_MS = 10 * 60_000;

export const AGENT_SERVICE_LOG = 'agent.log';
export const WEB_SERVICE_LOG = 'web.log';

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

export type LiveLogRotation = 'not-append' | 'not-own-log' | 'rotated' | 'under-limit';

/**
 * Rotate the service log this process is writing to, while it runs. launchd
 * (`StandardOutPath`), systemd (`StandardOutput=append:`) and detached starts
 * (`open(path, 'a')`) all hand the service its log as stdout and stderr opened
 * for append. The process copies the full log to `<log>.1` and truncates the
 * file in place, and its next write lands at the new end of the file.
 *
 * Everything runs synchronously, so no log line from this process can land
 * between the copy and the truncate. Only a file that is this process's own
 * stdout is touched, and only after a probe shows that stdout appends: a
 * non-append fd would keep writing at its old offset and leave a hole. When
 * the probe finds a non-append stdout, it leaves one notice line at the end
 * of the log and the fd offset at the new end, and nothing is rotated.
 */
export function rotateOwnServiceLogIfNeeded(
  path: string,
  options: { fd?: number; keep?: number; maxBytes?: number } = {},
): LiveLogRotation {
  const fd = options.fd ?? 1;
  const keep = options.keep ?? LOG_ROTATE_KEEP;
  const maxBytes = options.maxBytes ?? LOG_ROTATE_BYTES;
  let own;
  let onDisk;
  try {
    own = fstatSync(fd);
    onDisk = statSync(path);
  } catch {
    return 'not-own-log';
  }
  if (!own.isFile() || own.dev !== onDisk.dev || own.ino !== onDisk.ino) return 'not-own-log';
  if (own.size < maxBytes) return 'under-limit';
  if (!fdAppends(fd, own.size, path)) return 'not-append';

  rmSync(`${path}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    } catch {
      // Missing older generations are fine.
    }
  }
  copyFileSync(path, `${path}.1`, constants.COPYFILE_FICLONE);
  ftruncateSync(fd, 0);
  return 'rotated';
}

/**
 * Check every ten minutes whether this process's own service log needs
 * rotating. Stops for good if stdout turns out not to append, so a manual
 * `> file` redirect is never truncated. The probe has already written the
 * notice into that log, so the timer adds no warning of its own.
 */
export function startLiveServiceLogRotation(
  path: string,
  options: { fd?: number; intervalMs?: number; keep?: number; maxBytes?: number } = {},
): { stop: () => void } {
  const timer = setInterval(() => {
    try {
      const result = rotateOwnServiceLogIfNeeded(path, options);
      if (result === 'not-append') clearInterval(timer);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`live log rotation skipped for ${path}: ${reason}`);
    }
  }, options.intervalMs ?? LIVE_ROTATE_CHECK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * Tell an append fd from a non-append one without leaving a hole. Grow the
 * file by one zero byte, then write the notice line with a plain write:
 *
 * - An append fd writes it after the zero byte, so the file grows by
 *   1 + notice. Cutting back to `size` removes both.
 * - A non-append fd writes at its own offset. Under a single writer that
 *   offset is the old end of the file, so the notice replaces the zero byte
 *   and the fd now sits at the new end. Its offset cannot be moved back, so
 *   the notice stays: the log keeps every byte it had, gains one line, and
 *   the next write follows it with no NUL.
 *
 * Service logs are often write-only, so the probe never reads.
 */
function fdAppends(fd: number, size: number, path: string): boolean {
  const notice = `live log rotation off for ${path}: stdout does not append\n`;
  ftruncateSync(fd, size + 1);
  let grown: number;
  try {
    writeSync(fd, notice);
    grown = fstatSync(fd).size;
  } catch (error) {
    ftruncateSync(fd, size);
    throw error;
  }
  if (grown !== size + 1 + Buffer.byteLength(notice)) return false;
  ftruncateSync(fd, size);
  return true;
}
