import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { resolveAnimaHome } from '../anima-home.js';
import { errorMessage } from '../ids.js';
import { isRecord } from '../json.js';
import { defaultServerSettingsService, type ServerSettingsService } from '../settings/settings.service.js';
import { cleanServiceEnv } from '../services/env.js';
import { listRestartBlockers, restartBlockerInfo, type RestartBlocker } from '../services/restart-gate.js';
import { readServicesRestartSummary, type ServicesRestartSummary } from '../services/restart-result.js';
import { JsonStore } from '../storage/json-store.js';
import {
  compareRuntimeVersions,
  npmDistTagLookup,
  npmTagForReleaseTrack,
  runtimeUpgradeCheckError,
  type RuntimeDistTagLookup,
} from './runtime-release.js';
import {
  DEFAULT_RUNTIME_PACKAGE,
  currentRuntimePackageInfo,
  installManagedRuntime,
  type RuntimePaths,
} from './managed-runtime.js';
import {
  RuntimeUpgradeOperation,
  type RuntimeReleaseTrack,
  type RuntimeUpgradeApplyResponse,
  type RuntimeUpgradeCheckError,
  type RuntimeUpgradeGate,
  type RuntimeUpgradeGateBlocker,
  type RuntimeUpgradeOperation as RuntimeUpgradeOperationType,
  type RuntimeUpgradeStatusResponse,
} from '../../shared/runtime-upgrade.js';
import type { ServerInfo } from '../../shared/server-info.js';

export {
  compareRuntimeVersions,
  npmDistTagLookup,
  npmTagForReleaseTrack,
  runtimeUpgradeCheckError,
};
export type { RuntimeDistTagLookup };

const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
const DEFAULT_DASHBOARD_PORT = 4174;
const DEFAULT_CHECK_TTL_MS = 60 * 60 * 1000;
const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;
const VERIFY_POLL_MS = 1_000;
const UPGRADE_AFTER_RESPONSE_DELAY_MS = 250;
const OPERATION_IDLE: RuntimeUpgradeOperationType = { status: 'idle' };

export interface RuntimeUpgradeServiceOptions {
  checkStore?: RuntimeUpgradeCheckStore;
  checkTtlMs?: number;
  distTagLookup?: RuntimeDistTagLookup;
  now?: () => Date;
  operationStore?: RuntimeUpgradeOperationStore;
  packageName?: string;
  packageVersion?: () => Promise<string>;
  settings?: ServerSettingsService;
}

export interface RuntimeUpgradeWorkerOptions {
  dashboardHost?: string;
  dashboardPort?: number;
  idleTimeoutMs?: number;
  logPath?: string;
  npmCommand?: string;
  packageName?: string;
  previousStartedAt?: string;
  previousVersion?: string;
  releaseTrack: RuntimeReleaseTrack;
  targetVersion: string;
  verifyTimeoutMs?: number;
}

export interface PreparedRuntimeUpgrade {
  response: RuntimeUpgradeApplyResponse;
  spawn: () => Promise<void>;
}

interface RuntimeUpgradeCheckCache {
  checkedAt: string;
  checkError?: RuntimeUpgradeCheckError;
  latestOnTrack?: string;
  releaseTrack: RuntimeReleaseTrack;
}

export class RuntimeUpgradeConflictError extends Error {}

export class RuntimeUpgradeUnavailableError extends Error {}

export class RuntimeUpgradeService {
  private readonly checkStore: RuntimeUpgradeCheckStore;
  private readonly checkTtlMs: number;
  private readonly distTagLookup: RuntimeDistTagLookup;
  private readonly now: () => Date;
  private readonly operationStore: RuntimeUpgradeOperationStore;
  private readonly packageName: string;
  private readonly packageVersion: () => Promise<string>;
  private readonly settings: ServerSettingsService;

  constructor(options: RuntimeUpgradeServiceOptions = {}) {
    this.checkStore = options.checkStore ?? defaultRuntimeUpgradeCheckStore;
    this.checkTtlMs = options.checkTtlMs ?? DEFAULT_CHECK_TTL_MS;
    this.distTagLookup = options.distTagLookup ?? npmDistTagLookup;
    this.now = options.now ?? (() => new Date());
    this.operationStore = options.operationStore ?? defaultRuntimeUpgradeOperationStore;
    this.packageName = options.packageName ?? DEFAULT_RUNTIME_PACKAGE;
    this.packageVersion = options.packageVersion ?? (async () => (await currentRuntimePackageInfo()).version);
    this.settings = options.settings ?? defaultServerSettingsService;
  }

