import { spawn } from 'node:child_process';

import { errorMessage } from '../ids.js';

export interface RunningChildProcess {
  completion: Promise<{ stdout: string; stderr: string }>;
  endStdin(): void;
  kill(signal?: NodeJS.Signals): void;
  writeStdin(input: string): void;
}

export interface ChildProcessTerminationOptions {
  forceAfterMs?: number;
  signal?: NodeJS.Signals;
}

export function startChildProcess(input: {
  args: string[];
  bufferOutput?: boolean;
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  label: string;
  onStderrChunk?: (chunk: string) => Promise<void>;
  onStdoutChunk?: (chunk: string) => Promise<void>;
  signal?: AbortSignal;
}): RunningChildProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd ?? process.cwd(),
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (input.signal) {
    if (input.signal.aborted) {
      child.kill('SIGTERM');
    } else {
      const onAbort = () => child.kill('SIGTERM');
      input.signal.addEventListener('abort', onAbort, { once: true });
      child.once('close', () => input.signal?.removeEventListener('abort', onAbort));
    }
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const bufferOutput = input.bufferOutput ?? true;
  let streamEffects = Promise.resolve();
  let streamEffectError: unknown;
  function enqueueStreamEffect(callback: (() => Promise<void>) | undefined): void {
    if (!callback) return;
    streamEffects = streamEffects
      .then(callback)
      .catch((error: unknown) => {
        streamEffectError = error;
      });
  }
  child.stdout.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bufferOutput) stdoutChunks.push(buffer);
    enqueueStreamEffect(input.onStdoutChunk ? () => input.onStdoutChunk?.(buffer.toString('utf8')) ?? Promise.resolve() : undefined);
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bufferOutput) stderrChunks.push(buffer);
    enqueueStreamEffect(input.onStderrChunk ? () => input.onStderrChunk?.(buffer.toString('utf8')) ?? Promise.resolve() : undefined);
  });

  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  }).then(async (exit) => {
    await streamEffects;

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const exitError = childProcessExitError(input.label, exit, stdout, stderr);
    if (exitError) {
      if (streamEffectError) {
        exitError.message = `${exitError.message}\nstream effect failed: ${errorMessage(streamEffectError)}`;
      }
      throw exitError;
    }
    if (streamEffectError) throw streamEffectError;

    return { stderr, stdout };
  });

  return {
    completion,
    endStdin() {
      if (!child.stdin.destroyed) child.stdin.end();
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      child.kill(signal);
    },
    writeStdin(chunk: string) {
      if (child.stdin.destroyed || !child.stdin.writable) throw new Error(`${input.label} stdin is closed`);
      child.stdin.write(chunk);
    },
  };
}

export async function terminateChildProcess(
  child: Pick<RunningChildProcess, 'completion' | 'kill'>,
  options: ChildProcessTerminationOptions = {},
): Promise<{ forced: boolean }> {
  let forced = false;
  child.kill(options.signal ?? 'SIGTERM');
  const forceAfterMs = options.forceAfterMs;
  const forceTimer =
    forceAfterMs !== undefined
      ? setTimeout(() => {
          forced = true;
          child.kill('SIGKILL');
        }, Math.max(0, forceAfterMs))
      : undefined;
  try {
    await child.completion.catch(() => {});
    return { forced };
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
  }
}

function childProcessExitError(
  label: string,
  exit: { code: number | null; signal: NodeJS.Signals | null },
  stdout: string,
  stderr: string,
): Error | undefined {
  if (exit.signal) {
    return new Error(`${label} terminated by ${exit.signal}${stderr ? `: ${stderr.trim()}` : ''}`);
  }
  if (exit.code !== 0) {
    return new Error(
      [
        `${label} exited with code ${exit.code}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
        stdout.trim() ? `stdout: ${stdout.trim()}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return undefined;
}
