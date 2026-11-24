import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveAnimaHome } from '../anima-home.js';
import { ignoreChildStdinErrors } from '../providers/child-process.js';
import { antigravityCommandProblem } from '../providers/antigravity.js';
import { launchCandidatesFingerprint, runtimeLaunchPath } from '../runtime/launch-path.js';
import { raceWithTimeout } from '../race-timeout.js';
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
          if (!present || !(entry.dynamicModels || entry.liveModels))
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

/** Live model catalog per provider kind; only `dynamicModels` and `liveModels` catalog entries reach here. */
async function liveProviderModels(command: string, kind: ProviderKind): Promise<ProviderModelCatalog> {
  if (kind === 'codex-cli') return codexAppServerModelCatalog(command);
  if (kind === 'pi') return piProviderModels(command);
  if (kind === 'antigravity-cli') return antigravityProviderModels(command);
  return grokProviderModels(command, runtimeProbeEnv());
}

/**
 * The env a catalog probe runs with: the runtime PATH of an agent that sets none, so
 * the command is looked up, shims included, the way such an agent's turn looks it up.
 */
function runtimeProbeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: runtimeLaunchPath() };
}

const ANTIGRAVITY_MODEL_PROBE_TIMEOUT_MS = 15_000;
const ANTIGRAVITY_MODEL_CATALOG_TTL_MS = 15 * 60_000;
const antigravityCatalogCache = new Map<
  string,
  { at: number; fingerprint: string; value: Promise<ProviderModelCatalog> }
>();

function antigravityProbeCwd(): string {
  return join(resolveAnimaHome(), 'cache', 'antigravity-model-probe');
}

/**
 * Antigravity reports its models only on a session, and every session/new
 * leaves a conversation in Antigravity's history. Cache the catalog per command
 * for as long as the files it could start stay as they were when the probe
 * began, so relinking or reinstalling `agy` probes again; probe from one fixed
 * directory. Failures are not kept.
 */
async function antigravityProviderModels(command: string): Promise<ProviderModelCatalog> {
  const env = runtimeProbeEnv();
  const fingerprint = await launchCandidatesFingerprint(command, env.PATH ?? '', antigravityProbeCwd());
  const cached = antigravityCatalogCache.get(command);
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < ANTIGRAVITY_MODEL_CATALOG_TTL_MS) {
    return cached.value;
  }
  const value = antigravityAcpModelCatalog(command, { env });
  antigravityCatalogCache.set(command, { at: Date.now(), fingerprint, value });
  value.catch(() => {
    if (antigravityCatalogCache.get(command)?.value === value) antigravityCatalogCache.delete(command);
  });
  return value;
}

function antigravityConfigSelect(configOptions: unknown, category: string): Record<string, unknown> | undefined {
  const options = Array.isArray(configOptions) ? configOptions.filter(isPlainRecord) : [];
  return options.find((option) => option['category'] === category) ?? options.find((option) => option['id'] === category);
}

function antigravitySelectValues(option: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const push = (entry: unknown) => {
    if (!isPlainRecord(entry) || typeof entry['value'] !== 'string') return;
    const value = entry['value'].trim();
    if (value && !out.includes(value)) out.push(value);
  };
  for (const entry of Array.isArray(option?.['options']) ? option['options'] : []) {
    if (isPlainRecord(entry) && Array.isArray(entry['options'])) entry['options'].forEach(push);
    else push(entry);
  }
  return out;
}

function antigravitySelectCurrent(option: Record<string, unknown> | undefined): string {
  return typeof option?.['currentValue'] === 'string' ? option['currentValue'].trim() : '';
}

/**
 * Parse an Antigravity session's ACP `configOptions` into the model catalog.
 * Models come from the `model` select. Thinking levels are model-scoped: the
 * `thought_level` select is the session's current model's, so it gives that
 * model's menu only, empty when the model has none.
 */
export function parseAntigravityConfigOptions(configOptions: unknown): ProviderModelCatalog {
  const modelOption = antigravityConfigSelect(configOptions, 'model');
  const models = antigravitySelectValues(modelOption);
  if (models.length === 0) throw new Error('Antigravity did not report any models for the signed-in account');
  const current = antigravitySelectCurrent(modelOption);
  const known = current !== '' && models.includes(current);
  return {
    defaultModel: known ? current : models[0]!,
    ...(known
      ? { modelReasoningEfforts: { [current]: antigravitySelectValues(antigravityConfigSelect(configOptions, 'thought_level')) } }
      : {}),
    models,
  };
}

const ANTIGRAVITY_SWITCH_TIMED_OUT = Symbol('timed out');