  async status(): Promise<RuntimeUpgradeStatusResponse> {
    const [currentVersion, releaseTrack, gate, operation] = await Promise.all([
      this.packageVersion(),
      this.settings.getReleaseTrack(),
      runtimeUpgradeGate(),
      this.operationStore.read(),
    ]);

    const cached = await this.checkStore.read();
    if (shouldRefreshRuntimeCheck(cached, releaseTrack, this.now(), this.checkTtlMs)) {
      void this.refreshCheckCache(releaseTrack).catch((error) => {
        console.error(`Runtime upgrade check refresh failed: ${errorMessage(error)}`);
      });
    }

    const usableCache = cached.releaseTrack === releaseTrack ? cached : undefined;
    const checkedAt = usableCache?.checkedAt ?? '1970-01-01T00:00:00.000Z';
    const latestOnTrack = usableCache?.latestOnTrack;
    const checkError = usableCache?.checkError;
    const updateAvailable = latestOnTrack ? compareRuntimeVersions(latestOnTrack, currentVersion) > 0 : false;
    return {
      checkedAt,
      ...(checkError ? { checkError } : {}),
      currentVersion,
      gate,
      ...(latestOnTrack ? { latestOnTrack } : {}),
      operation,
      releaseTrack,
      state: checkError ? 'error' : updateAvailable ? 'available' : 'current',
      updateAvailable,
    };
  }

  async checkNow(): Promise<RuntimeUpgradeStatusResponse> {
    const [currentVersion, releaseTrack, operation] = await Promise.all([
      this.packageVersion(),
      this.settings.getReleaseTrack(),
      this.operationStore.read(),
    ]);
    const refreshed = await this.refreshCheckCache(releaseTrack);
    return this.statusFromCheck({
      check: refreshed,
      currentVersion,
      operation,
      releaseTrack,
    });
  }

  async prepareApply(input: {
    animactlScript: string;
    dashboardHost?: string;
    dashboardPort?: number;
    logPath?: string;
    previousStartedAt?: string;
  }): Promise<PreparedRuntimeUpgrade> {
    const [currentVersion, releaseTrack, operation] = await Promise.all([
      this.packageVersion(),
      this.settings.getReleaseTrack(),
      this.operationStore.read(),
    ]);
    if (operation.status === 'scheduled' || operation.status === 'running') {
      throw new RuntimeUpgradeConflictError(`Runtime upgrade already ${operation.status}`);
    }
    const refreshed = await this.refreshCheckCache(releaseTrack);
    const status = await this.statusFromCheck({
      check: refreshed,
      currentVersion,
      operation,
      releaseTrack,
    });
    const latestOnTrack = status.latestOnTrack;
    if (!latestOnTrack) {
      throw new RuntimeUpgradeUnavailableError(status.checkError?.message ?? 'Unable to check runtime package version');
    }
    if (!status.updateAvailable) {
      throw new RuntimeUpgradeUnavailableError(`Runtime is already up to date on ${status.releaseTrack}`);
    }

    const animaHome = resolveAnimaHome();
    const logPath = input.logPath ?? join(animaHome, 'logs', 'runtime-upgrade.log');
    const scheduledAt = this.now().toISOString();
    await this.operationStore.write({
      currentVersion: status.currentVersion,
      logPath,
      previousVersion: status.currentVersion,
      scheduledAt,
      status: 'scheduled',
      targetVersion: status.latestOnTrack,
    });

    const response: RuntimeUpgradeApplyResponse = {
      animaHome,
      currentVersion: status.currentVersion,
      delayMs: UPGRADE_AFTER_RESPONSE_DELAY_MS,
      latestOnTrack,
      logPath,
      ok: true,
      releaseTrack: status.releaseTrack,
      scheduled: true,
    };
    return {
      response,
      spawn: () => spawnRuntimeUpgradeWorker({
        animactlScript: input.animactlScript,
        dashboardHost: input.dashboardHost ?? DEFAULT_DASHBOARD_HOST,
        dashboardPort: input.dashboardPort ?? DEFAULT_DASHBOARD_PORT,
        logPath,
        previousStartedAt: input.previousStartedAt,
        previousVersion: status.currentVersion,
        releaseTrack: status.releaseTrack,
        targetVersion: latestOnTrack,
      }),
    };
  }

