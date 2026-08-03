import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Cap shared with reminder body evidence attachment (spec: reuse body upper bound). */
export const REMINDER_BODY_MAX_CHARS = 32_000;

export const PREFLIGHT_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const PREFLIGHT_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type PreflightRunStatus = 'succeeded' | 'declined' | 'errored';

export interface PreflightLastResult {
  durationMs: number;
  endedAt: string;
  exitCode?: number;
  scheduledAt: string;
  signal?: string;
  startedAt: string;
  status: PreflightRunStatus;
  stderr?: string;
  stderrTruncated?: boolean;
  stdout?: string;
  stdoutTruncated?: boolean;
  timedOut?: boolean;
}

export interface RunPreflightInput {
  command: string;
  cwd: string;
  now?: Date;
  scheduledAt: string;
  timeoutMs?: number;
}

export interface RunPreflightOutput {
  result: PreflightLastResult;
}

/** In-process Forbid map: one preflight run per reminder at a time. */
const runningPreflights = new Set<string>();

export function isPreflightRunning(reminderId: string): boolean {
  return runningPreflights.has(reminderId);
}

export function tryBeginPreflight(reminderId: string): boolean {
  if (runningPreflights.has(reminderId)) return false;
  runningPreflights.add(reminderId);
  return true;
}

export function endPreflight(reminderId: string): void {
  runningPreflights.delete(reminderId);
}

/** Test-only: clear concurrency map between cases. */
export function resetPreflightConcurrencyForTests(): void {
  runningPreflights.clear();
}

export function normalizePreflightTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return PREFLIGHT_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('preflight timeoutMs must be a positive number of milliseconds');
  }
  if (timeoutMs > PREFLIGHT_MAX_TIMEOUT_MS) {
    throw new Error(
      `preflight timeoutMs exceeds v1 hard cap of ${PREFLIGHT_MAX_TIMEOUT_MS}ms (24h)`,
    );
  }
  return Math.floor(timeoutMs);
}

export function validatePreflightCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('preflight command must be non-empty');
  return trimmed;
}

/**
 * Run a preflight shell command with fixed CWD (Agent Home).
 * Timeout kills the entire process group. Does not inject env secrets.
 */
export async function runPreflightCommand(input: RunPreflightInput): Promise<RunPreflightOutput> {
  const command = validatePreflightCommand(input.command);
  const timeoutMs = normalizePreflightTimeoutMs(input.timeoutMs);
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const startedMs = now.getTime();

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stderrTruncated: boolean;
    stdout: string;
    stdoutTruncated: boolean;
    timedOut: boolean;
  }>((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(command, {
      cwd: input.cwd,
      detached: true,
      env: process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const next = appendBounded(stdout, chunk, REMINDER_BODY_MAX_CHARS);
      if (next.length < stdout.length + chunk.length) stdoutTruncated = true;
      stdout = next;
    });
    child.stderr?.on('data', (chunk: string) => {
      const next = appendBounded(stderr, chunk, REMINDER_BODY_MAX_CHARS);
      if (next.length < stderr.length + chunk.length) stderrTruncated = true;
      stderr = next;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stderr,
        stderrTruncated,
        stdout,
        stdoutTruncated,
        timedOut,
      });
    };

    child.on('error', (error) => {
      stderr = appendBounded(stderr, `${errorMessage(error)}\n`, REMINDER_BODY_MAX_CHARS);
      finish(null, null);
    });
    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });

  const ended = new Date();
  const endedAt = ended.toISOString();
  const durationMs = Math.max(0, ended.getTime() - startedMs);
  let status: PreflightRunStatus;
  let exitCode = result.exitCode ?? undefined;
  if (result.timedOut) {
    status = 'errored';
  } else if (result.signal) {
    status = 'errored';
  } else if (result.exitCode === 0) {
    status = 'succeeded';
  } else if (result.exitCode === 1) {
    status = 'declined';
  } else {
    status = 'errored';
    // spawn error with null code
    if (result.exitCode === null) exitCode = 127;
  }

  const last: PreflightLastResult = {
    durationMs,
    endedAt,
    scheduledAt: input.scheduledAt,
    startedAt,
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
    ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
  };

  return { result: last };
}

export function preflightEvidenceForWake(result: PreflightLastResult): string | undefined {
  if (result.status !== 'succeeded') return undefined;
  const stdout = result.stdout?.trim();
  if (!stdout) return undefined;
  const marker = result.stdoutTruncated ? '\n…[preflight stdout truncated]' : '';
  return `Preflight output (exit 0):\n${stdout}${marker}`;
}

export function classifyPreflightAttentionKey(reminderId: string, result: PreflightLastResult): string {
  // Throttle key so identical errored results can be rate-limited by callers.
  const hash = createHash('sha256')
    .update([
      reminderId,
      result.status,
      String(result.exitCode ?? ''),
      result.signal ?? '',
      result.timedOut ? '1' : '0',
      result.stderr ?? '',
    ].join('|'))
    .digest('hex')
    .slice(0, 16);
  return `preflight-error:${reminderId}:${hash}`;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function appendBounded(current: string, chunk: string, max: number): string {
  if (current.length >= max) return current;
  const remaining = max - current.length;
  return current + chunk.slice(0, remaining);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
