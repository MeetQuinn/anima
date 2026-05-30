import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveAnimaHome } from '../anima-home.js';
import { defaultServerSettingsService, type ServerSettingsService } from '../settings/settings.service.js';
import { cleanServiceEnv } from './env.js';
import {
  readLastServicesRestart,
  servicesRestartLogPath,
  servicesRestartResultPath,
} from './restart-result.js';
import type { ServerInfo, ServicesRestartResponse } from '../../shared/server-info.js';
import { PROVIDER_CATALOG, type ProviderAvailability } from '../../shared/provider-catalog.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RESTART_AFTER_RESPONSE_DELAY_MS = 250;

export interface PreparedServicesRestart {
  response: ServicesRestartResponse;
  spawn: () => Promise<void>;
}

export interface SystemServiceOptions {
  animactlScript?: string;
  commandPresent?: (command: string) => Promise<boolean>;
  commit?: Promise<string | undefined> | string;
  now?: () => Date;
  packageVersion?: () => Promise<string>;
  projectRoot?: string;
  restartDelayMs?: number;
  settings?: ServerSettingsService;
  startedAt?: string;
}

export class SystemServiceError extends Error {}

export class SystemService {
  private readonly animactlScript: string;
  private readonly commandPresent: (command: string) => Promise<boolean>;
  private readonly commit: Promise<string | undefined>;
  private readonly now: () => Date;
  private readonly packageVersion: () => Promise<string>;
  private readonly projectRoot: string;
  private readonly restartDelayMs: number;
  private readonly settings: ServerSettingsService;
  private readonly startedAt: string;

  constructor(options: SystemServiceOptions = {}) {
    this.projectRoot = options.projectRoot ?? PROJECT_ROOT;
    this.animactlScript = options.animactlScript ?? join(this.projectRoot, 'dist/server/cli/animactl.js');
    this.commandPresent = options.commandPresent ?? commandPresent;
    this.commit = Promise.resolve(options.commit ?? gitShortCommit(this.projectRoot));
    this.now = options.now ?? (() => new Date());
    this.packageVersion = options.packageVersion ?? (() => packageVersion(this.projectRoot));
    this.restartDelayMs = options.restartDelayMs ?? RESTART_AFTER_RESPONSE_DELAY_MS;
    this.settings = options.settings ?? defaultServerSettingsService;
    this.startedAt = options.startedAt ?? this.now().toISOString();
  }

  async providerAvailability(): Promise<{ providers: ProviderAvailability[] }> {
    return {
      providers: await Promise.all(PROVIDER_CATALOG.map(async (entry) => ({
        kind: entry.kind,
        present: await this.commandPresent(entry.command),
      }))),
    };
  }

  async serverInfo(): Promise<ServerInfo> {
    const animaHome = resolveAnimaHome();
    const [config, version, commit, lastRestart] = await Promise.all([
      this.settings.readConfig(),
      this.packageVersion(),
      this.commit,
      readLastServicesRestart(animaHome),
    ]);
    return {
      animaHome,
      ...(commit ? { commit } : {}),
      dashboardPort: config.dashboardPort ?? 4174,
      env: environmentName(this.projectRoot, animaHome),
      ...(lastRestart ? { lastRestart } : {}),
      ok: true as const,
      startedAt: this.startedAt,
      uptimeSeconds: Math.max(0, Math.floor((this.now().getTime() - Date.parse(this.startedAt)) / 1000)),
      version,
    };
  }

  serverStartedAt(): string {
    return this.startedAt;
  }

  prepareServicesRestart(): PreparedServicesRestart {
    if (!existsSync(this.animactlScript)) {
      throw new SystemServiceError(`animactl not found: ${this.animactlScript}`);
    }
    const animaHome = resolveAnimaHome();
    const logPath = servicesRestartLogPath(animaHome);
    const resultPath = servicesRestartResultPath(animaHome);
    return {
      response: {
        ok: true,
        animaHome,
        delayMs: this.restartDelayMs,
        logPath,
        scheduled: true,
      },
      spawn: () => restartServicesDetached({
        animaHome,
        animactlScript: this.animactlScript,
        logPath,
        now: this.now,
        projectRoot: this.projectRoot,
        resultPath,
      }),
    };
  }
}

export const defaultSystemService = new SystemService();

async function restartServicesDetached(input: {
  animaHome: string;
  animactlScript: string;
  logPath: string;
  now: () => Date;
  projectRoot: string;
  resultPath: string;
}): Promise<void> {
  let log: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(input.logPath), { recursive: true });
    await rm(input.resultPath, { force: true });
    log = await open(input.logPath, 'a');
    await log.write(`\n[${input.now().toISOString()}] web app requested services restart\n`);
  } catch (error) {
    console.error(`Failed to open restart log ${input.logPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const child = spawn(
    process.execPath,
    [input.animactlScript, 'services', 'restart', '--drain-active', '--resume-running'],
    {
      cwd: input.projectRoot,
      detached: true,
      env: { ...cleanServiceEnv(), ANIMA_HOME: input.animaHome, ANIMA_RESTART_RESULT_FILE: input.resultPath },
      stdio: log ? ['ignore', log.fd, log.fd] : 'ignore',
    },
  );
  child.on('error', (error) => {
    console.error(`Failed to start services restart: ${error.message}`);
  });
  child.unref();
  await log?.close();
}

async function packageVersion(projectRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function gitShortCommit(projectRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function environmentName(projectRoot: string, animaHome: string): 'dev' | 'dogfood' | 'custom' {
  if (resolve(animaHome) === resolve(projectRoot, '.anima')) return 'dev';
  if (resolve(animaHome) === resolve(homedir(), '.anima')) return 'dogfood';
  return 'custom';
}

function commandPresent(command: string): Promise<boolean> {
  return new Promise((resolvePresent) => {
    const child = execFile(command, ['--version'], { encoding: 'utf8', timeout: 2_000 }, (error) => {
      resolvePresent(!error);
    });
    child.stdin?.end();
  });
}
