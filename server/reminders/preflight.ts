import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildServiceEnvironment } from '../services/env.js';

/** Cap shared with reminder body evidence attachment (spec: reuse body upper bound). */
export const REMINDER_BODY_MAX_CHARS = 32_000;

export const PREFLIGHT_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const PREFLIGHT_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type PreflightRunStatus = 'succeeded' | 'declined' | 'errored';

export interface PreflightExecutionResult {
  durationMs: number;
  endedAt: string;
  exitCode?: number;
  signal?: string;
  startedAt: string;
  status: PreflightRunStatus;
  stderr?: string;
  stderrTruncated?: boolean;
  stdout?: string;
  stdoutTruncated?: boolean;
  timedOut?: boolean;
}

export interface PreflightLastResult extends PreflightExecutionResult {
  scheduledAt: string;
}

export interface RunPreflightInput {
  abortSignal?: AbortSignal;
  agentId: string;
  animaHome: string;
  command: string;
  cwd: string;
  now?: Date;
  reminderId?: string;
  runtimeEnv?: Record<string, string>;
  scheduledAt?: string;
  timeoutMs?: number;
}

export interface RunPreflightOutput {
  aborted: boolean;
  result?: PreflightExecutionResult;
}

interface RunHostedPreflightInput extends RunPreflightInput {
  reminderId: string;
  scheduledAt: string;
}

interface RunHostedPreflightOutput extends RunPreflightOutput {
  result?: PreflightLastResult;
}

interface ManagedPreflight {
  kill: () => void;
  reminderId: string;
}

/** In-process Forbid + kill handles for managed preflight jobs. */
const runningPreflights = new Map<string, ManagedPreflight>();

export function isPreflightRunning(reminderId: string): boolean {
  return runningPreflights.has(reminderId);
}

export function tryBeginPreflight(reminderId: string, kill: () => void): boolean {
  if (runningPreflights.has(reminderId)) return false;
  runningPreflights.set(reminderId, { kill, reminderId });
  return true;
}

export function endPreflight(reminderId: string): void {
  runningPreflights.delete(reminderId);
}

export function killAllRunningPreflights(): void {
  for (const job of runningPreflights.values()) {
    try {
      job.kill();
    } catch {
      // best-effort
    }
  }
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
 * The caller supplies the agent's captured configured/managed runtime env; no
 * wake-item context is invented. Timeout / abort kill the entire process group.
 */
export function runPreflightCommand(input: RunHostedPreflightInput): Promise<RunHostedPreflightOutput>;
export function runPreflightCommand(input: RunPreflightInput): Promise<RunPreflightOutput>;
export async function runPreflightCommand(input: RunPreflightInput): Promise<RunPreflightOutput> {
  const command = validatePreflightCommand(input.command);
  const timeoutMs = normalizePreflightTimeoutMs(input.timeoutMs);
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const startedMs = now.getTime();

  if (input.abortSignal?.aborted) {
    return { aborted: true };
  }

  let child: ChildProcess | undefined;
  const kill = () => killProcessGroup(child?.pid);

  const result = await new Promise<{
    aborted: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stderrTruncated: boolean;
    stdout: string;
    stdoutTruncated: boolean;
    timedOut: boolean;
  }>((resolve) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    child = spawn(command, {
      cwd: input.cwd,
      detached: true,
      env: buildPreflightEnvironment({
        agentId: input.agentId,
        animaHome: input.animaHome,
        reminderId: input.reminderId,
        runtimeEnv: input.runtimeEnv,
      }),
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
      kill();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      kill();
    };
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.abortSignal?.removeEventListener('abort', onAbort);
      resolve({
        aborted,
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

  if (result.aborted && !result.timedOut) {
    return { aborted: true };
  }

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
    if (result.exitCode === null) exitCode = 127;
  }

  const last: PreflightExecutionResult = {
    durationMs,
    endedAt,
    startedAt,
    status,
    ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
    ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
  };

  return { aborted: false, result: last };
}

export interface PreflightEnvironmentOptions {
  agentId: string;
  animaHome: string;
  reminderId?: string;
  runtimeEnv?: Record<string, string>;
}

const PREFLIGHT_ITEM_ENV_KEYS = [
  'ANIMA_CHANNEL',
  'ANIMA_CHANNEL_ID',
  'ANIMA_CHANNEL_NAME',
  'ANIMA_INBOX_ITEM_ID',
  'ANIMA_INSTRUCTIONS_PATH',
  'ANIMA_MESSAGE_TS',
  'ANIMA_SESSION_KEY',
  'ANIMA_SURFACE_KIND',
  'ANIMA_THREAD',
  'ANIMA_THREAD_TS',
  'ANIMA_WORKSPACE_PATH',
] as const;

export function buildPreflightEnvironment(
  options: PreflightEnvironmentOptions,
): Record<string, string> {
  // Provider children also inherit process.env. Preflight deliberately starts
  // from stable service basics so the firing caller cannot leak item identity
  // or override the agent-owned startup snapshot handed in by the host.
  const env = {
    ...buildServiceEnvironment({ animaHome: options.animaHome }),
    ...(options.runtimeEnv ?? {}),
  };
  for (const key of PREFLIGHT_ITEM_ENV_KEYS) delete env[key];
  const packageBin = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'bin');
  env.ANIMA_AGENT_ID = options.agentId;
  env.ANIMA_HOME = options.animaHome;
  delete env.ANIMA_REMINDER_ID;
  if (options.reminderId) env.ANIMA_REMINDER_ID = options.reminderId;
  env.PATH = [packageBin, env.PATH].join(delimiter);
  return env;
}

export function preflightEvidenceForWake(result: PreflightLastResult): string | undefined {
  if (result.status !== 'succeeded') return undefined;
  const stdout = result.stdout?.trim();
  if (!stdout) return undefined;
  const marker = result.stdoutTruncated ? '\n…[preflight stdout truncated]' : '';
  return `Preflight output (exit 0):\n${stdout}${marker}`;
}

export function classifyPreflightAttentionKey(reminderId: string, result: PreflightLastResult): string {
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

export function killProcessGroup(pid: number | undefined): void {
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