/**
 * Adds each other model's thinking levels to `catalog`. `agy` reports levels
 * only for the session's current model, so the probe switches its own session
 * to each model and reads the levels that come back; the account's default
 * model stays as it was. A model whose switch fails, or that the switches do
 * not reach by `deadline`, keeps no menu: saves fall back to the write
 * vocabulary, and the live session gates the level at run time. `onLevels`
 * gets the catalog each time a model's menu is added.
 */
async function withAntigravityModelThoughtLevels(
  catalog: ProviderModelCatalog,
  session: Record<string, unknown>,
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  deadline: number,
  onLevels: (catalog: ProviderModelCatalog) => void,
): Promise<ProviderModelCatalog> {
  const sessionId = session['sessionId'];
  const configId = antigravityConfigSelect(session['configOptions'], 'model')?.['id'];
  if (typeof sessionId !== 'string' || typeof configId !== 'string') return catalog;
  let confirmed = catalog;
  for (const model of catalog.models) {
    if (confirmed.modelReasoningEfforts && Object.hasOwn(confirmed.modelReasoningEfforts, model)) continue;
    const left = deadline - Date.now();
    if (left <= 0) break;
    const result = await raceWithTimeout(
      request('session/set_config_option', { configId, sessionId, value: model }).catch(() => undefined),
      left,
      ANTIGRAVITY_SWITCH_TIMED_OUT,
    );
    if (result === ANTIGRAVITY_SWITCH_TIMED_OUT) break;
    // The levels are the model's only when the session now has that model.
    if (!result || antigravitySelectCurrent(antigravityConfigSelect(result['configOptions'], 'model')) !== model) continue;
    const levels = antigravitySelectValues(antigravityConfigSelect(result['configOptions'], 'thought_level'));
    confirmed = { ...confirmed, modelReasoningEfforts: { ...confirmed.modelReasoningEfforts, [model]: levels } };
    onLevels(confirmed);
  }
  return confirmed;
}

