import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanServiceEnv } from './env.js';
import {
  installLaunchdService,
  launchdSupported,
  launchdServiceInstalled,
  launchdServiceStatus,
  startLaunchdService,
  stopLaunchdService,
  uninstallLaunchdService,
} from './launchd.js';
import {
  installSystemdService,
  startSystemdService,
  stopSystemdService,
  systemdServiceInstalled,
  systemdServiceStatus,
  systemdSupported,
  uninstallSystemdService,
} from './systemd.js';

export interface ServiceSpec {
  args: string[];
  animaHome: string;
  id: string;
  /** Previous ids whose pid files should be honored during command renames. */
  legacyIds?: string[];
  logName: string;
  /** Substrings that identify the process command line; any match counts. */
  matchAny: string[];
  /** Optional human URL for display in `status`. */
  url?: string;
}

interface ServiceStatusEntry {
  id: string;
  logPath: string;
  manager?: 'launchd' | 'pid' | 'systemd';
  pid?: number;
  status: 'running' | 'stopped';
  url?: string;
}

export interface SupervisorOptions {
  /** Path to the animactl entrypoint that child processes will invoke. */
  animactl: string;
  /** Working directory for spawned children. */
  cwd: string;
}

const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const LOG_ROTATE_KEEP = 5;

export async function startService(spec: ServiceSpec, options: SupervisorOptions): Promise<ServiceStatusEntry> {
  if (await launchdServiceInstalled(spec)) {
    const status = await startLaunchdService(spec);
    return statusEntry(spec, {
      manager: 'launchd',
      pid: status.pid,
      status: status.running ? 'running' : 'stopped',
    });
  }
  if (await systemdServiceInstalled(spec)) {
    const status = await startSystemdService(spec);
    return statusEntry(spec, {
      manager: 'systemd',
      pid: status.pid,
      status: status.running ? 'running' : 'stopped',
    });
  }

  const existing = await runningPid(spec);
  if (existing) {
    console.log(`${spec.id}: already running pid ${existing}`);
    return statusEntry(spec, { pid: existing, status: 'running' });
  }

  await mkdir(pidDir(spec), { recursive: true });
  await mkdir(logDir(spec), { recursive: true });
  const logPath = serviceLogPath(spec);
  await rotateLogIfNeeded(logPath);
  const log = await open(logPath, 'a');
  await log.write(`\n[${new Date().toISOString()}] starting ${spec.id}\n`);
  const child = spawn(
    process.execPath,
    [options.animactl, ...spec.args],
    {
      cwd: options.cwd,
      detached: true,
      env: { ...cleanServiceEnv(), ANIMA_HOME: spec.animaHome },
      stdio: ['ignore', log.fd, log.fd],
    },
  );
  child.unref();
  await log.close();
  await writeFile(pidPath(spec), `${child.pid}\n`, 'utf8');
  console.log(`${spec.id}: started pid ${child.pid} log ${logPath}`);
  return statusEntry(spec, { pid: child.pid, status: 'running' });
}

export async function stopService(spec: ServiceSpec): Promise<void> {
  if (await launchdServiceInstalled(spec)) {
    await stopLaunchdService(spec);
    return;
  }
  if (await systemdServiceInstalled(spec)) {
    await stopSystemdService(spec);
    return;
  }

  const pid = await readPid(spec);
  if (pid && await isRunning(pid)) {
    await terminate(pid);
    console.log(`${spec.id}: stopped pid ${pid}`);
  } else {
    console.log(`${spec.id}: not running`);
  }
  await rmPidFiles(spec);
}

export async function isServiceRunning(spec: ServiceSpec): Promise<boolean> {
  if (await launchdServiceInstalled(spec)) {
    return (await launchdServiceStatus(spec)).running;
  }
  if (await systemdServiceInstalled(spec)) {
    return (await systemdServiceStatus(spec)).running;
  }
  return Boolean(await runningPid(spec));
}

export async function installService(spec: ServiceSpec, options: SupervisorOptions): Promise<void> {
  if (launchdSupported()) {
    await installLaunchdService(spec, options);
    return;
  }
  if (systemdSupported()) {
    await installSystemdService(spec, options);
    return;
  }
  throw new Error('OS-managed service installation is only supported on macOS launchd or Linux systemd user services.');
}

export async function uninstallService(spec: ServiceSpec): Promise<void> {
  if (await launchdServiceInstalled(spec) || launchdSupported()) {
    await uninstallLaunchdService(spec);
    return;
  }
  if (await systemdServiceInstalled(spec) || systemdSupported()) {
    await uninstallSystemdService(spec);
    return;
  }
  console.log(`${spec.id}: OS-managed service not installed`);
}

