import { spawn } from 'node:child_process';
import { mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const FULL_SERVICE_LOG_BYTES = 20 * 1024 * 1024;

export interface FakeServiceManager {
  /** Start actions the fake received, as `<action> rotated=<yes|no>`. */
  actions: () => Promise<string[]>;
  callsPath: string;
  env: NodeJS.ProcessEnv;
  home: string;
  logPath: string;
}

/**
 * Put a fake launchctl or systemctl first on PATH for one isolated Anima home
 * whose agent.log is already full. The fake reports the agent service stopped
 * until a start action runs, then running. Each start action records whether
 * `agent.log.1` existed at that moment, which shows the rotation ran before
 * the manager would open the log.
 */
export async function writeFakeServiceManager(
  tempDir: string,
  command: 'launchctl' | 'systemctl',
): Promise<FakeServiceManager> {
  const home = join(tempDir, 'home');
  const configDir = join(home, '.anima');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), '{}\n', 'utf8');
  const logPath = join(configDir, 'logs', 'agent.log');
  await mkdir(join(configDir, 'logs'), { recursive: true });
  await writeFile(logPath, 'old log\n');
  await truncate(logPath, FULL_SERVICE_LOG_BYTES);

  const binDir = join(tempDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const callsPath = join(tempDir, `${command}-calls`);
  const runningPath = join(tempDir, `${command}-running`);
  const status = command === 'launchctl'
    ? [
        'if [ "$1" = print ]; then',
        `  if [ -e '${runningPath}' ]; then printf 'state = running\\n\\tpid = 4242\\n'; exit 0; fi`,
        '  exit 113',
        'fi',
        'action="$1"',
      ]
    : [
        'if [ "$2" = show ]; then',
        `  if [ -e '${runningPath}' ]; then printf 'LoadState=loaded\\nActiveState=active\\nMainPID=4242\\nUnitFileState=enabled\\n'; exit 0; fi`,
        "  printf 'LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nUnitFileState=enabled\\n'",
        '  exit 0',
        'fi',
        'action="$2"',
      ];
  await writeFile(join(binDir, command), [
    '#!/bin/sh',
    ...status,
    `if [ -e '${logPath}.1' ]; then rotated=yes; else rotated=no; fi`,
    `echo "$action rotated=$rotated" >> '${callsPath}'`,
    `case "$action" in kickstart|start) : > '${runningPath}' ;; esac`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  return {
    actions: async () => {
      try {
        return (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    callsPath,
    env: {
      ANIMA_HOME: configDir,
      HOME: home,
      PATH: `${binDir}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: join(home, '.config'),
    },
    home,
    logPath,
  };
}

/** Run `animactl` from the built dist with a clean runtime identity. */
export async function runAnimactlWith(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, [resolve('dist/server/cli/animactl.js'), ...args], {
    env: {
      ...process.env,
      ANIMA_AGENT_ID: '',
      ANIMA_HOME: '',
      ANIMA_INBOX_ITEM_ID: '',
      ANIMA_RUNTIME_HOME: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const status = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  return { status, stderr, stdout };
}