/** Probe one `agy acp` session for its model options. Exported for tests; callers use the cached wrapper. */
export async function antigravityAcpModelCatalog(
  command: string,
  options: { env?: NodeJS.ProcessEnv; killGraceMs?: number; timeoutMs?: number } = {},
): Promise<ProviderModelCatalog> {
  const env = options.env ?? process.env;
  // Same refusal as the runtime: the app's editor launcher would open a window.
  const problem = antigravityCommandProblem(command, env);
  if (problem) throw new Error(problem);
  const cwd = antigravityProbeCwd();
  await mkdir(cwd, { recursive: true });
  const timeoutMs = options.timeoutMs ?? ANTIGRAVITY_MODEL_PROBE_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    // Model switches stop here, leaving time to close the session within the timeout.
    const switchDeadline = Date.now() + Math.floor((timeoutMs * 2) / 3);
    ignoreChildStdinErrors(child);
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    let nextId = 0;
    let buffer = '';
    let settled = false;
    // The catalog once session/new has given one, with each model's menu as it is confirmed.
    // The per-model switches only add to it, so a probe that ends during them returns it.
    let confirmed: ProviderModelCatalog | undefined;
    const finish = (error?: Error, value?: ProviderModelCatalog) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) {
        child.kill('SIGTERM');
        // A child that ignores SIGTERM must not outlive the probe.
        const escalate = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, options.killGraceMs ?? 2_000);
        escalate.unref();
        child.once('exit', () => clearTimeout(escalate));
      }
      if (error && !confirmed) reject(error);
      else resolvePromise(confirmed ?? value!);
    };
    const timer = setTimeout(() => finish(new Error('Antigravity ACP model catalog probe timed out')), timeoutMs);
    const write = (message: Record<string, unknown>) =>
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const request = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
        if (exited) {
          rejectRequest(new Error(`Antigravity ACP ${method} failed: the probe exited`));
          return;
        }
        const id = ++nextId;
        pending.set(id, (message) => {
          const error = isPlainRecord(message['error']) ? message['error'] : undefined;
          if (error) {
            const text = typeof error['message'] === 'string' ? error['message'] : 'request failed';
            rejectRequest(
              error['code'] === -32000 || /authentication required/i.test(text)
                ? new Error('Antigravity CLI is not signed in on this machine. Run `agy` in a terminal once and sign in.')
                : new Error(`Antigravity ACP ${method} failed: ${text}`),
            );
            return;
          }
          resolveRequest(isPlainRecord(message['result']) ? message['result'] : {});
        });
        write({ id, method, params });
      });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isPlainRecord(parsed)) continue;
        const message = parsed;
        if (typeof message['method'] === 'string') {
          // No tools run in this probe; refuse any agent→client request.
          if (message['id'] !== undefined) {
            write({ error: { code: -32601, message: 'not supported' }, id: message['id'] });
          }
          continue;
        }
        const handler = typeof message['id'] === 'number' ? pending.get(message['id']) : undefined;
        if (!handler) continue;
        pending.delete(message['id'] as number);
        handler(message);
      }
    });
    child.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`Antigravity ACP model catalog probe exited (${code ?? 'null'})`));
      // Fail what is still waiting so the probe's own steps end now.
      const waiting = [...pending.values()];
      pending.clear();
      for (const handler of waiting) handler({ error: { message: 'the probe exited' } });
    });

    void (async () => {
      const init = await request('initialize', {
        clientCapabilities: {},
        clientInfo: { name: 'anima', version: '0.1.0' },
        protocolVersion: 1,
      });
      const session = await request('session/new', { cwd, mcpServers: [] });
      confirmed = parseAntigravityConfigOptions(session['configOptions']);
      const catalog = await withAntigravityModelThoughtLevels(confirmed, session, request, switchDeadline, (next) => {
        confirmed = next;
      });
      const capabilities = isPlainRecord(init['agentCapabilities']) ? init['agentCapabilities'] : undefined;
      const sessionCapabilities = isPlainRecord(capabilities?.['sessionCapabilities'])
        ? capabilities['sessionCapabilities']
        : undefined;
      if (typeof session['sessionId'] === 'string' && sessionCapabilities?.['close'] !== undefined) {
        await raceWithTimeout(
          request('session/close', { sessionId: session['sessionId'] }).catch(() => undefined),
          2_000,
          undefined,
        );
      }
      finish(undefined, catalog);
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

const CODEX_MODEL_PROBE_TIMEOUT_MS = 10_000;
const CODEX_MODEL_LIST_MAX_PAGES = 20;

/**
 * Codex's live model list. `codex app-server` answers `model/list` without starting a
 * thread, so the probe leaves nothing behind. It runs in a fixed empty directory, so
 * no project's Codex config applies, on the runtime PATH as the agy and Grok probes
 * do. Exported for tests.
 */
export async function codexAppServerModelCatalog(
  command: string,
  options: { killGraceMs?: number; timeoutMs?: number } = {},
): Promise<ProviderModelCatalog> {
  const cwd = join(resolveAnimaHome(), 'cache', 'codex-model-probe');
  await mkdir(cwd, { recursive: true });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: runtimeProbeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    ignoreChildStdinErrors(child);
    let exited = false;
    const pending = new Map<number, { reject(error: Error): void; resolve(result: Record<string, unknown>): void }>();
    let nextId = 0;
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, value?: ProviderModelCatalog) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) {
        child.kill('SIGTERM');
        const escalate = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, options.killGraceMs ?? 2_000);
        escalate.unref();
        child.once('exit', () => clearTimeout(escalate));
      }
      if (error) reject(error);
      else resolvePromise(value!);
    };
    const timer = setTimeout(
      () => finish(new Error('Codex model catalog probe timed out')),
      options.timeoutMs ?? CODEX_MODEL_PROBE_TIMEOUT_MS,
    );
    const write = (message: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    const request = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
        if (exited) {
          rejectRequest(new Error(`Codex ${method} failed: app-server exited`));
          return;
        }
        const id = ++nextId;
        pending.set(id, { reject: rejectRequest, resolve: resolveRequest });
        write({ id, method, params });
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
        if (!isPlainRecord(message)) continue;
        if (typeof message['method'] === 'string') {
          // Nothing runs in this probe; refuse any server→client request.
          if (message['id'] !== undefined) write({ error: { code: -32601, message: 'not supported' }, id: message['id'] });
          continue;
        }
        const waiter = typeof message['id'] === 'number' ? pending.get(message['id']) : undefined;
        if (!waiter) continue;
        pending.delete(message['id'] as number);
        const error = isPlainRecord(message['error']) ? message['error'] : undefined;
        if (error) {
          waiter.reject(new Error(`Codex request failed: ${typeof error['message'] === 'string' ? error['message'] : 'unknown error'}`));
        } else {
          waiter.resolve(isPlainRecord(message['result']) ? message['result'] : {});
        }
      }
    });
    child.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.on('exit', (code) => {
      exited = true;
      const error = new Error(`Codex model catalog probe exited (${code ?? 'signal'})`);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      finish(error);
    });

    void (async () => {
      await request('initialize', {
        capabilities: { experimentalApi: true },
        clientInfo: { name: 'anima', title: 'Anima', version: '0.1.0' },
      });
      write({ method: 'initialized' });
      const pages: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await request('model/list', cursor ? { cursor } : {});
        pages.push(page);
        cursor = typeof page['nextCursor'] === 'string' && page['nextCursor'] ? page['nextCursor'] : undefined;
      } while (cursor && pages.length < CODEX_MODEL_LIST_MAX_PAGES);
      finish(undefined, parseCodexModelList(pages));
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/**
 * `model/list` pages → catalog. Hidden models stay out of the menu. Each model's
 * effort menu is its `supportedReasoningEfforts`; the default is the one Codex marks
 * `isDefault`, else the first. The web keeps Anima's own default when the live list
 * has it.
 */
export function parseCodexModelList(pages: unknown[]): ProviderModelCatalog {
  const models: string[] = [];
  const modelReasoningEfforts: Record<string, string[]> = {};
  let defaultModel = '';
  for (const page of pages) {
    const data = isPlainRecord(page) && Array.isArray(page['data']) ? page['data'] : [];
    for (const entry of data) {
      if (!isPlainRecord(entry) || entry['hidden'] === true) continue;
      const slug = [entry['model'], entry['id']].find((value) => typeof value === 'string' && value.trim());
      const model = typeof slug === 'string' ? slug.trim() : '';
      if (!model || models.includes(model)) continue;
      models.push(model);
      // A model without the field keeps its static menu.
      const supported = entry['supportedReasoningEfforts'];
      if (Array.isArray(supported)) {
        const efforts: string[] = [];
        for (const item of supported) {
          const value = typeof item === 'string' ? item : isPlainRecord(item) ? item['reasoningEffort'] : undefined;
          if (typeof value === 'string' && value.trim() && !efforts.includes(value.trim())) efforts.push(value.trim());
        }
        modelReasoningEfforts[model] = efforts;
      }
      if (entry['isDefault'] === true && !defaultModel) defaultModel = model;
    }
  }
  if (models.length === 0) throw new Error('Codex did not report any models');
  return { defaultModel: defaultModel || models[0]!, modelReasoningEfforts, models };
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

/**
 * DeepSeek retired V4 Flash / Flash-Vision ids; the API still lists them but serves
 * DeepSeek-V4.1-Flash. Collapse those aliases so the Anima menu shows one Flash entry.
 * Other providers are passed through unchanged.
 */
const RETIRED_DEEPSEEK_FLASH_IDS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
]);