  private async refreshCheckCache(releaseTrack: RuntimeReleaseTrack): Promise<RuntimeUpgradeCheckCache> {
    const checkedAt = this.now().toISOString();
    let next: RuntimeUpgradeCheckCache;
    try {
      const latestOnTrack = await this.distTagLookup({
        packageName: this.packageName,
        tag: npmTagForReleaseTrack(releaseTrack),
      });
      next = { checkedAt, latestOnTrack, releaseTrack };
    } catch (error) {
      next = { checkedAt, checkError: runtimeUpgradeCheckError(error), releaseTrack };
    }
    await this.checkStore.write(next);
    return next;
  }

  private async statusFromCheck(input: {
    check: RuntimeUpgradeCheckCache;
    currentVersion: string;
    operation: RuntimeUpgradeOperationType;
    releaseTrack: RuntimeReleaseTrack;
  }): Promise<RuntimeUpgradeStatusResponse> {
    const gate = await runtimeUpgradeGate();
    const latestOnTrack = input.check.releaseTrack === input.releaseTrack ? input.check.latestOnTrack : undefined;
    const checkError = input.check.releaseTrack === input.releaseTrack ? input.check.checkError : undefined;
    const updateAvailable = latestOnTrack ? compareRuntimeVersions(latestOnTrack, input.currentVersion) > 0 : false;
    return {
      checkedAt: input.check.checkedAt,
      ...(checkError ? { checkError } : {}),
      currentVersion: input.currentVersion,
      gate,
      ...(latestOnTrack ? { latestOnTrack } : {}),
      operation: input.operation,
      releaseTrack: input.releaseTrack,
      state: checkError ? 'error' : updateAvailable ? 'available' : 'current',
      updateAvailable,
    };
  }
}

export class RuntimeUpgradeCheckStore {
  private readonly file = new JsonStore<RuntimeUpgradeCheckCache>({
    empty: () => ({
      checkedAt: '1970-01-01T00:00:00.000Z',
      releaseTrack: 'stable',
    }),
    parse: runtimeUpgradeCheckCacheFromUnknown,
    path: () => join(resolveAnimaHome(), 'runtime', 'upgrade-check.json'),
  });

  read(): Promise<RuntimeUpgradeCheckCache> {
    return this.file.read();
  }

  write(check: RuntimeUpgradeCheckCache): Promise<void> {
    return this.file.write(check);
  }
}

export class RuntimeUpgradeOperationStore {
  private readonly file = new JsonStore<RuntimeUpgradeOperationType>({
    empty: () => OPERATION_IDLE,
    parse: RuntimeUpgradeOperation.parse,
    path: () => join(resolveAnimaHome(), 'runtime', 'upgrade-status.json'),
  });

  read(): Promise<RuntimeUpgradeOperationType> {
    return this.file.read();
  }

  write(operation: RuntimeUpgradeOperationType): Promise<void> {
    return this.file.write(operation);
  }
}

export const defaultRuntimeUpgradeCheckStore = new RuntimeUpgradeCheckStore();
export const defaultRuntimeUpgradeOperationStore = new RuntimeUpgradeOperationStore();
export const defaultRuntimeUpgradeService = new RuntimeUpgradeService();

