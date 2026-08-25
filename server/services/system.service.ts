import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveAnimaHome } from '../anima-home.js';
import { defaultServerSettingsService, type ServerSettingsService } from '../settings/settings.service.js';
import { cleanServiceEnv } from './env.js';
import { readLastServicesRestart, servicesRestartLogPath, servicesRestartResultPath } from './restart-result.js';
import type { ServerInfo, ServicesRestartResponse } from '../../shared/server-info.js';
import {
  PROVIDER_CATALOG,
  type ProviderAvailability,
  type ProviderKind,
} from '../../shared/provider-catalog.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RESTART_AFTER_RESPONSE_DELAY_MS = 250;

export interface PreparedServicesRestart {
  response: ServicesRestartResponse;
  spawn: () => Promise<void>;
}

export interface SystemServiceOptions {
  animactlScript?: string;
  commandPresent?: (command: string, args: string[]) => Promise<boolean>;
  commit?: Promise<string | undefined> | string;
  now?: () => Date;
  providerModels?: (command: string, kind: ProviderKind) => Promise<ProviderModelCatalog>;
  packageVersion?: () => Promise<string>;
  projectRoot?: string;
  restartDelayMs?: number;
  settings?: ServerSettingsService;
  startedAt?: string;
}

export interface ProviderModelCatalog {
  defaultModel: string;
  modelReasoningEfforts?: Record<string, string[]>;
  models: string[];
}

export class SystemServiceError extends Error {}

