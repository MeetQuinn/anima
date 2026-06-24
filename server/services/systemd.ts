import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildServiceEnvironment } from './env.js';
import type { ServiceSpec, SupervisorOptions } from './supervisor.js';

export interface SystemdStatus {
  active: boolean;
  enabled: boolean;
  installed: boolean;
  loaded: boolean;
  manager: 'systemd';
  pid?: number;
  running: boolean;
  serviceName: string;
  unitPath: string;
}

interface SystemdRuntime {
  active: boolean;
  enabled: boolean;
  loaded: boolean;
  pid?: number;
}

export function systemdSupported(): boolean {
  return process.platform === 'linux';
}

export async function systemdServiceInstalled(spec: ServiceSpec): Promise<boolean> {
  if (!systemdSupported()) return false;
  try {
    await stat(systemdUnitPath(spec));
    return true;
  } catch {
    return false;
  }
}

export async function installSystemdService(spec: ServiceSpec, options: SupervisorOptions): Promise<void> {
  assertSystemdSupported();
  const unitPath = systemdUnitPath(spec);
  await mkdir(dirname(unitPath), { recursive: true });
  await mkdir(serviceLogDir(spec), { recursive: true });
  await writeFile(unitPath, buildSystemdUnit(spec, options), 'utf8');

  for (const action of systemdInstallActions()) {
    const invocation = systemdActionInvocation(action, spec);
    await systemctl(invocation.args, invocation.options);
  }
  const next = await waitForSystemdRunning(spec);
  const pidPart = next.pid !== undefined ? ` pid ${next.pid}` : '';
  console.log(`${spec.id}: installed systemd ${systemdServiceName(spec)}${pidPart} unit ${unitPath}`);
}

export async function uninstallSystemdService(spec: ServiceSpec): Promise<void> {
  assertSystemdSupported();
  const unitPath = systemdUnitPath(spec);
  if (await systemdServiceInstalled(spec)) {
    const status = await systemdServiceStatus(spec);
    for (const action of systemdUninstallActions(status)) {
      await systemctl(systemdActionInvocation(action, spec).args, { allowFailure: true });
      if (action === 'stop') await waitForSystemdStopped(spec);
    }
    await rm(unitPath, { force: true });
    await systemctl(systemdActionInvocation('daemon-reload', spec).args, { allowFailure: true });
    console.log(`${spec.id}: uninstalled systemd ${systemdServiceName(spec)}`);
  } else {
    console.log(`${spec.id}: systemd service not installed`);
  }
}

export async function startSystemdService(spec: ServiceSpec): Promise<SystemdStatus> {
  assertSystemdSupported();
  if (!(await systemdServiceInstalled(spec))) {
    throw new Error(`${spec.id}: systemd service is not installed. Run \`animactl services install${spec.id === 'web' ? ' --only web' : spec.id === 'agent' ? ' --only agent' : ''}\` first.`);
  }

  const status = await systemdServiceStatus(spec);
  const actions = systemdStartActions(status);
  if (actions.length === 0) {
    const pidPart = status.pid !== undefined ? ` pid ${status.pid}` : '';
    console.log(`${spec.id}: already running systemd ${systemdServiceName(spec)}${pidPart}`);
    return status;
  }
  for (const action of actions) {
    const invocation = systemdActionInvocation(action, spec);
    await systemctl(invocation.args, invocation.options);
  }
  const next = await waitForSystemdRunning(spec);
  const pidPart = next.pid !== undefined ? ` pid ${next.pid}` : '';
  console.log(`${spec.id}: started systemd ${systemdServiceName(spec)}${pidPart} log ${serviceLogPath(spec)}`);
  return next;
}

export async function stopSystemdService(spec: ServiceSpec): Promise<void> {
  assertSystemdSupported();
  if (!(await systemdServiceInstalled(spec))) {
    console.log(`${spec.id}: systemd service not installed`);
    return;
  }

  const status = await systemdServiceStatus(spec);
  const actions = systemdStopActions(status);
  if (actions.length) {
    for (const action of actions) {
      const invocation = systemdActionInvocation(action, spec);
      await systemctl(invocation.args, invocation.options);
    }
    await waitForSystemdStopped(spec);
    console.log(`${spec.id}: stopped systemd ${systemdServiceName(spec)}`);
  } else {
    console.log(`${spec.id}: not running`);
  }
}

export async function systemdServiceStatus(spec: ServiceSpec): Promise<SystemdStatus> {
  const installed = await systemdServiceInstalled(spec);
  const runtime = installed
    ? await readSystemdRuntime(spec)
    : { active: false, enabled: false, loaded: false };
  return {
    active: runtime.active,
    enabled: runtime.enabled,
    installed,
    loaded: runtime.loaded,
    manager: 'systemd',
    pid: runtime.pid,
    running: runtime.active && runtime.pid !== undefined,
    serviceName: systemdServiceName(spec),
    unitPath: systemdUnitPath(spec),
  };
}

type SystemdAction = 'daemon-reload' | 'disable' | 'enable' | 'restart' | 'start' | 'stop';

export function systemdInstallActions(): SystemdAction[] {
  return ['daemon-reload', 'enable', 'restart'];
}

export function systemdStartActions(status: Pick<SystemdRuntime, 'loaded'> & Pick<SystemdStatus, 'running'>): SystemdAction[] {
  if (status.running) return [];
  return status.loaded ? ['start'] : ['daemon-reload', 'start'];
}

export function systemdStopActions(status: Pick<SystemdStatus, 'loaded'>): SystemdAction[] {
  return status.loaded ? ['stop'] : [];
}

