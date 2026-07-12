import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import {
  ProviderCliCheckError,
  ProviderCliUpgradeOperation,
  type ProviderCliAgentImpact,
  type ProviderCliApplyResponse,
  type ProviderCliRow,
  type ProviderCliStatusResponse,
  type ProviderCliUpgradeOperation as ProviderCliUpgradeOperationType,
} from '../../shared/provider-cli.js';
import { PROVIDER_CATALOG, type ProviderKind } from '../../shared/provider-catalog.js';
import { ProviderUsageKind } from '../../shared/provider-usage.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { resolveAnimaHome } from '../anima-home.js';
import { errorMessage } from '../ids.js';
import { defaultRuntimeService } from '../runtime/runtime.service.js';
import { JsonStore } from '../storage/json-store.js';
import { compareRuntimeVersions } from '../runtime-management/runtime-release.js';
import {
  providerCliUpgradeLocked,
  tryAcquireProviderCliUpgradeLease,
  withProviderCliInstallGate,
} from './launch-gate.js';
import { inspectProvider } from './provider-inspection.js';
import type { ProviderCliCommandRunner, ProviderInspection } from './types.js';

export type { ProviderCliCommandRunner } from './types.js';

const execFileAsync = promisify(execFile);
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_OPERATION: ProviderCliUpgradeOperationType = { status: 'idle' };

