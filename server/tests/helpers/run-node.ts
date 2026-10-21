import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface RunNodeResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

export interface RunNodeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  // Leave stdin open, for a CLI that must not wait on it.
  keepStdinOpen?: boolean;
}

// Runs `node <args>` and collects its output. Waits for 'close', not 'exit':
// 'exit' can fire before the last stdout and stderr chunks arrive.
export async function runNode(args: string[], options: RunNodeOptions = {}): Promise<RunNodeResult> {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  if (!options.keepStdinOpen) child.stdin.end(options.input);
  const [status] = (await once(child, 'close')) as [number | null];
  return { status, stderr, stdout };
}