export async function runRuntimeUpgradeWorker(options: RuntimeUpgradeWorkerOptions): Promise<void> {
  const packageName = options.packageName ?? DEFAULT_RUNTIME_PACKAGE;
  const store = defaultRuntimeUpgradeOperationStore;
  const logPath = options.logPath ?? join(resolveAnimaHome(), 'logs', 'runtime-upgrade.log');
  const startedAt = new Date().toISOString();
  await store.write({
    logPath,
    previousVersion: options.previousVersion,
    startedAt,
    status: 'running',
    targetVersion: options.targetVersion,
  });

  let restart: ServicesRestartSummary | undefined;
  try {
    await appendUpgradeLog(logPath, `upgrade worker running target=${options.targetVersion} track=${options.releaseTrack}`);
    const previousPids = await readServicePids(resolveAnimaHome());
    const runtimeDir = join(resolveAnimaHome(), 'runtime', 'current');
    const target = await installManagedRuntime({
      npmCommand: options.npmCommand,
      packageName,
      runtimeDir,
      version: options.targetVersion,
    });
    verifyInstalledRuntime(target.paths);
    restart = await runManagedServicesRestart(target.paths.animactlScript, target.paths.packageDir, options.idleTimeoutMs);
    await verifyRuntimeBoot({
      dashboardHost: options.dashboardHost,
      dashboardPort: options.dashboardPort,
      expectedAnimaHome: resolveAnimaHome(),
      expectedVersion: options.targetVersion,
      previousPids,
      previousStartedAt: options.previousStartedAt,
      timeoutMs: options.verifyTimeoutMs,
    });
    await store.write({
      completedAt: new Date().toISOString(),
      currentVersion: options.targetVersion,
      logPath,
      previousVersion: options.previousVersion,
      ...(restart ? { restart } : {}),
      rollback: 'not_needed',
      startedAt,
      status: 'succeeded',
      targetVersion: options.targetVersion,
    });
    await appendUpgradeLog(logPath, `upgrade succeeded target=${options.targetVersion}`);
  } catch (error) {
    const message = errorMessage(error);
    await appendUpgradeLog(logPath, `upgrade failed target=${options.targetVersion}: ${message}`);
    const rollback = await rollbackRuntime({
      dashboardHost: options.dashboardHost,
      dashboardPort: options.dashboardPort,
      logPath,
      npmCommand: options.npmCommand,
      packageName,
      previousStartedAt: options.previousStartedAt,
      previousVersion: options.previousVersion,
      targetVersion: options.targetVersion,
      timeoutMs: options.verifyTimeoutMs,
    });
    await store.write({
      completedAt: new Date().toISOString(),
      currentVersion: rollback.currentVersion,
      error: message,
      logPath,
      previousVersion: options.previousVersion,
      ...(restart ? { restart } : {}),
      rollback: rollback.status,
      startedAt,
      status: 'failed',
      targetVersion: options.targetVersion,
    });
    throw error;
  }
}

export async function runtimeUpgradeGate(): Promise<RuntimeUpgradeGate> {
  const blockers = await listRestartBlockers({ statuses: ['running'] });
  return {
    blockers: blockers.map(runtimeUpgradeBlocker),
    state: blockers.length > 0 ? 'busy' : 'idle',
  };
}

async function spawnRuntimeUpgradeWorker(input: {
  animactlScript: string;
  dashboardHost: string;
  dashboardPort: number;
  logPath: string;
  previousStartedAt?: string;
  previousVersion: string;
  releaseTrack: RuntimeReleaseTrack;
  targetVersion: string;
}): Promise<void> {
  if (!existsSync(input.animactlScript)) throw new Error(`animactl not found: ${input.animactlScript}`);
  await mkdir(dirname(input.logPath), { recursive: true });
  const log = await open(input.logPath, 'a');
  await log.write(`\n[${new Date().toISOString()}] scheduling runtime upgrade target=${input.targetVersion}\n`);
  const args = [
    input.animactlScript,
    'runtime',
    'upgrade-worker',
    '--target-version',
    input.targetVersion,
    '--previous-version',
    input.previousVersion,
    '--release-track',
    input.releaseTrack,
    '--dashboard-host',
    input.dashboardHost,
    '--dashboard-port',
    String(input.dashboardPort),
    '--log-path',
    input.logPath,
  ];
  if (input.previousStartedAt) args.push('--previous-started-at', input.previousStartedAt);

  const child = spawn(process.execPath, args, {
    cwd: dirname(dirname(dirname(dirname(input.animactlScript)))),
    detached: true,
    env: { ...cleanServiceEnv(), ANIMA_HOME: resolveAnimaHome() },
    stdio: ['ignore', log.fd, log.fd],
  });
  child.on('error', (error) => {
    console.error(`Failed to start runtime upgrade worker: ${error.message}`);
  });
  child.unref();
  await log.close();
}

