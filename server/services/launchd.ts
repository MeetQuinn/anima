import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildServiceEnvironment } from './env.js';
import type { ServiceSpec, SupervisorOptions } from './supervisor.js';

export interface LaunchdStatus {
  installed: boolean;
  label: string;
  loaded: boolean;
  manager: 'launchd';
  pid?: number;
  plistPath: string;
  running: boolean;
}

export function launchdSupported(): boolean {
  return process.platform === 'darwin';
}

export async function launchdServiceInstalled(spec: ServiceSpec): Promise<boolean> {
  if (!launchdSupported()) return false;
  try {
    await stat(launchdPlistPath(spec));
    return true;
  } catch {
    return false;
  }
}

export async function installLaunchdService(spec: ServiceSpec, options: SupervisorOptions): Promise<void> {
  assertLaunchdSupported();
  const plistPath = launchdPlistPath(spec);
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(serviceLogDir(spec), { recursive: true });
  await writeFile(plistPath, buildLaunchdPlist(spec, options), 'utf8');

  const status = await launchdServiceStatus(spec);
  for (const action of launchdInstallActions(status)) {
    const invocation = launchdActionInvocation(action, spec, plistPath);
    await launchctl(invocation.args, invocation.options);
    if (action === 'bootout') await waitForLaunchdUnloaded(spec, status.pid);
  }
  const next = await waitForLaunchdRunning(spec);
  const pidPart = next.pid !== undefined ? ` pid ${next.pid}` : '';
  console.log(`${spec.id}: installed launchd ${launchdLabel(spec)}${pidPart} plist ${plistPath}`);
}

export async function uninstallLaunchdService(spec: ServiceSpec): Promise<void> {
  assertLaunchdSupported();
  const plistPath = launchdPlistPath(spec);
  if (await launchdServiceInstalled(spec)) {
    const status = await launchdServiceStatus(spec);
    await launchctl(['bootout', launchdServiceTarget(spec)], { allowFailure: true });
    await waitForLaunchdUnloaded(spec, status.pid);
    await rm(plistPath, { force: true });
    console.log(`${spec.id}: uninstalled launchd ${launchdLabel(spec)}`);
  } else {
    console.log(`${spec.id}: launchd service not installed`);
  }
}

export async function startLaunchdService(spec: ServiceSpec): Promise<LaunchdStatus> {
  assertLaunchdSupported();
  const plistPath = launchdPlistPath(spec);
  if (!(await launchdServiceInstalled(spec))) {
    throw new Error(`${spec.id}: launchd service is not installed. Run \`animactl services install${spec.id === 'web' ? ' --only web' : spec.id === 'agent' ? ' --only agent' : ''}\` first.`);
  }

  const status = await launchdServiceStatus(spec);
  const actions = launchdStartActions(status);
  if (actions.length === 0) {
    const pidPart = status.pid !== undefined ? ` pid ${status.pid}` : '';
    console.log(`${spec.id}: already running launchd ${launchdLabel(spec)}${pidPart}`);
    return status;
  }
  for (const action of actions) {
    const invocation = launchdActionInvocation(action, spec, plistPath);
    await launchctl(invocation.args, invocation.options);
  }
  const next = await waitForLaunchdRunning(spec);
  const pidPart = next.pid !== undefined ? ` pid ${next.pid}` : '';
  console.log(`${spec.id}: started launchd ${launchdLabel(spec)}${pidPart} log ${serviceLogPath(spec)}`);
  return next;
}

export async function stopLaunchdService(spec: ServiceSpec): Promise<void> {
  assertLaunchdSupported();
  if (!(await launchdServiceInstalled(spec))) {
    console.log(`${spec.id}: launchd service not installed`);
    return;
  }
  const status = await launchdServiceStatus(spec);
  const actions = launchdStopActions(status);
  if (actions.length) {
    for (const action of actions) {
      const invocation = launchdActionInvocation(action, spec, launchdPlistPath(spec));
      await launchctl(invocation.args, invocation.options);
      if (action === 'bootout') await waitForLaunchdUnloaded(spec, status.pid);
    }
    console.log(`${spec.id}: stopped launchd ${launchdLabel(spec)}`);
  } else {
    console.log(`${spec.id}: not running`);
  }
}

export async function launchdServiceStatus(spec: ServiceSpec): Promise<LaunchdStatus> {
  const installed = await launchdServiceInstalled(spec);
  const runtime = installed ? await readLaunchdRuntime(spec) : { loaded: false };
  return {
    installed,
    label: launchdLabel(spec),
    loaded: runtime.loaded,
    manager: 'launchd',
    pid: runtime.pid,
    plistPath: launchdPlistPath(spec),
    running: runtime.pid !== undefined,
  };
}

type LaunchdAction = 'bootout' | 'bootstrap' | 'kickstart';

export function launchdInstallActions(status: Pick<LaunchdStatus, 'loaded'>): LaunchdAction[] {
  return status.loaded ? ['bootout', 'bootstrap', 'kickstart'] : ['bootstrap', 'kickstart'];
}

export function launchdStartActions(status: Pick<LaunchdStatus, 'loaded' | 'running'>): LaunchdAction[] {
  if (status.running) return [];
  return status.loaded ? ['kickstart'] : ['bootstrap', 'kickstart'];
}

export function launchdStopActions(status: Pick<LaunchdStatus, 'loaded'>): LaunchdAction[] {
  return status.loaded ? ['bootout'] : [];
}

