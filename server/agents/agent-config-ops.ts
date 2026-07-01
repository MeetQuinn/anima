import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import {
  ANIMA_MANAGED_PROVIDER_ENV_KEYS,
  FeishuConfig,
  AgentProviderConfig,
  agentConfigSchema,
  agentIdFromName,
  type AgentConfig,
  type AgentCreateRequest,
  type AgentUpdateProviderRequest,
} from '../../shared/agent-config.js';
import {
  DEFAULT_REASONING_EFFORT,
  isSupportedReasoningEffort,
  isSupportedProviderKind,
  isSupportedProviderModel,
  providerCatalogEntry,
  type ProviderCatalogEntry,
} from '../../shared/provider-catalog.js';
import { resolveAnimaHome } from '../anima-home.js';
import { AGENT_ID } from '../storage/schema/agent.store.js';

export class AgentConfigError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function isAgentRunnable(agent: AgentConfig): boolean {
  return Boolean(
    agent.provider
    && (
      (agent.slack.connected && agent.slack.appToken && agent.slack.botToken)
      || agent.feishu.connected
    ),
  );
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

// The team + home are resolved by the service layer (TeamService owns team lookup and the
// deterministic $TEAM_HOME/agents/$id derivation); this stays a pure config builder.
export function agentConfigFromCreateInput(
  input: AgentCreateRequest,
  resolved: { teamId: string; homePath: string },
): AgentConfig {
  return {
    createdAt: new Date().toISOString(),
    enabled: true,
    id: agentIdFromName(input.name),
    profile: {
      displayName: input.name,
      role: input.role,
    },
    provider: AgentProviderConfig.parse(input.provider),
    feishu: FeishuConfig.parse({}),
    slack: {
      appToken: '',
      botToken: '',
      connected: false,
      manifestVersion: 0,
      teamId: '',
      workspaceIconUrl: '',
      workspaceName: '',
    },
    homePath: resolveServerPath(resolved.homePath),
    teamId: resolved.teamId,
  };
}

export function agentConfigWithProviderUpdate(
  current: AgentConfig,
  update: AgentUpdateProviderRequest,
): AgentConfig {
  const selection = mergeProviderSelection(current.provider, update);
  const env = mergeProviderEnv(current.provider.env, update.env);
  if (env) selection.env = env;
  return { ...current, provider: AgentProviderConfig.parse(selection) };
}

// Returns the provider's kind/model/effort (and any kind-specific fields), env stripped.
// env is merged separately by mergeProviderEnv so the two concerns stay untangled.
function mergeProviderSelection(
  current: AgentConfig['provider'],
  update: AgentUpdateProviderRequest,
): Record<string, unknown> {
  // Same kind: keep the current selection, overlay only the fields the update provides.
  if (!update.kind || update.kind === current.kind) {
    const currentEffort = 'reasoningEffort' in current ? current.reasoningEffort : undefined;
    const model = update.model ?? current.model;
    const reasoningEffort = update.reasoningEffort ?? currentEffort;
    if (update.transport !== undefined && current.kind !== 'claude-code') {
      throw new AgentConfigError(400, `unsupported transport for ${current.kind}: ${update.transport}`);
    }
    validateProviderShape(current.kind, model, reasoningEffort);

    const { env: _env, ...rest } = current;
    const next: Record<string, unknown> = { ...rest };
    if (update.model !== undefined) next.model = update.model;
    if (update.reasoningEffort !== undefined) next.reasoningEffort = update.reasoningEffort;
    if (update.transport !== undefined) next.transport = update.transport;
    return next;
  }

  // Kind change: drop the old model/effort and adopt the new kind's catalog defaults.
  const entry = providerCatalogEntry(update.kind);
  if (!entry) throw new AgentConfigError(400, `unsupported provider kind ${update.kind}`);
  if (update.transport !== undefined && entry.kind !== 'claude-code') {
    throw new AgentConfigError(400, `unsupported transport for ${entry.kind}: ${update.transport}`);
  }
  const model = update.model ?? entry.defaultModel;
  const reasoningEffort = update.reasoningEffort ?? defaultReasoningEffort(entry);
  validateProviderShape(entry.kind, model, reasoningEffort);

  const next: Record<string, unknown> = { kind: entry.kind, model };
  if (current.idleTimeoutMs !== undefined) next.idleTimeoutMs = current.idleTimeoutMs;
  if (reasoningEffort !== undefined) next.reasoningEffort = reasoningEffort;
  if (entry.kind === 'claude-code' && update.transport !== undefined) next.transport = update.transport;
  return next;
}

function mergeProviderEnv(
  current: Record<string, string> | undefined,
  update: AgentUpdateProviderRequest['env'],
): Record<string, string> | undefined {
  const env: Record<string, string> = { ...current };
  for (const [key, value] of Object.entries(update ?? {})) {
    if (value !== null && isAnimaManagedProviderEnvKey(key)) {
      throw new AgentConfigError(400, `${key} is managed by Anima and cannot be set in provider.env`);
    }
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function defaultReasoningEffort(entry: ProviderCatalogEntry): string | undefined {
  if (entry.reasoningEfforts.length === 0) return undefined;
  return entry.reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : entry.reasoningEfforts[0];
}

function isAnimaManagedProviderEnvKey(key: string): boolean {
  return (ANIMA_MANAGED_PROVIDER_ENV_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Redaction (strip secrets before a config leaves the server)
// ---------------------------------------------------------------------------

export function redactAgentConfig(agent: AgentConfig): AgentConfig {
  return {
    ...agent,
    feishu: { ...agent.feishu, appSecret: '', encryptKey: '', verificationToken: '' },
    provider: redactProviderEnv(agent.provider),
    slack: { ...agent.slack, appToken: '', botToken: '' },
  };
}

// Keep the env keys visible so the UI can show what's set, but blank their values.
function redactProviderEnv(provider: AgentConfig['provider']): AgentConfig['provider'] {
  if (!provider.env) return provider;
  const env = Object.fromEntries(Object.keys(provider.env).sort().map((key) => [key, '']));
  return { ...provider, env };
}

// ---------------------------------------------------------------------------
// Validation (the write gate; the zod schema repairs configs on read)
// ---------------------------------------------------------------------------

export function normalizeAgentConfig(agentId: string, agent: AgentConfig): AgentConfig {
  if (!AGENT_ID.test(agentId)) throw new AgentConfigError(400, `agent id must match ${AGENT_ID}`);
  const next = agentConfigSchema(agentId).parse(agent);
  if (next.id !== agentId) throw new AgentConfigError(400, 'agent id is immutable');
  validateAgentConfigShape(next);
  return next;
}

export function assertAgentConfigId(agentId: string, agent: AgentConfig, path: string): void {
  if (agent.id !== agentId) {
    throw new AgentConfigError(400, `${path}: agent id must match directory name ${agentId}`);
  }
}

export async function validateAgentConfig(agent: AgentConfig): Promise<void> {
  validateAgentConfigShape(agent);
  const homeStat = await stat(resolveAgentHomePath(agent)).catch(() => undefined);
  if (!homeStat?.isDirectory()) {
    throw new AgentConfigError(400, `Agent ${agent.id}: homePath must be an existing directory`);
  }
}

export async function validateRunnableAgentConfig(agent: AgentConfig): Promise<void> {
  await validateAgentConfig(agent);
  if (!isAgentRunnable(agent)) {
    throw new Error(`Agent ${agent.id}: provider and at least one connected platform are required to run`);
  }
}

function validateAgentConfigShape(agent: AgentConfig): void {
  if (!AGENT_ID.test(agent.id)) throw new AgentConfigError(400, `agent id must match ${AGENT_ID}`);
  const provider = agent.provider;
  const reasoningEffort = 'reasoningEffort' in provider ? provider.reasoningEffort : undefined;
  validateProviderShape(provider.kind, provider.model, reasoningEffort, `Agent ${agent.id}: `);
  if (agent.slack.appToken && !agent.slack.appToken.startsWith('xapp-')) {
    throw new AgentConfigError(400, `Agent ${agent.id}: slack.appToken must start with xapp-`);
  }
  if (agent.slack.botToken && !agent.slack.botToken.startsWith('xoxb-')) {
    throw new AgentConfigError(400, `Agent ${agent.id}: slack.botToken must start with xoxb-`);
  }
}

function validateProviderShape(
  kind: string,
  model: string | undefined,
  reasoningEffort: string | undefined,
  prefix = '',
): void {
  if (!isSupportedProviderKind(kind)) {
    throw new AgentConfigError(400, `${prefix}unsupported provider kind ${kind}`);
  }
  if (model && !isSupportedProviderModel(kind, model)) {
    throw new AgentConfigError(400, `${prefix}unsupported model for ${kind}: ${model}`);
  }
  if (reasoningEffort && !isSupportedReasoningEffort(kind, reasoningEffort)) {
    throw new AgentConfigError(400, `${prefix}unsupported reasoningEffort ${reasoningEffort}`);
  }
}

// ---------------------------------------------------------------------------
// Home paths
// ---------------------------------------------------------------------------

export async function ensureCreateAgentHome(homePath: string): Promise<void> {
  const absolutePath = resolveServerPath(homePath);
  const existing = await stat(absolutePath).catch(() => undefined);
  if (existing) {
    if (!existing.isDirectory()) throw new AgentConfigError(400, 'homePath must be a directory');
    return;
  }
  // Recursive so the full path (including the default agent home root) is created on first
  // run when the parent directories don't exist yet.
  await mkdir(absolutePath, { recursive: true });
}

export async function ensureExistingAgentHome(homePath: string): Promise<void> {
  const existing = await stat(resolveServerPath(homePath)).catch(() => undefined);
  if (!existing?.isDirectory()) {
    throw new AgentConfigError(400, 'homePath must be an existing directory');
  }
}

export function resolveAgentHomePath(agent: AgentConfig): string {
  return resolveServerPath(agent.homePath);
}

function resolveServerPath(rawPath: string): string {
  const expanded = expandHome(rawPath);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(resolveAnimaHome(), expanded);
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}