async function runManagedServicesRestart(
  animactlScript: string,
  packageDir: string,
  idleTimeoutMs: number | undefined,
): Promise<ServicesRestartSummary> {
  const args = [animactlScript, 'services', 'restart', '--drain-active', '--resume-running'];
  if (idleTimeoutMs !== undefined) args.push('--drain-timeout-ms', String(idleTimeoutMs));
  const resultPath = join(resolveAnimaHome(), 'run', `runtime-upgrade-restart-${process.pid}-${Date.now()}.json`);
  const code = await new Promise<number>((resolveDone, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: packageDir,
      env: { ...cleanServiceEnv(), ANIMA_HOME: resolveAnimaHome(), ANIMA_RESTART_RESULT_FILE: resultPath },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) reject(new Error(`services restart exited from signal ${signal}`));
      else resolveDone(exitCode ?? 1);
    });
  });
  if (code !== 0) throw new Error(`services restart exited with code ${code}`);
  try {
    return await readServicesRestartSummary(resultPath);
  } finally {
    await rm(resultPath, { force: true }).catch(() => undefined);
  }
}

function verifyInstalledRuntime(paths: RuntimePaths): void {
  if (!existsSync(paths.animactlScript)) throw new Error(`Installed animactl script missing: ${paths.animactlScript}`);
  const promptTemplate = join(paths.packageDir, 'templates', 'runtime-standing-prompt.md');
  if (!existsSync(promptTemplate)) throw new Error(`Installed runtime template missing: ${promptTemplate}`);
}

async function verifyRuntimeBoot(input: {
  dashboardHost?: string;
  dashboardPort?: number;
  expectedAnimaHome: string;
  expectedVersion: string;
  previousPids: ServicePids;
  previousStartedAt?: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastError = 'not checked';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const info = await fetchServerInfo(input.dashboardHost, input.dashboardPort);
      if (info.version !== input.expectedVersion) throw new Error(`version ${info.version} != ${input.expectedVersion}`);
      if (resolve(info.animaHome) !== resolve(input.expectedAnimaHome)) {
        throw new Error(`animaHome ${info.animaHome} != ${input.expectedAnimaHome}`);
      }
      if (input.previousStartedAt && info.startedAt === input.previousStartedAt) {
        throw new Error(`startedAt did not change (${info.startedAt})`);
      }
      const pids = await readServicePids(input.expectedAnimaHome);
      assertPidMoved('agent', input.previousPids.agent, pids.agent);
      assertPidMoved('web', input.previousPids.web, pids.web);
      const health = await fetch(healthUrl(input.dashboardHost, input.dashboardPort));
      if (!health.ok) throw new Error(`/api/health returned ${health.status}`);
      return;
    } catch (error) {
      lastError = errorMessage(error);
      await sleep(VERIFY_POLL_MS);
    }
  }
  throw new Error(`Runtime boot verification timed out: ${lastError}`);
}

async function rollbackRuntime(input: {
  dashboardHost?: string;
  dashboardPort?: number;
  logPath: string;
  npmCommand?: string;
  packageName: string;
  previousStartedAt?: string;
  previousVersion?: string;
  targetVersion: string;
  timeoutMs?: number;
}): Promise<{ currentVersion?: string; status: 'failed' | 'not_needed' | 'succeeded' }> {
  if (!input.previousVersion) return { status: 'not_needed' };
  try {
    const running = await fetchServerInfo(input.dashboardHost, input.dashboardPort).catch(() => undefined);
    const runtimeDir = join(resolveAnimaHome(), 'runtime', 'current');
    const result = await installManagedRuntime({
      npmCommand: input.npmCommand,
      packageName: input.packageName,
      runtimeDir,
      version: input.previousVersion,
    });
    verifyInstalledRuntime(result.paths);

    if (running?.version === input.previousVersion) {
      await appendUpgradeLog(input.logPath, `rollback reinstalled previous runtime ${input.previousVersion}; old services still running`);
      return { currentVersion: running.version, status: 'succeeded' };
    }

    const previousPids = await readServicePids(resolveAnimaHome());
    await runManagedServicesRestart(result.paths.animactlScript, result.paths.packageDir, undefined);
    await verifyRuntimeBoot({
      dashboardHost: input.dashboardHost,
      dashboardPort: input.dashboardPort,
      expectedAnimaHome: resolveAnimaHome(),
      expectedVersion: input.previousVersion,
      previousPids,
      previousStartedAt: input.previousStartedAt,
      timeoutMs: input.timeoutMs,
    });
    await appendUpgradeLog(input.logPath, `rollback succeeded previous=${input.previousVersion} after failed target=${input.targetVersion}`);
    return { currentVersion: input.previousVersion, status: 'succeeded' };
  } catch (error) {
    await appendUpgradeLog(input.logPath, `rollback failed previous=${input.previousVersion}: ${errorMessage(error)}`);
    return { status: 'failed' };
  }
}