const ProviderCheck = z.object({
  checkedAt: z.string(),
  checkError: ProviderCliCheckError.optional(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  latestVersion: z.string().optional(),
});
type ProviderCheck = z.infer<typeof ProviderCheck>;

const ProviderCheckCache = z.object({
  providers: z.partialRecord(ProviderUsageKind, ProviderCheck).default({}),
});
type ProviderCheckCache = z.infer<typeof ProviderCheckCache>;

export interface ProviderCliServiceOptions {
  checkStore?: Pick<ProviderCliCheckStore, 'read' | 'write'>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  listAgentConfigs?: () => ReturnType<typeof defaultAgentRegistryService.listAgentConfigs>;
  listStatuses?: () => ReturnType<typeof defaultRuntimeService.listStatuses>;
  now?: () => Date;
  operationStore?: Pick<ProviderCliOperationStore, 'read' | 'write'>;
  runCommand?: ProviderCliCommandRunner;
}

export class ProviderCliConflictError extends Error {}
export class ProviderCliUnavailableError extends Error {}

export class ProviderCliService {
  private readonly checkStore: Pick<ProviderCliCheckStore, 'read' | 'write'>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly listAgentConfigs: () => ReturnType<typeof defaultAgentRegistryService.listAgentConfigs>;
  private readonly listStatuses: () => ReturnType<typeof defaultRuntimeService.listStatuses>;
  private readonly now: () => Date;
  private readonly operationStore: Pick<ProviderCliOperationStore, 'read' | 'write'>;
  private readonly runCommand: ProviderCliCommandRunner;
  private applying = false;

  constructor(options: ProviderCliServiceOptions = {}) {
    this.checkStore = options.checkStore ?? defaultProviderCliCheckStore;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.listAgentConfigs = options.listAgentConfigs ?? (() => defaultAgentRegistryService.listAgentConfigs());
    this.listStatuses = options.listStatuses ?? (() => defaultRuntimeService.listStatuses());
    this.now = options.now ?? (() => new Date());
    this.operationStore = options.operationStore ?? defaultProviderCliOperationStore;
    this.runCommand = options.runCommand ?? defaultProviderCliCommandRunner;
  }

  async status(): Promise<ProviderCliStatusResponse> {
    const cache = await this.refreshIfStale(await this.checkStore.read());
    return this.statusFrom(cache);
  }

  async checkNow(provider?: ProviderKind): Promise<ProviderCliStatusResponse> {
    const cache = await this.refreshChecks(await this.checkStore.read(), provider);
    return this.statusFrom(cache);
  }

  async apply(provider: ProviderKind): Promise<ProviderCliApplyResponse> {
    if (this.applying) throw new ProviderCliConflictError('A provider CLI update is already running');
    this.applying = true;
    let machineLease;
    try {
      machineLease = await tryAcquireProviderCliUpgradeLease(provider);
      if (!machineLease) throw new ProviderCliConflictError('A provider CLI update is already running on this machine');
      return await this.applyExclusive(provider);
    } finally {
      await machineLease?.release();
      this.applying = false;
    }
  }

  private async applyExclusive(provider: ProviderKind): Promise<ProviderCliApplyResponse> {
    const existingOperation = await this.reconcileOperation(await this.operationStore.read(), false);
    if (existingOperation.status === 'running') {
      throw new ProviderCliConflictError('A provider CLI update is already running');
    }

    const cache = await this.refreshChecks(await this.checkStore.read(), provider);
    const inspection = await this.inspect(provider);
    const check = cache.providers[provider];
    if (!inspection.installedVersion || !inspection.binaryPath) {
      throw new ProviderCliUnavailableError(`${inspection.label} is not installed`);
    }
    if (inspection.updateMode !== 'managed' || !inspection.updateCommand) {
      throw new ProviderCliUnavailableError(
        inspection.manualCommand
          ? `${inspection.label} must be updated manually: ${inspection.manualCommand}`
          : `${inspection.label} cannot be updated safely from this installation`,
      );
    }
    if (!check?.latestVersion) {
      throw new ProviderCliUnavailableError(
        check?.checkError?.message ?? `Latest ${inspection.label} version is unknown`,
      );
    }
    if (compareRuntimeVersions(check.latestVersion, inspection.installedVersion) <= 0) {
      throw new ProviderCliUnavailableError(`${inspection.label} is already up to date`);
    }

    const previousVersion = inspection.installedVersion;
    const targetVersion = check.latestVersion;
    const startedAt = this.now().toISOString();
    const restoreCommand = inspection.restoreCommand;
    await this.operationStore.write({
      previousVersion,
      provider,
      ...(restoreCommand ? { restoreCommand } : {}),
      startedAt,
      status: 'running',
      targetVersion,
    });

    try {
      const installedVersion = await withProviderCliInstallGate(provider, async () => {
        await this.runUpdate(inspection, targetVersion);
        const verified = await this.inspect(provider);
        if (verified.binaryPath !== inspection.binaryPath) {
          throw new Error(
            `${inspection.label} command path changed from ${inspection.binaryPath} to ${verified.binaryPath ?? 'missing'}`,
          );
        }
        const verifiedVersion = verified.installedVersion;
        const reachedTarget =
          provider === 'claude-code'
            ? compareRuntimeVersions(verifiedVersion ?? '0.0.0', targetVersion) >= 0
            : verifiedVersion === targetVersion;
        if (!verifiedVersion || !reachedTarget) {
          throw new Error(
            `${inspection.label} self-check returned ${verifiedVersion ?? 'no version'}; expected ${targetVersion}`,
          );
        }
        if (provider === 'codex-cli' && verified.realPath !== inspection.realPath) {
          throw new Error(`${inspection.label} package path changed during update`);
        }
        return verifiedVersion;
      });
      await this.operationStore.write({
        completedAt: this.now().toISOString(),
        previousVersion,
        provider,
        ...(restoreCommand ? { restoreCommand } : {}),
        startedAt,
        status: 'succeeded',
        targetVersion: installedVersion,
      });
      return {
        installedVersion,
        ok: true,
        previousVersion,
        provider,
        targetVersion: installedVersion,
      };
    } catch (error) {
      await this.operationStore.write({
        completedAt: this.now().toISOString(),
        error: errorMessage(error),
        previousVersion,
        provider,
        ...(restoreCommand ? { restoreCommand } : {}),
        startedAt,
        status: 'failed',
        targetVersion,
      });
      throw error;
    }
  }

  private async statusFrom(cache: ProviderCheckCache): Promise<ProviderCliStatusResponse> {
    const [inspections, configs, statuses, operation, upgradeLocked] = await Promise.all([
      Promise.all(PROVIDER_CATALOG.map((entry) => this.inspect(entry.kind))),
      this.listAgentConfigs(),
      this.listStatuses(),
      this.operationStore.read().then((value) => this.reconcileOperation(value)),
      providerCliUpgradeLocked(),
    ]);
    const statusByAgent = new Map(statuses.map((status) => [status.agentId, status]));
    const providers = inspections.map((inspection) => {
      const agents: ProviderCliAgentImpact[] = configs
        .filter((agent) => agent.provider.kind === inspection.provider)
        .map((agent) => {
          const child = statusByAgent.get(agent.id)?.health?.runtime?.providerChild;
          return {
            enabled: agent.enabled !== false,
            id: agent.id,
            name: agent.profile.displayName,
            ...(child?.startedAt ? { runningSince: child.startedAt } : {}),
            ...(child?.version ? { runningVersion: child.version } : {}),
          };
        });
      return providerRow(inspection, cache.providers[inspection.provider], operation, agents);
    });
    return { operation, providers, upgradeLocked };
  }

  private async refreshIfStale(cache: ProviderCheckCache): Promise<ProviderCheckCache> {
    const stale = PROVIDER_CATALOG.some((entry) => checkIsStale(cache.providers[entry.kind], this.now()));
    return stale ? this.refreshChecks(cache) : cache;
  }

  private async refreshChecks(cache: ProviderCheckCache, only?: ProviderKind): Promise<ProviderCheckCache> {
    const providers = { ...cache.providers };
    const kinds = PROVIDER_CATALOG.map((entry) => entry.kind).filter((kind) => !only || kind === only);
    await Promise.all(
      kinds.map(async (kind) => {
        const checkedAt = this.now().toISOString();
        try {
          providers[kind] = await this.latestVersion(kind, providers[kind], checkedAt);
        } catch (error) {
          const previous = providers[kind];
          providers[kind] = {
            checkedAt,
            checkError: providerCheckError(error),
            ...(previous?.etag ? { etag: previous.etag } : {}),
            ...(previous?.lastModified ? { lastModified: previous.lastModified } : {}),
          };
        }
      }),
    );
    const next = { providers };
    await this.checkStore.write(next);
    return next;
  }

  private async inspect(provider: ProviderKind): Promise<ProviderInspection> {
    return inspectProvider(provider, this.env, this.runCommand);
  }

  private async latestVersion(
    provider: ProviderKind,
    previous: ProviderCheck | undefined,
    checkedAt: string,
  ): Promise<ProviderCheck> {
    let result: VersionLookup;
    if (provider === 'claude-code') {
      result = await fetchTextVersion(
        this.fetchImpl,
        'https://downloads.claude.ai/claude-code-releases/latest',
        previous,
      );
    } else if (provider === 'codex-cli') {
      result = await fetchJsonVersion(this.fetchImpl, 'https://registry.npmjs.org/%40openai%2Fcodex/latest', previous);
    } else if (provider === 'kimi-cli') {
      result = await fetchJsonVersion(this.fetchImpl, 'https://code.kimi.com/kimi-code/latest.json', previous);
    } else {
      result = await grokVersionLookup(this.runCommand, this.env, previous);
    }
    const latestVersion = result.notModified ? previous?.latestVersion : result.version;
    if (!latestVersion) {
      throw new Error('Version endpoint returned not modified without a cached version');
    }
    return {
      checkedAt,
      ...((result.etag ?? previous?.etag) ? { etag: result.etag ?? previous?.etag } : {}),
      ...((result.lastModified ?? previous?.lastModified)
        ? { lastModified: result.lastModified ?? previous?.lastModified }
        : {}),
      latestVersion,
    };
  }

  private async runUpdate(inspection: ProviderInspection, targetVersion: string): Promise<void> {
    const update = inspection.updateCommand;
    if (!update) throw new Error(`No managed update command for ${inspection.label}`);
    const args = update.args.map((arg) => arg.replace('{targetVersion}', targetVersion));
    await this.runCommand(update.command, args, {
      env: this.env,
      timeout: COMMAND_TIMEOUT_MS,
    });
  }

  private async reconcileOperation(
    operation: ProviderCliUpgradeOperationType,
    operationActive = this.applying,
  ): Promise<ProviderCliUpgradeOperationType> {
    if (operation.status !== 'running' || operationActive) return operation;
    const failed: ProviderCliUpgradeOperationType = {
      ...operation,
      completedAt: this.now().toISOString(),
      error: 'Provider CLI update was interrupted before verification completed',
      status: 'failed',
    };
    await this.operationStore.write(failed);
    return failed;
  }
}

async function grokVersionLookup(
  runCommand: ProviderCliCommandRunner,
  env: NodeJS.ProcessEnv,
  previous?: ProviderCheck,
): Promise<VersionLookup> {
  const { stdout } = await runCommand('grok', ['update', '--check', '--json'], {
    env,
    timeout: CHECK_TIMEOUT_MS,
  });
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw Object.assign(new Error('Invalid JSON from grok update --check'), {
      code: 'PARSE',
    });
  }
  if (!value || typeof value !== 'object') {
    throw Object.assign(new Error('Invalid version response from grok update --check'), {
      code: 'PARSE',
    });
  }
  const latestVersion = (value as { latestVersion?: unknown }).latestVersion;
  if (typeof latestVersion !== 'string') {
    if (previous?.latestVersion) return { notModified: true };
    throw Object.assign(new Error('Grok update check returned no latestVersion'), {
      code: 'PARSE',
    });
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latestVersion)) {
    throw Object.assign(new Error('Grok update check returned an invalid latestVersion'), {
      code: 'PARSE',
    });
  }
  return { notModified: false, version: latestVersion };
}