export class SystemService {
  private readonly animactlScript: string;
  private readonly commandPresent: (command: string, args: string[]) => Promise<boolean>;
  private readonly commit: Promise<string | undefined>;
  private readonly now: () => Date;
  private readonly providerModels: (command: string, kind: ProviderKind) => Promise<ProviderModelCatalog>;
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
    this.providerModels = options.providerModels ?? liveProviderModels;
    this.packageVersion = options.packageVersion ?? (() => packageVersion(this.projectRoot));
    this.restartDelayMs = options.restartDelayMs ?? RESTART_AFTER_RESPONSE_DELAY_MS;
    this.settings = options.settings ?? defaultServerSettingsService;
    this.startedAt = options.startedAt ?? this.now().toISOString();
  }

  async providerAvailability(): Promise<{ providers: ProviderAvailability[] }> {
    return {
      providers: await Promise.all(
        PROVIDER_CATALOG.map(async (entry) => {
          const present = await this.commandPresent(entry.command, providerPresenceArgs(entry.kind));
          if (!present || !entry.dynamicModels)
            return {
              kind: entry.kind,
              present,
            };
          const checkedAt = this.now().toISOString();
          try {
            return {
              checkedAt,
              kind: entry.kind,
              present,
              ...(await this.providerModels(entry.command, entry.kind)),
            };
          } catch (error) {
            return {
              checkedAt,
              kind: entry.kind,
              modelCheckError: error instanceof Error ? error.message : String(error),
              present,
            };
          }
        }),
      ),
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
    const track = config.track ?? config.releaseTrack ?? 'stable';
    return {
      animaHome,
      ...(commit ? { commit } : {}),
      dashboardPort: config.dashboardPort ?? 4174,
      docsUrl: docsUrl(track),
      ...(lastRestart ? { lastRestart } : {}),
      ok: true as const,
      startedAt: this.startedAt,
      track,
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
      spawn: () =>
        restartServicesDetached({
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

export function parseGrokModelsOutput(output: string): ProviderModelCatalog {
  const defaultModel = output.match(/^Default model:\s*(\S+)\s*$/m)?.[1];
  const models = [...output.matchAll(/^\s*[*-]\s+([A-Za-z0-9._/-]+)(?:\s+\(default\))?\s*$/gm)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  const uniqueModels = [...new Set(models)];
  if (!defaultModel || !uniqueModels.includes(defaultModel)) {
    throw new Error('Grok model catalog did not report a valid default model');
  }
  // The text `models` catalog cannot report per-model effort support, and it must
  // not be synthesized from model names. Effort capability comes only from the ACP
  // modelState (parseGrokAcpModelState); omit it here rather than guess.
  return {
    defaultModel,
    models: uniqueModels,
  };
}

/**
 * Parse ACP initialize/session modelState into model ids + per-model effort menus.
 * Live Grok Build exposes `supportsReasoningEffort` and `reasoningEfforts` here;
 * models without that flag (e.g. composer) get an empty effort list.
 */
export function parseGrokAcpModelState(modelState: unknown): ProviderModelCatalog | undefined {
  if (!modelState || typeof modelState !== 'object') return undefined;
  const record = modelState as Record<string, unknown>;
  const currentModelId =
    typeof record['currentModelId'] === 'string' ? record['currentModelId'].trim() : '';
  const available = Array.isArray(record['availableModels']) ? record['availableModels'] : [];
  const models: string[] = [];
  const modelReasoningEfforts: Record<string, string[]> = {};
  for (const entry of available) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;
    const modelId = typeof model['modelId'] === 'string' ? model['modelId'].trim() : '';
    if (!modelId) continue;
    models.push(modelId);
    const meta =
      model['_meta'] && typeof model['_meta'] === 'object'
        ? (model['_meta'] as Record<string, unknown>)
        : undefined;
    const supports = meta?.['supportsReasoningEffort'] === true;
    const effortsRaw = Array.isArray(meta?.['reasoningEfforts']) ? meta['reasoningEfforts'] : [];
    const efforts: string[] = [];
    if (supports) {
      for (const item of effortsRaw) {
        if (!item || typeof item !== 'object') continue;
        const value =
          typeof (item as Record<string, unknown>)['value'] === 'string'
            ? String((item as Record<string, unknown>)['value']).trim()
            : typeof (item as Record<string, unknown>)['id'] === 'string'
              ? String((item as Record<string, unknown>)['id']).trim()
              : '';
        if (value && !efforts.includes(value)) efforts.push(value);
      }
      // Menu present but empty → built-in low/medium/high (no xhigh), matching Grok CLI.
      if (efforts.length === 0) efforts.push('low', 'medium', 'high');
    }
    modelReasoningEfforts[modelId] = efforts;
  }
  const uniqueModels = [...new Set(models)];
  const defaultModel =
    currentModelId && uniqueModels.includes(currentModelId) ? currentModelId : uniqueModels[0];
  if (!defaultModel || uniqueModels.length === 0) return undefined;
  return { defaultModel, modelReasoningEfforts, models: uniqueModels };
}

/** Live model catalog per provider kind; only `dynamicModels` catalog entries reach here. */
async function liveProviderModels(command: string, kind: ProviderKind): Promise<ProviderModelCatalog> {
  if (kind === 'pi') return piProviderModels(command);
  return grokProviderModels(command);
}

const PI_MODEL_PROBE_ARGS = ['--mode', 'rpc', '--no-extensions', '--no-skills', '--no-context-files', '--no-session'];
const PI_MODEL_PROBE_TIMEOUT_MS = 8_000;
export const PI_NO_CREDENTIAL_MESSAGE =
  'pi has no provider credential. Run `pi` and `/login`, add a key to `~/.pi/agent/auth.json`, or export the provider API key in the Anima service environment.';

/**
 * Short-lived pi RPC probe. `get_available_models` returns only the models the
 * machine-level credentials can reach; `get_state` carries pi's own current model,
 * which becomes the default when it is in that list.
 */
async function piProviderModels(command: string): Promise<ProviderModelCatalog> {
  const responses = await piRpcProbe(command, ['get_available_models', 'get_state']);
  return parsePiModelCatalog(responses['get_available_models'], responses['get_state']);
}

export function parsePiModelCatalog(available: unknown, state: unknown): ProviderModelCatalog {
  const entries = isPlainRecord(available) && Array.isArray(available['models']) ? available['models'] : [];
  const models: string[] = [];
  for (const entry of entries) {
    if (!isPlainRecord(entry)) continue;
    const provider = typeof entry['provider'] === 'string' ? entry['provider'].trim() : '';
    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    if (!provider || !id) continue;
    const name = `${provider}/${id}`;
    if (!models.includes(name)) models.push(name);
  }
  if (models.length === 0) throw new Error(PI_NO_CREDENTIAL_MESSAGE);
  const current = isPlainRecord(state) && isPlainRecord(state['model']) ? state['model'] : undefined;
  const currentName =
    current && typeof current['provider'] === 'string' && typeof current['id'] === 'string'
      ? `${current['provider']}/${current['id']}`
      : undefined;
  const defaultModel = currentName && models.includes(currentName) ? currentName : models[0]!;
  return { defaultModel, models };
}

function piRpcProbe(command: string, commands: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, PI_MODEL_PROBE_ARGS, {
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const results: Record<string, unknown> = {};
    const pending = new Set(commands);
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolvePromise(results);
    };
    const timer = setTimeout(() => finish(new Error('pi model catalog probe timed out')), PI_MODEL_PROBE_TIMEOUT_MS);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (pending.size === 0) return finish();
      finish(new Error(`pi model catalog probe exited (${code ?? 'signal'}) ${stderr.trim()}`.trim()));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isPlainRecord(message) || message['type'] !== 'response') continue;
        const name = typeof message['command'] === 'string' ? message['command'] : undefined;
        if (!name || !pending.has(name)) continue;
        if (message['success'] === false) {
          finish(new Error(`pi ${name} failed: ${String(message['error'] ?? 'unknown error')}`));
          return;
        }
        results[name] = message['data'];
        pending.delete(name);
        if (pending.size === 0) finish();
      }
    });
    for (const [index, name] of commands.entries()) {
      child.stdin?.write(`${JSON.stringify({ id: `probe-${index}`, type: name })}\n`);
    }
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function grokProviderModels(command: string): Promise<ProviderModelCatalog> {
  try {
    const fromAcp = await grokAcpModelCatalog(command);
    if (fromAcp) return fromAcp;
  } catch {
    // Fall through to CLI text catalog.
  }
  const { stdout, stderr } = await execFileAsync(command, ['--no-auto-update', 'models'], {
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  return parseGrokModelsOutput(`${stdout}\n${stderr}`);
}

/** Short-lived ACP initialize probe for per-model effort metadata. */
async function grokAcpModelCatalog(command: string): Promise<ProviderModelCatalog | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ['--no-auto-update', 'agent', '--no-leader', '--always-approve', 'stdio'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, value?: ProviderModelCatalog) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Grok ACP model catalog probe timed out')), 8_000);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        // Answer agent→client requests so the process does not stall.
        if (
          message['id'] !== undefined &&
          typeof message['method'] === 'string' &&
          !('result' in message) &&
          !('error' in message)
        ) {
          const id = message['id'];
          if (message['method'] === 'session/request_permission') {
            child.stdin?.write(
              `${JSON.stringify({
                id,
                jsonrpc: '2.0',
                result: { outcome: { optionId: 'approve_for_session', outcome: 'selected' } },
              })}\n`,
            );
          } else {
            child.stdin?.write(
              `${JSON.stringify({
                error: { code: -32601, message: `method not found: ${String(message['method'])}` },
                id,
                jsonrpc: '2.0',
              })}\n`,
            );
          }
          continue;
        }
        if (message['id'] !== 1 || !('result' in message)) continue;
        const result = message['result'];
        if (!result || typeof result !== 'object') {
          finish(new Error('Grok ACP initialize returned no result'));
          return;
        }
        const meta =
          (result as Record<string, unknown>)['_meta'] &&
          typeof (result as Record<string, unknown>)['_meta'] === 'object'
            ? ((result as Record<string, unknown>)['_meta'] as Record<string, unknown>)
            : undefined;
        const modelState = meta?.['modelState'] ?? (result as Record<string, unknown>)['models'];
        const catalog = parseGrokAcpModelState(modelState);
        if (!catalog) {
          finish(new Error('Grok ACP initialize did not include a model catalog'));
          return;
        }
        finish(undefined, catalog);
      }
    });
    child.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`Grok ACP model catalog probe exited (${code ?? 'null'})`));
    });

    child.stdin?.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          clientCapabilities: {},
          clientInfo: { name: 'anima', version: '0.1.0' },
          protocolVersion: 1,
        },
      })}\n`,
    );
  });
}

export interface ServicesRestartDetachedSpawnPlan {
  args: string[];
  command: string;
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
  stdio: 'ignore' | 'log';
  waitForExit: boolean;
}

export interface ServicesRestartDetachedSpawnPlanInput {
  animaHome: string;
  animactlScript: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  nodePath?: string;
  nowMs?: number;
  platform?: NodeJS.Platform;
  projectRoot: string;
  resultPath: string;
}

/**
 * Build the spawn plan for a web-requested services restart.
 *
 * On Linux systemd hosts a plain detached child stays in the web unit's
 * cgroup, so `systemctl --user stop` of the web unit SIGKILLs the restarter
 * mid-restart (#693). Prefer a transient `systemd-run --user` unit — same
 * shape as runtime-upgrade workers. Darwin/other keep detached node.
 *
 * Linux hosts without a reachable user systemd (pid-file mode, no linger,
 * containers) fall back to the detached-node plan when systemd-run fails —
 * that fallback is only unsafe where systemd-run would have succeeded.
 */
export function servicesRestartDetachedSpawnPlan(
  input: ServicesRestartDetachedSpawnPlanInput,
): ServicesRestartDetachedSpawnPlan {
  if ((input.platform ?? process.platform) === 'linux') {
    return servicesRestartDetachedSystemdRunPlan(input);
  }
  return servicesRestartDetachedNodePlan(input);
}

/** Detached node spawn used on non-Linux and as Linux systemd-run fallback. */
export function servicesRestartDetachedNodePlan(
  input: ServicesRestartDetachedSpawnPlanInput,
): ServicesRestartDetachedSpawnPlan {
  const nodePath = input.nodePath ?? process.execPath;
  return {
    args: [
      input.animactlScript,
      'services',
      'restart',
      '--drain-active',
      '--resume-running',
    ],
    command: nodePath,
    cwd: input.projectRoot,
    detached: true,
    env: servicesRestartDetachedEnv(input),
    stdio: 'log',
    waitForExit: false,
  };
}

export function servicesRestartDetachedSystemdRunPlan(
  input: ServicesRestartDetachedSpawnPlanInput,
): ServicesRestartDetachedSpawnPlan {
  const nodePath = input.nodePath ?? process.execPath;
  const env = servicesRestartDetachedEnv(input);
  return {
    args: [
      '--user',
      '--quiet',
      '--collect',
      `--unit=${servicesRestartDetachedUnitName(input)}`,
      `--property=WorkingDirectory=${input.projectRoot}`,
      `--property=StandardOutput=append:${input.logPath}`,
      `--property=StandardError=append:${input.logPath}`,
      ...Object.entries(env)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => `--setenv=${key}=${value}`),
      nodePath,
      input.animactlScript,
      'services',
      'restart',
      '--drain-active',
      '--resume-running',
    ],
    command: 'systemd-run',
    cwd: input.projectRoot,
    detached: true,
    env,
    stdio: 'ignore',
    waitForExit: true,
  };
}

/** When systemd-run cannot launch, fall back to detached node (Linux only). */
export function servicesRestartDetachedFallbackPlan(
  failedPlan: ServicesRestartDetachedSpawnPlan,
  input: ServicesRestartDetachedSpawnPlanInput,
): ServicesRestartDetachedSpawnPlan | undefined {
  if (failedPlan.command !== 'systemd-run') return undefined;
  return servicesRestartDetachedNodePlan(input);
}

function servicesRestartDetachedEnv(
  input: ServicesRestartDetachedSpawnPlanInput,
): NodeJS.ProcessEnv {
  return {
    ...cleanServiceEnv(input.env),
    ANIMA_HOME: input.animaHome,
    ANIMA_RESTART_RESULT_FILE: input.resultPath,
  };
}

function servicesRestartDetachedUnitName(
  input: Pick<ServicesRestartDetachedSpawnPlanInput, 'nowMs'>,
): string {
  return `anima-services-restart-${process.pid}-${input.nowMs ?? Date.now()}`;
}

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
    console.error(
      `Failed to open restart log ${input.logPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const planInput: ServicesRestartDetachedSpawnPlanInput = {
    animaHome: input.animaHome,
    animactlScript: input.animactlScript,
    logPath: input.logPath,
    nodePath: process.execPath,
    nowMs: input.now().getTime(),
    projectRoot: input.projectRoot,
    resultPath: input.resultPath,
  };
  const primary = servicesRestartDetachedSpawnPlan(planInput);
  try {
    await spawnServicesRestartPlan(primary, log);
  } catch (error) {
    const fallback = servicesRestartDetachedFallbackPlan(primary, planInput);
    if (!fallback) {
      console.error(
        `Failed to start services restart: ${error instanceof Error ? error.message : String(error)}`,
      );
      await log?.close();
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    const line = `systemd-run unavailable (${reason}); falling back to detached node spawn\n`;
    console.error(line.trim());
    try {
      await log?.write(line);
    } catch {
      /* ignore log write failures */
    }
    try {
      await spawnServicesRestartPlan(fallback, log);
    } catch (fallbackError) {
      console.error(
        `Failed to start services restart fallback: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`,
      );
    }
  } finally {
    await log?.close();
  }
}

async function spawnServicesRestartPlan(
  plan: ServicesRestartDetachedSpawnPlan,
  log: Awaited<ReturnType<typeof open>> | undefined,
): Promise<void> {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    detached: plan.detached,
    env: plan.env,
    stdio: plan.stdio === 'log' && log ? ['ignore', log.fd, log.fd] : 'ignore',
  });
  await waitForServicesRestartLaunch(plan, child);
  child.unref();
}