export function canonicalizePiModelRef(provider: string, id: string): { id: string; provider: string } {
  if (provider === 'deepseek' && RETIRED_DEEPSEEK_FLASH_IDS.has(id)) {
    return { provider, id: 'deepseek-flash' };
  }
  return { provider, id };
}

export function parsePiModelCatalog(available: unknown, state: unknown): ProviderModelCatalog {
  const entries = isPlainRecord(available) && Array.isArray(available['models']) ? available['models'] : [];
  const models: string[] = [];
  for (const entry of entries) {
    if (!isPlainRecord(entry)) continue;
    const provider = typeof entry['provider'] === 'string' ? entry['provider'].trim() : '';
    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    if (!provider || !id) continue;
    const canonical = canonicalizePiModelRef(provider, id);
    const name = `${canonical.provider}/${canonical.id}`;
    if (!models.includes(name)) models.push(name);
  }
  if (models.length === 0) throw new Error(PI_NO_CREDENTIAL_MESSAGE);
  const current = isPlainRecord(state) && isPlainRecord(state['model']) ? state['model'] : undefined;
  let currentName: string | undefined;
  if (current && typeof current['provider'] === 'string' && typeof current['id'] === 'string') {
    const canonical = canonicalizePiModelRef(current['provider'].trim(), current['id'].trim());
    currentName = `${canonical.provider}/${canonical.id}`;
  }
  const defaultModel = currentName && models.includes(currentName) ? currentName : models[0]!;
  return { defaultModel, models };
}

function piRpcProbe(command: string, commands: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, PI_MODEL_PROBE_ARGS, {
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    ignoreChildStdinErrors(child);
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

async function grokProviderModels(command: string, env: NodeJS.ProcessEnv = process.env): Promise<ProviderModelCatalog> {
  try {
    const fromAcp = await grokAcpModelCatalog(command, env);
    if (fromAcp) return fromAcp;
  } catch {
    // Fall through to CLI text catalog.
  }
  const { stdout, stderr } = await execFileAsync(command, ['--no-auto-update', 'models'], {
    env,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  return parseGrokModelsOutput(`${stdout}\n${stderr}`);
}

/** Short-lived ACP initialize probe for per-model effort metadata. */
async function grokAcpModelCatalog(command: string, env: NodeJS.ProcessEnv): Promise<ProviderModelCatalog | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ['--no-auto-update', 'agent', '--no-leader', '--always-approve', 'stdio'],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    ignoreChildStdinErrors(child);
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
          const parsed: unknown = JSON.parse(line);
          if (!isPlainRecord(parsed)) continue;
          message = parsed;
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
    ignoreChildStdinErrors(child);
    child.stdin?.end();
  });
}