export class ProviderCliCheckStore {
  private readonly file = new JsonStore<ProviderCheckCache>({
    empty: () => ({ providers: {} }),
    parse: ProviderCheckCache.parse,
    path: () => join(resolveAnimaHome(), 'runtime', 'provider-cli-checks.json'),
  });

  read(): Promise<ProviderCheckCache> {
    return this.file.read();
  }

  write(value: ProviderCheckCache): Promise<void> {
    return this.file.write(value);
  }
}

export class ProviderCliOperationStore {
  private readonly file = new JsonStore<ProviderCliUpgradeOperationType>({
    empty: () => IDLE_OPERATION,
    parse: ProviderCliUpgradeOperation.parse,
    path: () => join(resolveAnimaHome(), 'runtime', 'provider-cli-upgrade.json'),
  });

  read(): Promise<ProviderCliUpgradeOperationType> {
    return this.file.read();
  }

  write(value: ProviderCliUpgradeOperationType): Promise<void> {
    return this.file.write(value);
  }
}

export const defaultProviderCliCheckStore = new ProviderCliCheckStore();
export const defaultProviderCliOperationStore = new ProviderCliOperationStore();
export const defaultProviderCliService = new ProviderCliService();

function providerRow(
  inspection: ProviderInspection,
  check: ProviderCheck | undefined,
  operation: ProviderCliUpgradeOperationType,
  agents: ProviderCliAgentImpact[],
): ProviderCliRow {
  let checkError = check?.checkError;
  let updateAvailable = false;
  if (check?.latestVersion && inspection.installedVersion) {
    try {
      updateAvailable = compareRuntimeVersions(check.latestVersion, inspection.installedVersion) > 0;
    } catch (error) {
      checkError = { message: errorMessage(error), type: 'parse' };
    }
  }
  const state: ProviderCliRow['state'] = !inspection.binaryPath
    ? 'not_installed'
    : checkError
      ? 'error'
      : inspection.installSource === 'unknown'
        ? 'unknown'
        : inspection.updateMode === 'manual'
          ? 'manual'
          : !check
            ? 'not_checked'
            : updateAvailable
              ? 'available'
              : 'current';
  return {
    agents,
    ...(inspection.autoUpdateChannel ? { autoUpdateChannel: inspection.autoUpdateChannel } : {}),
    ...(inspection.autoUpdatesEnabled !== undefined ? { autoUpdatesEnabled: inspection.autoUpdatesEnabled } : {}),
    ...(inspection.binaryPath ? { binaryPath: inspection.binaryPath } : {}),
    ...(checkError ? { checkError } : {}),
    ...(check?.checkedAt ? { checkedAt: check.checkedAt } : {}),
    installSource: inspection.installSource,
    ...(inspection.installedVersion ? { installedVersion: inspection.installedVersion } : {}),
    label: inspection.label,
    ...(check?.latestVersion ? { latestVersion: check.latestVersion } : {}),
    ...(inspection.manualCommand ? { manualCommand: inspection.manualCommand } : {}),
    operation,
    provider: inspection.provider,
    ...(inspection.realPath ? { realPath: inspection.realPath } : {}),
    ...(inspection.sourceDetail ? { sourceDetail: inspection.sourceDetail } : {}),
    state,
    updateAvailable,
    updateMode: inspection.updateMode,
  };
}

