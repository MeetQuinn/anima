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
 *
 * launchctl tracks each label separately. A label in `runningLabels` starts out
 * running. A label in `crashLabels` reports its pid once after a start and is
 * gone on the next check, like a program that fails to exec or exits during
 * boot.
 *
 * With `systemdFailed`, systemctl reports the unit failed at its start limit:
 * start and restart are refused until reset-failed runs.
 */
export async function writeFakeServiceManager(
  tempDir: string,
  command: 'launchctl' | 'systemctl',
  options: { crashLabels?: string[]; runningLabels?: string[]; systemdFailed?: boolean } = {},
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
  const stateDir = join(tempDir, `${command}-state`);
  await mkdir(stateDir, { recursive: true });
  for (const label of options.crashLabels ?? []) await writeFile(join(stateDir, `${label}.crash`), '');
  for (const label of options.runningLabels ?? []) await writeFile(join(stateDir, `${label}.running`), '');
  const failedPath = join(stateDir, 'failed');
  if (options.systemdFailed) await writeFile(failedPath, '');
  const status = command === 'launchctl'
    ? [
        'if [ "$1" = print ]; then',
        '  label="${2##*/}"',
        `  if [ -e '${stateDir}'/"$label".running ]; then`,
        `    if [ -e '${stateDir}'/"$label".crash ]; then rm -f '${stateDir}'/"$label".running; fi`,
        "    printf 'state = running\\n\\tpid = 4242\\n'",
        '    exit 0',
        '  fi',
        '  exit 113',
        'fi',
        'action="$1"',
        `if [ "$action" = kickstart ]; then : > '${stateDir}'/"\${2##*/}".running; fi`,
        `if [ "$action" = bootout ]; then rm -f '${stateDir}'/"\${2##*/}".running; fi`,
      ]
    : [
        'if [ "$2" = show ]; then',
        `  if [ -e '${runningPath}' ]; then printf 'LoadState=loaded\\nActiveState=active\\nMainPID=4242\\nUnitFileState=enabled\\n'; exit 0; fi`,
        `  if [ -e '${failedPath}' ]; then state=failed; else state=inactive; fi`,
        "  printf 'LoadState=loaded\\nActiveState=%s\\nMainPID=0\\nUnitFileState=enabled\\n' \"$state\"",
        '  exit 0',
        'fi',
        'action="$2"',
        `if [ "$action" = reset-failed ]; then rm -f '${failedPath}'; fi`,
        `case "$action" in start|restart) if [ -e '${failedPath}' ]; then echo "$action refused" >> '${callsPath}'; echo 'Start request repeated too quickly.' >&2; exit 1; fi ;; esac`,
      ];
  await writeFile(join(binDir, command), [
    '#!/bin/sh',
    ...status,
    `if [ -e '${logPath}.1' ]; then rotated=yes; else rotated=no; fi`,
    `echo "$action rotated=$rotated" >> '${callsPath}'`,
    ...(command === 'systemctl' ? [`case "$action" in start|restart) : > '${runningPath}' ;; esac`] : []),
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
  options: { cwd?: string } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, [resolve('dist/server/cli/animactl.js'), ...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
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
