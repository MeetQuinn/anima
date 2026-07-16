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
  providerModels?: (command: string) => Promise<GrokModelCatalog>;
  packageVersion?: () => Promise<string>;
  projectRoot?: string;
  restartDelayMs?: number;
  settings?: ServerSettingsService;
  startedAt?: string;
}

export interface GrokModelCatalog {
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
  private readonly providerModels: (command: string) => Promise<GrokModelCatalog>;
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
    this.providerModels = options.providerModels ?? grokProviderModels;
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
              ...(await this.providerModels(entry.command)),
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

export function parseGrokModelsOutput(output: string): GrokModelCatalog {
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
export function parseGrokAcpModelState(modelState: unknown): GrokModelCatalog | undefined {
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

async function grokProviderModels(command: string): Promise<GrokModelCatalog> {
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
async function grokAcpModelCatalog(command: string): Promise<GrokModelCatalog | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ['--no-auto-update', 'agent', '--no-leader', '--always-approve', 'stdio'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, value?: GrokModelCatalog) => {
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
  const child = spawn(
    process.execPath,
    [input.animactlScript, 'services', 'restart', '--drain-active', '--resume-running'],
    {
      cwd: input.projectRoot,
      detached: true,
      env: {
        ...cleanServiceEnv(),
        ANIMA_HOME: input.animaHome,
        ANIMA_RESTART_RESULT_FILE: input.resultPath,
      },
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