async function serviceStatus(spec: ServiceSpec): Promise<ServiceStatusEntry> {
  if (await launchdServiceInstalled(spec)) {
    const status = await launchdServiceStatus(spec);
    return statusEntry(spec, {
      manager: 'launchd',
      pid: status.pid,
      status: status.running ? 'running' : 'stopped',
    });
  }
  if (await systemdServiceInstalled(spec)) {
    const status = await systemdServiceStatus(spec);
    return statusEntry(spec, {
      manager: 'systemd',
      pid: status.pid,
      status: status.running ? 'running' : 'stopped',
    });
  }

  const pid = await runningPid(spec);
  if (pid) return statusEntry(spec, { pid, status: 'running' });
  return statusEntry(spec, { status: 'stopped' });
}

export async function printStatus(specs: ServiceSpec[]): Promise<void> {
  for (const spec of specs) {
    const entry = await serviceStatus(spec);
    const parts = [
      entry.id,
      entry.pid !== undefined ? `running pid ${entry.pid}` : 'stopped',
      entry.manager === 'launchd' || entry.manager === 'systemd' ? entry.manager : undefined,
      entry.url,
      `log ${entry.logPath}`,
    ].filter(Boolean);
    console.log(parts.join(' | '));
  }
}

function statusEntry(spec: ServiceSpec, overrides: { manager?: 'launchd' | 'pid' | 'systemd'; pid?: number; status: 'running' | 'stopped' }): ServiceStatusEntry {
  return {
    id: spec.id,
    logPath: serviceLogPath(spec),
    ...(overrides.manager ? { manager: overrides.manager } : {}),
    status: overrides.status,
    ...(overrides.pid !== undefined ? { pid: overrides.pid } : {}),
    ...(spec.url ? { url: spec.url } : {}),
  };
}

async function runningPid(spec: ServiceSpec): Promise<number | undefined> {
  const pid = await readPid(spec);
  if (pid && await isRunning(pid) && (await matchingAnimactlPids(spec)).includes(pid)) return pid;
  if (pid) await rm(pidPath(spec), { force: true });
  return undefined;
}

async function readPid(spec: ServiceSpec): Promise<number | undefined> {
  for (const id of specIds(spec)) {
    try {
      const value = (await readFile(pidPathForId(spec, id), 'utf8')).trim();
      const pid = Number.parseInt(value, 10);
      if (Number.isFinite(pid)) return pid;
    } catch {
      // Missing pid files are expected for renamed services.
    }
  }
  return undefined;
}

async function matchingAnimactlPids(spec: ServiceSpec): Promise<number[]> {
  const output = await psOutput();
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number.parseInt(match[1] ?? '', 10), command: match[2] ?? '' } : undefined;
    })
    .filter((entry): entry is { pid: number; command: string } => Boolean(entry))
    .filter(({ pid, command }) =>
      pid !== process.pid &&
      command.includes('dist/server/cli/animactl.js') &&
      spec.matchAny.some((needle) => command.includes(needle)),
    )
    .map(({ pid }) => pid);
}

async function psOutput(): Promise<string> {
  return new Promise((resolvePs, rejectPs) => {
    const child = spawn('ps', ['-axo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      if (code === 0) resolvePs(stdout);
      else rejectPs(new Error(stderr || `ps exited with ${code}`));
    });
  });
}

async function terminate(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isRunning(pid))) return;
    await sleep(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidDir(spec: ServiceSpec): string {
  return join(spec.animaHome, 'run');
}

function logDir(spec: ServiceSpec): string {
  return join(spec.animaHome, 'logs');
}

function pidPath(spec: ServiceSpec): string {
  return pidPathForId(spec, spec.id);
}

function pidPathForId(spec: ServiceSpec, id: string): string {
  return join(pidDir(spec), `${id}.pid`);
}

function serviceLogPath(spec: ServiceSpec): string {
  return join(logDir(spec), spec.logName);
}

function specIds(spec: ServiceSpec): string[] {
  return [spec.id, ...(spec.legacyIds ?? [])];
}

async function rmPidFiles(spec: ServiceSpec): Promise<void> {
  await Promise.all(specIds(spec).map((id) => rm(pidPathForId(spec, id), { force: true })));
}

async function rotateLogIfNeeded(path: string): Promise<void> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return;
  }
  if (size < LOG_ROTATE_BYTES) return;

  await rm(`${path}.${LOG_ROTATE_KEEP}`, { force: true });
  for (let index = LOG_ROTATE_KEEP - 1; index >= 1; index -= 1) {
    try {
      await rename(`${path}.${index}`, `${path}.${index + 1}`);
    } catch {
      // Missing older generations are fine.
    }
  }
  await rename(path, `${path}.1`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
