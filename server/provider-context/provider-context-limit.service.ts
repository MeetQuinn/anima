import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { AgentConfig } from '../../shared/agent-config.js';
import {
  PROVIDER_CONTEXT_LIMIT_PRESETS,
  PROVIDER_CONTEXT_LIMIT_RECOMMENDED,
  type ProviderContextLimitProvider,
  type ProviderContextLimitRequest,
  type ProviderContextLimitsResponse,
} from '../../shared/provider-context-limits.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { withProviderCliConfigurationGate } from '../provider-cli/launch-gate.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';

const OWNED_MARKER = '# Managed by Anima: global provider context limit.';

type ConfigurationGate = <T>(
  provider: ProviderContextLimitProvider,
  task: () => Promise<T>,
) => Promise<T>;

interface ProviderContextLimitServiceOptions {
  env?: NodeJS.ProcessEnv;
  listAgentConfigs?: () => Promise<Pick<AgentConfig, 'provider'>[]>;
  settings?: ProviderContextLimitSettings;
  withConfigurationGate?: ConfigurationGate;
}

interface ProviderContextLimitSettings {
  getProviderContextLimits(): Promise<
    Partial<Record<ProviderContextLimitProvider, number>>
  >;
  setProviderContextLimit(
    provider: ProviderContextLimitProvider,
    maxTokens: number | null,
  ): Promise<Partial<Record<ProviderContextLimitProvider, number>>>;
}

interface ConfigChange {
  rollback(): Promise<void>;
}

export class ProviderContextLimitError extends Error {
  constructor(
    readonly statusCode: 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderContextLimitError';
  }
}

export class ProviderContextLimitService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly listAgentConfigs: () => Promise<
    Pick<AgentConfig, 'provider'>[]
  >;
  private readonly settings: ProviderContextLimitSettings;
  private readonly configurationGate: ConfigurationGate;

  constructor(options: ProviderContextLimitServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.listAgentConfigs =
      options.listAgentConfigs ??
      (() => defaultAgentRegistryService.listAgentConfigs());
    this.settings = options.settings ?? defaultServerSettingsService;
    this.configurationGate =
      options.withConfigurationGate ?? withProviderCliConfigurationGate;
  }

  async status(): Promise<ProviderContextLimitsResponse> {
    return responseFor(await this.settings.getProviderContextLimits());
  }

  async set(
    input: ProviderContextLimitRequest,
  ): Promise<ProviderContextLimitsResponse> {
    return this.configurationGate(input.provider, async () => {
      const models = await this.configuredModels(input.provider);
      const change = await updateProviderConfig(
        input.provider,
        models,
        input.maxTokens,
        this.env,
      );
      try {
        const config = await this.settings.setProviderContextLimit(
          input.provider,
          input.maxTokens,
        );
        return responseFor(config);
      } catch (error) {
        await change.rollback();
        throw error;
      }
    });
  }

  async applyForLaunch(
    provider: ProviderContextLimitProvider,
    model: string | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const maxTokens = (await this.settings.getProviderContextLimits())[
      provider
    ];
    if (maxTokens === undefined) return;
    const normalizedModel = model?.trim();
    if (!normalizedModel) {
      throw new ProviderContextLimitError(
        409,
        `A model must be configured before the global ${provider} context limit can be applied`,
      );
    }
    await updateProviderConfig(provider, [normalizedModel], maxTokens, env);
  }

  private async configuredModels(
    provider: ProviderContextLimitProvider,
  ): Promise<string[]> {
    const models = (await this.listAgentConfigs())
      .filter((agent) => agent.provider.kind === provider)
      .map((agent) => agent.provider.model?.trim())
      .filter((model): model is string => Boolean(model));
    return [...new Set(models)];
  }
}

export const defaultProviderContextLimitService =
  new ProviderContextLimitService();

function responseFor(
  config: Partial<Record<ProviderContextLimitProvider, number>>,
): ProviderContextLimitsResponse {
  return {
    providers: (['kimi-cli', 'grok-cli'] as const).map((provider) => {
      const maxTokens = config[provider] ?? null;
      const presets = [...PROVIDER_CONTEXT_LIMIT_PRESETS[provider]] as number[];
      if (maxTokens !== null && !presets.includes(maxTokens))
        presets.push(maxTokens);
      return {
        maxTokens,
        presets,
        provider,
        recommended: PROVIDER_CONTEXT_LIMIT_RECOMMENDED[provider],
      };
    }),
  };
}

async function updateProviderConfig(
  provider: ProviderContextLimitProvider,
  models: string[],
  maxTokens: number | null,
  env: NodeJS.ProcessEnv,
): Promise<ConfigChange> {
  const path = providerConfigPath(provider, env);
  await ensureConfigHome(dirname(path));
  const before = await readConfigTarget(path);
  if (before === undefined && maxTokens === null)
    return { rollback: async () => undefined };
  const source = before?.text ?? '';
  const next = patchProviderConfig(provider, source, models, maxTokens);
  if (next === source) return { rollback: async () => undefined };
  await writeAtomic(path, next, before?.mode ?? 0o600);
  return {
    rollback: async () => {
      if (before) await writeAtomic(path, before.text, before.mode);
      else
        await unlink(path).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
    },
  };
}

function providerConfigPath(
  provider: ProviderContextLimitProvider,
  env: NodeJS.ProcessEnv,
): string {
  const home = env.HOME?.trim() || homedir();
  if (provider === 'kimi-cli') {
    return join(
      env.KIMI_CODE_HOME?.trim() || join(home, '.kimi-code'),
      'config.toml',
    );
  }
  return join(env.GROK_HOME?.trim() || join(home, '.grok'), 'config.toml');
}