async function waitForServicesRestartLaunch(
  plan: ServicesRestartDetachedSpawnPlan,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('error', rejectSpawn);
    child.once('spawn', resolveSpawn);
  });
  if (!plan.waitForExit) return;
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  // systemd-run --collect exits once the transient unit is queued; non-zero means
  // the restarter never escaped the web cgroup (or systemd-run is unavailable).
  if (result.signal) throw new Error(`${plan.command} exited from signal ${result.signal}`);
  if (result.code !== 0) {
    throw new Error(`${plan.command} exited with code ${result.code ?? 'unknown'}`);
  }
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

export function docsUrl(track: 'dev' | 'canary' | 'stable'): string {
  const configured = process.env.ANIMA_DOCS_URL?.trim();
  if (configured) return configured;
  if (track === 'dev') return 'http://127.0.0.1:14175/';
  return 'https://anima.meetquinn.ai/';
}

function providerPresenceArgs(kind: (typeof PROVIDER_CATALOG)[number]['kind']): string[] {
  return kind === 'grok-cli' ? ['--no-auto-update', '--version'] : ['--version'];
}

function commandPresent(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolvePresent) => {
    const child = execFile(command, args, { encoding: 'utf8', timeout: 2_000 }, (error) => {
      resolvePresent(!error);
    });
    child.stdin?.end();
  });
}