function runtimeUpgradeBlocker(blocker: RestartBlocker): RuntimeUpgradeGateBlocker {
  const info = restartBlockerInfo(blocker);
  if (info.status !== 'queued' && info.status !== 'running') throw new Error(`Invalid runtime upgrade blocker status: ${info.status}`);
  return {
    agentId: info.agentId,
    itemId: info.itemId,
    since: info.since,
    status: info.status,
    ...(info.summary ? { summary: info.summary } : {}),
  };
}

function shouldRefreshRuntimeCheck(
  cached: RuntimeUpgradeCheckCache,
  releaseTrack: RuntimeReleaseTrack,
  now: Date,
  ttlMs: number,
): boolean {
  if (cached.releaseTrack !== releaseTrack) return true;
  const checkedAtMs = Date.parse(cached.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return true;
  return now.getTime() - checkedAtMs >= ttlMs;
}

function runtimeUpgradeCheckCacheFromUnknown(value: unknown): RuntimeUpgradeCheckCache {
  if (!isRecord(value)) {
    return {
      checkedAt: '1970-01-01T00:00:00.000Z',
      releaseTrack: 'stable',
    };
  }
  const releaseTrack = value['releaseTrack'];
  const checkedAt = value['checkedAt'];
  const latestOnTrack = value['latestOnTrack'];
  const checkError = runtimeUpgradeCheckErrorFromUnknown(value['checkError']);
  if (releaseTrack !== 'stable' && releaseTrack !== 'canary') {
    return {
      checkedAt: '1970-01-01T00:00:00.000Z',
      releaseTrack: 'stable',
    };
  }
  return {
    checkedAt: typeof checkedAt === 'string' ? checkedAt : '1970-01-01T00:00:00.000Z',
    ...(checkError ? { checkError } : {}),
    ...(typeof latestOnTrack === 'string' && latestOnTrack ? { latestOnTrack } : {}),
    releaseTrack,
  };
}

function runtimeUpgradeCheckErrorFromUnknown(value: unknown): RuntimeUpgradeCheckError | undefined {
  if (!isRecord(value)) return undefined;
  const type = value['type'];
  const message = value['message'];
  if (type !== 'network' && type !== 'parse' && type !== 'unknown') return undefined;
  if (typeof message !== 'string' || !message) return undefined;
  return { message, type };
}

interface ServicePids {
  agent?: number;
  web?: number;
}

async function readServicePids(animaHome: string): Promise<ServicePids> {
  const [agent, web] = await Promise.all([
    readPid(join(animaHome, 'run', 'agent.pid')),
    readPid(join(animaHome, 'run', 'web.pid')),
  ]);
  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(web !== undefined ? { web } : {}),
  };
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const parsed = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function assertPidMoved(name: keyof ServicePids, previous: number | undefined, next: number | undefined): void {
  if (previous === undefined) return;
  if (next === undefined) throw new Error(`${name} pid missing after restart`);
  if (next === previous) throw new Error(`${name} pid did not change (${next})`);
}

async function fetchServerInfo(dashboardHost?: string, dashboardPort?: number): Promise<ServerInfo> {
  const res = await fetch(serverInfoUrl(dashboardHost, dashboardPort));
  if (!res.ok) throw new Error(`/api/server-info returned ${res.status}`);
  return (await res.json()) as ServerInfo;
}

function serverInfoUrl(dashboardHost?: string, dashboardPort?: number): string {
  return `http://${dashboardRequestHost(dashboardHost)}:${dashboardPort ?? DEFAULT_DASHBOARD_PORT}/api/server-info`;
}

function healthUrl(dashboardHost?: string, dashboardPort?: number): string {
  return `http://${dashboardRequestHost(dashboardHost)}:${dashboardPort ?? DEFAULT_DASHBOARD_PORT}/api/health`;
}

function dashboardRequestHost(dashboardHost?: string): string {
  return !dashboardHost || dashboardHost === '0.0.0.0' ? DEFAULT_DASHBOARD_HOST : dashboardHost;
}

async function appendUpgradeLog(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const log = await open(path, 'a');
  try {
    await log.write(`[${new Date().toISOString()}] ${text}\n`);
  } finally {
    await log.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