async function ensureConfigHome(path: string): Promise<void> {
  try {
    const result = await lstat(path);
    if (result.isSymbolicLink() || !result.isDirectory()) {
      throw new ProviderContextLimitError(
        409,
        `Provider config home is not a regular directory: ${path}`,
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { mode: 0o700, recursive: true });
  }
}

async function readConfigTarget(
  path: string,
): Promise<{ mode: number; text: string } | undefined> {
  try {
    const result = await lstat(path);
    if (result.isSymbolicLink() || !result.isFile()) {
      throw new ProviderContextLimitError(
        409,
        `Provider config is not a regular file: ${path}`,
      );
    }
    return { mode: result.mode & 0o777, text: await readFile(path, 'utf8') };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeAtomic(
  path: string,
  text: string,
  mode: number,
): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(tempPath, 'wx', mode);
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
    await file.close();
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
}

function patchProviderConfig(
  provider: ProviderContextLimitProvider,
  source: string,
  models: string[],
  maxTokens: number | null,
): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source ? source.split(/\r?\n/) : [];
  if (maxTokens === null) {
    clearOwnedValues(provider, lines);
    return lines.join(eol);
  }
  for (const model of models) setOwnedValue(provider, lines, model, maxTokens);
  return lines.join(eol);
}

function setOwnedValue(
  provider: ProviderContextLimitProvider,
  lines: string[],
  model: string,
  maxTokens: number,
): void {
  const section = sectionFor(provider, model);
  const key = keyFor(provider);
  const sectionStart = findSection(lines, section);
  if (sectionStart === -1) {
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
    lines.push(sectionHeader(section), OWNED_MARKER, `${key} = ${maxTokens}`);
    return;
  }
  const sectionEnd = findNextSection(lines, sectionStart + 1);
  const matchingKeys: number[] = [];
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    if (keyLine(lines[index] ?? '', key)) matchingKeys.push(index);
  }
  if (matchingKeys.length > 1) {
    throw new ProviderContextLimitError(
      409,
      `Provider config has duplicate ${key} values for ${model}`,
    );
  }
  let existing = matchingKeys[0];
  if (existing !== undefined) {
    if (lines[existing - 1]?.trim() !== OWNED_MARKER) {
      lines.splice(existing, 0, OWNED_MARKER);
      existing += 1;
    }
    const indent = /^\s*/.exec(lines[existing] ?? '')?.[0] ?? '';
    lines[existing] = `${indent}${key} = ${maxTokens}`;
    return;
  }
  lines.splice(sectionEnd, 0, OWNED_MARKER, `${key} = ${maxTokens}`);
}

function clearOwnedValues(
  provider: ProviderContextLimitProvider,
  lines: string[],
): void {
  const key = keyFor(provider);
  let section: string[] | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const parsed = parseSection(line);
    if (parsed) section = parsed;
    else if (/^\s*\[/.test(line)) section = undefined;
    if (
      lines[index]?.trim() === OWNED_MARKER &&
      section &&
      providerSection(provider, section) &&
      keyLine(lines[index + 1] ?? '', key)
    ) {
      lines.splice(index, 2);
      index -= 1;
    }
  }
}

function sectionFor(
  provider: ProviderContextLimitProvider,
  model: string,
): string[] {
  if (!model || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new ProviderContextLimitError(
      409,
      'Provider model cannot be represented in config.toml',
    );
  }
  return provider === 'kimi-cli'
    ? ['models', model]
    : ['model', model];
}

function sectionHeader(section: string[]): string {
  return `[${section.map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part))).join('.')}]`;
}

function keyFor(provider: ProviderContextLimitProvider): string {
  return provider === 'kimi-cli' ? 'max_context_size' : 'context_window';
}

function providerSection(
  provider: ProviderContextLimitProvider,
  section: string[],
): boolean {
  return provider === 'kimi-cli'
    ? section.length === 2 && section[0] === 'models'
    : section.length === 2 && section[0] === 'model';
}

function findSection(lines: string[], target: string[]): number {
  return lines.findIndex((line) => {
    const parsed = parseSection(line);
    return (
      parsed?.length === target.length &&
      parsed.every((part, index) => part === target[index])
    );
  });
}

function findNextSection(lines: string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    if (parseSection(lines[index] ?? '')) return index;
  }
  return lines.length;
}

function parseSection(line: string): string[] | undefined {
  const match = /^\s*\[(?!\[)(.+)\]\s*(?:#.*)?$/.exec(line);
  if (!match?.[1]) return undefined;
  const input = match[1];
  const parts: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] ?? '')) index += 1;
    const quote = input[index];
    if (quote === '"' || quote === "'") {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < input.length) {
        const character = input[index];
        index += 1;
        if (character === quote && !escaped) break;
        escaped = quote === '"' && character === '\\' && !escaped;
        if (character !== '\\') escaped = false;
      }
      const token = input.slice(start, index);
      try {
        parts.push(
          quote === '"' ? (JSON.parse(token) as string) : token.slice(1, -1),
        );
      } catch {
        return undefined;
      }
    } else {
      const start = index;
      while (index < input.length && input[index] !== '.') index += 1;
      const token = input.slice(start, index).trim();
      if (!token) return undefined;
      parts.push(token);
    }
    while (/\s/.test(input[index] ?? '')) index += 1;
    if (index === input.length) break;
    if (input[index] !== '.') return undefined;
    index += 1;
  }
  return parts;
}

function keyLine(line: string, key: string): boolean {
  return new RegExp(`^\\s*${key}\\s*=`).test(line);
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT',
  );
}