export function systemdUninstallActions(status: Pick<SystemdStatus, 'loaded'>): SystemdAction[] {
  return status.loaded ? ['stop', 'disable'] : ['disable'];
}

export function systemdActionInvocation(
  action: SystemdAction,
  spec: ServiceSpec,
): {
  args: string[];
  options: { allowFailure?: boolean };
} {
  if (action === 'daemon-reload') return { args: ['--user', 'daemon-reload'], options: {} };
  return { args: ['--user', action, systemdServiceName(spec)], options: {} };
}

export function buildSystemdUnit(spec: ServiceSpec, options: SupervisorOptions): string {
  const env = buildServiceEnvironment({
    animaHome: spec.animaHome,
    nodePath: process.execPath,
    platform: 'linux',
  });
  const execStart = [
    process.execPath,
    options.animactl,
    ...spec.args,
  ];
  return [
    '[Unit]',
    `Description=${systemdText(`Anima ${spec.id} service`)}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${systemdPath(options.cwd)}`,
    `ExecStart=${execStart.map(systemdQuoted).join(' ')}`,
    ...Object.entries(env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([entryKey, entryValue]) => `Environment=${systemdQuoted(`${entryKey}=${entryValue}`)}`),
    `StandardOutput=append:${systemdPath(serviceLogPath(spec))}`,
    `StandardError=append:${systemdPath(serviceLogPath(spec))}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function systemdServiceName(spec: ServiceSpec): string {
  const defaultHome = resolve(homedir(), '.anima');
  if (resolve(spec.animaHome) === defaultHome) return `ai.meetquinn.anima.${spec.id}.service`;
  const digest = createHash('sha256').update(resolve(spec.animaHome)).digest('hex').slice(0, 10);
  return `ai.meetquinn.anima.${digest}.${spec.id}.service`;
}

export function systemdUnitPath(spec: ServiceSpec): string {
  return join(systemdConfigHome(), 'systemd', 'user', systemdServiceName(spec));
}

export function parseSystemdRuntime(result: { status: number | null; stdout: string }): SystemdRuntime {
  const fields = new Map(
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return separator === -1
          ? [line, '']
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const loaded = fields.get('LoadState') === 'loaded';
  const active = loaded && fields.get('ActiveState') === 'active';
  const enabled = loaded && fields.get('UnitFileState') === 'enabled';
  const rawPid = Number.parseInt(fields.get('MainPID') ?? '0', 10);
  const pid = active && Number.isFinite(rawPid) && rawPid > 0 ? rawPid : undefined;
  return pid !== undefined ? { active, enabled, loaded, pid } : { active, enabled, loaded };
}

async function readSystemdRuntime(spec: ServiceSpec): Promise<SystemdRuntime> {
  const output = await systemctl([
    '--user',
    'show',
    systemdServiceName(spec),
    '--property=LoadState',
    '--property=ActiveState',
    '--property=MainPID',
    '--property=UnitFileState',
  ], { allowFailure: true });
  return parseSystemdRuntime(output);
}

async function waitForSystemdRunning(spec: ServiceSpec): Promise<SystemdStatus> {
  const deadline = Date.now() + 10_000;
  let last = await systemdServiceStatus(spec);
  while (!last.running) {
    if (Date.now() >= deadline) {
      throw new Error(`${spec.id}: systemd ${systemdServiceName(spec)} did not report a running main pid after start`);
    }
    await sleep(100);
    last = await systemdServiceStatus(spec);
  }
  return last;
}

async function waitForSystemdStopped(spec: ServiceSpec): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = await systemdServiceStatus(spec);
  while (last.running) {
    if (Date.now() >= deadline) {
      const pidPart = last.pid !== undefined ? ` pid ${last.pid}` : '';
      throw new Error(`${spec.id}: systemd ${systemdServiceName(spec)} did not stop${pidPart}`);
    }
    await sleep(100);
    last = await systemdServiceStatus(spec);
  }
}

async function systemctl(
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  let result: { status: number | null; stderr: string; stdout: string };
  try {
    result = await run('systemctl', args);
  } catch (error) {
    throw new Error(`systemctl is required for Linux service management: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.status === 0) return result;
  if (options.allowFailure) return result;
  throw new Error(systemctlErrorMessage(args, result));
}

function systemctlErrorMessage(args: string[], result: { status: number | null; stderr: string; stdout: string }): string {
  const message = result.stderr.trim() || result.stdout.trim() || `systemctl ${args.join(' ')} exited with ${result.status ?? 'unknown status'}`;
  if (/Failed to connect to bus|No medium found|No such file or directory/i.test(message)) {
    return `${message}\nSystemd user services require an available user manager. On headless Linux hosts, run \`loginctl enable-linger $USER\` once, then retry.`;
  }
  return message;
}

function run(command: string, args: string[]): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (status) => {
      resolveRun({ status, stderr, stdout });
    });
  });
}

function assertSystemdSupported(): void {
  if (!systemdSupported()) throw new Error('systemd user service management is only supported on Linux.');
}

function systemdConfigHome(): string {
  const value = process.env.XDG_CONFIG_HOME;
  return value ? resolve(value) : join(homedir(), '.config');
}

function serviceLogDir(spec: ServiceSpec): string {
  return join(spec.animaHome, 'logs');
}

function serviceLogPath(spec: ServiceSpec): string {
  return join(serviceLogDir(spec), spec.logName);
}

function systemdText(value: string): string {
  return value.replaceAll('%', '%%').replaceAll('\n', ' ');
}

function systemdPath(value: string): string {
  return systemdText(value).replaceAll('\\', '\\\\').replaceAll(' ', '\\x20');
}

function systemdQuoted(value: string): string {
  return `"${systemdText(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