interface VersionLookup {
  etag?: string;
  lastModified?: string;
  notModified: boolean;
  version?: string;
}

async function fetchTextVersion(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  previous?: ProviderCheck,
): Promise<VersionLookup> {
  const response = await fetchWithTimeout(fetchImpl, url, previous);
  if (response.status === 304) return versionLookup(response);
  const version = (await response.text()).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw Object.assign(new Error(`Invalid version response from ${url}`), {
      code: 'PARSE',
    });
  }
  return versionLookup(response, version);
}

async function fetchJsonVersion(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  previous?: ProviderCheck,
): Promise<VersionLookup> {
  const response = await fetchWithTimeout(fetchImpl, url, previous);
  if (response.status === 304) return versionLookup(response);
  const value = (await response.json()) as unknown;
  if (!value || typeof value !== 'object' || typeof (value as { version?: unknown }).version !== 'string') {
    throw Object.assign(new Error(`Invalid version response from ${url}`), {
      code: 'PARSE',
    });
  }
  const version = (value as { version: string }).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw Object.assign(new Error(`Invalid version response from ${url}`), {
      code: 'PARSE',
    });
  }
  return versionLookup(response, version);
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  previous?: ProviderCheck,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain;q=0.9',
  };
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.status === 304) return response;
  if (!response.ok)
    throw new Error(
      `Version check failed (${response.status})${response.headers.get('retry-after') ? `; retry after ${response.headers.get('retry-after')}` : ''}`,
    );
  return response;
}

function versionLookup(response: Response, version?: string): VersionLookup {
  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    notModified: response.status === 304,
    ...(version ? { version } : {}),
  };
}

function providerCheckError(error: unknown): ProviderCliCheckError {
  const message = errorMessage(error);
  const type =
    typeof error === 'object' && error && 'code' in error && error.code === 'PARSE'
      ? 'parse'
      : /timed out|abort|ENOTFOUND|ECONN|fetch failed/i.test(message)
        ? 'network'
        : 'unknown';
  return { message, type };
}

function checkIsStale(check: ProviderCheck | undefined, now: Date): boolean {
  if (!check) return true;
  const checkedAt = new Date(check.checkedAt).getTime();
  return !Number.isFinite(checkedAt) || now.getTime() - checkedAt >= CHECK_TTL_MS;
}

async function defaultProviderCliCommandRunner(
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ stderr: string; stdout: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    env: options?.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: options?.timeout,
  });
  return { stderr: String(stderr), stdout: String(stdout) };
}