export function launchdActionInvocation(
  action: LaunchdAction,
  spec: ServiceSpec,
  plistPath: string,
): {
  args: string[];
  options: { allowAlreadyLoaded?: boolean; allowFailure?: boolean };
} {
  if (action === 'bootout') {
    return { args: ['bootout', launchdServiceTarget(spec)], options: { allowFailure: true } };
  }
  if (action === 'bootstrap') {
    return { args: ['bootstrap', launchdDomainTarget(), plistPath], options: { allowAlreadyLoaded: true } };
  }
  return { args: ['kickstart', launchdServiceTarget(spec)], options: {} };
}

export function buildLaunchdPlist(spec: ServiceSpec, options: SupervisorOptions): string {
  const env = buildServiceEnvironment({
    animaHome: spec.animaHome,
    nodePath: process.execPath,
  });
  const programArguments = [
    process.execPath,
    options.animactl,
    ...spec.args,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    keyString('Label', launchdLabel(spec)),
    keyArray('ProgramArguments', programArguments),
    keyDict('EnvironmentVariables', env),
    keyString('WorkingDirectory', options.cwd),
    keyString('StandardOutPath', serviceLogPath(spec)),
    keyString('StandardErrorPath', serviceLogPath(spec)),
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>5</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function launchdLabel(spec: ServiceSpec): string {
  const defaultHome = resolve(homedir(), '.anima');
  if (resolve(spec.animaHome) === defaultHome) return `ai.meetquinn.anima.${spec.id}`;
  const digest = createHash('sha256').update(resolve(spec.animaHome)).digest('hex').slice(0, 10);
  return `ai.meetquinn.anima.${digest}.${spec.id}`;
}

export function launchdPlistPath(spec: ServiceSpec): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(spec)}.plist`);
}

export function parseLaunchdRuntime(result: { status: number | null; stdout: string }): { loaded: boolean; pid?: number } {
  if (result.status !== 0) return { loaded: false };
  const pidMatch = result.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  const pid = pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : undefined;
  return Number.isFinite(pid) ? { loaded: true, pid } : { loaded: true };
}

async function readLaunchdRuntime(spec: ServiceSpec): Promise<{ loaded: boolean; pid?: number }> {
  const output = await launchctl(['print', launchdServiceTarget(spec)], { allowFailure: true });
  return parseLaunchdRuntime(output);
}

async function waitForLaunchdUnloaded(spec: ServiceSpec, previousPid?: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = await launchdServiceStatus(spec);
  while (last.loaded || (previousPid !== undefined && await isPidRunning(previousPid))) {
    if (Date.now() >= deadline) {
      const pidPart = last.pid !== undefined ? ` pid ${last.pid}` : '';
      const previousPart = previousPid !== undefined && await isPidRunning(previousPid)
        ? `; previous pid ${previousPid} still running`
        : '';
      throw new Error(`${spec.id}: launchd ${launchdLabel(spec)} did not unload after bootout${pidPart}${previousPart}`);
    }
    await sleep(100);
    last = await launchdServiceStatus(spec);
  }
}

async function waitForLaunchdRunning(spec: ServiceSpec): Promise<LaunchdStatus> {
  const deadline = Date.now() + 10_000;
  let last = await launchdServiceStatus(spec);
  while (!last.running) {
    if (Date.now() >= deadline) {
      throw new Error(`${spec.id}: launchd ${launchdLabel(spec)} did not report a running pid after start`);
    }
    await sleep(100);
    last = await launchdServiceStatus(spec);
  }
  return last;
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function launchdDomainTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('launchd gui domain requires a user id');
  return `gui/${uid}`;
}

function launchdServiceTarget(spec: ServiceSpec): string {
  return `${launchdDomainTarget()}/${launchdLabel(spec)}`;
}

async function launchctl(
  args: string[],
  options: { allowAlreadyLoaded?: boolean; allowFailure?: boolean } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const result = await run('launchctl', args);
  if (result.status === 0) return result;
  const alreadyLoaded = /Bootstrap failed:.*5|Input\/output error|already exists|service already loaded/i.test(result.stderr);
  if (options.allowAlreadyLoaded && alreadyLoaded) return result;
  if (options.allowFailure) return result;
  throw new Error(result.stderr.trim() || `launchctl ${args.join(' ')} exited with ${result.status ?? 'unknown status'}`);
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

function assertLaunchdSupported(): void {
  if (!launchdSupported()) throw new Error('launchd service management is only supported on macOS.');
}

function serviceLogDir(spec: ServiceSpec): string {
  return join(spec.animaHome, 'logs');
}

function serviceLogPath(spec: ServiceSpec): string {
  return join(serviceLogDir(spec), spec.logName);
}

function keyArray(key: string, values: string[]): string {
  return [
    `<key>${xmlEscape(key)}</key>`,
    '<array>',
    ...values.map((value) => `<string>${xmlEscape(value)}</string>`),
    '</array>',
  ].join('\n');
}

function keyDict(key: string, values: Record<string, string>): string {
  return [
    `<key>${xmlEscape(key)}</key>`,
    '<dict>',
    ...Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([entryKey, entryValue]) => [
        `<key>${xmlEscape(entryKey)}</key>`,
        `<string>${xmlEscape(entryValue)}</string>`,
      ]),
    '</dict>',
  ].join('\n');
}

function keyString(key: string, value: string): string {
  return `<key>${xmlEscape(key)}</key>\n<string>${xmlEscape(value)}</string>`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
