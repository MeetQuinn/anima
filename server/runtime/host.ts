import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { defaultAgentRegistryService } from '../agents/agent.service.js';
import {
  isAgentRunnable,
  resolveAgentHomePath,
  validateAgentConfig,
  validateRunnableAgentConfig,
} from '../agents/agent-config-ops.js';
import { ensureDefaultSkills } from '../agents/default-skills.js';
import { resolveAnimaHome } from '../anima-home.js';
import { errorMessage } from '../ids.js';
import { createAgentRuntime } from '../providers/factory.js';
import type { AgentProviderConfig } from '../providers/contract.js';
import { createSlackWebClient } from '../slack/client.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import { startRunningAgent, type RunningAgentHandle } from './agent-runner.js';
import type { RuntimeWorkerConfig } from './types.js';

export interface RuntimeHostOptions {
  agent?: string;
  pollIntervalMs?: number;
}

export type { RunningAgentHandle } from './agent-runner.js';

interface RunningAgentRecord {
  fingerprint: string;
  handle: RunningAgentHandle;
}

export interface RuntimeHostDependencies {
  animaHome?: string;
  loadAgents?: (opts: RuntimeHostOptions) => Promise<AgentConfig[]>;
  ensureDefaultSkills?: () => Promise<void>;
  logger?: Pick<Console, 'error' | 'log'>;
  startAgent?: (agent: AgentConfig, animaHome: string) => Promise<RunningAgentHandle>;
  validateAgent?: (agent: AgentConfig) => Promise<void> | void;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const CONFIG_WATCH_DEBOUNCE_MS = 150;

export async function startRuntimeHost(opts: RuntimeHostOptions = {}): Promise<void> {
  const host = new RuntimeHost(opts);
  await host.start();
  await awaitShutdown(async () => {
    await host.stop();
  });
}

export class RuntimeHost {
  private readonly agentHandles = new Map<string, RunningAgentRecord>();
  private readonly animaHome: string;
  private readonly loadAgents: (opts: RuntimeHostOptions) => Promise<AgentConfig[]>;
  private readonly ensureDefaultSkills: () => Promise<void>;
  private readonly logger: Pick<Console, 'error' | 'log'>;
  private readonly startAgent: (agent: AgentConfig, animaHome: string) => Promise<RunningAgentHandle>;
  private readonly statusByAgent = new Map<string, string>();
  private readonly validateAgent: (agent: AgentConfig) => Promise<void> | void;
  private pollTimer?: NodeJS.Timeout;
  private reconcile?: Promise<void>;
  private readonly configWatchers = new Map<string, FSWatcher>();
  private configWatchDebounce?: NodeJS.Timeout;

  constructor(
    private readonly opts: RuntimeHostOptions = {},
    deps: RuntimeHostDependencies = {},
  ) {
    this.animaHome = deps.animaHome ?? resolveAnimaHome();
    this.loadAgents = deps.loadAgents ?? loadRuntimeAgents;
    this.ensureDefaultSkills = deps.ensureDefaultSkills ?? (async () => {
      await ensureDefaultSkills();
    });
    this.logger = deps.logger ?? console;
    this.startAgent = deps.startAgent ?? startAgentFromConfig;
    this.validateAgent = deps.validateAgent ?? validateAgentConfig;
  }

  async start(): Promise<void> {
    await this.ensureDefaultSkills().catch((error: unknown) => {
      this.logger.error(`Default skill setup failed: ${errorMessage(error)}`);
    });
    await this.reconcileOnce();
    this.pollTimer = setInterval(() => {
      void this.reconcileOnce().catch((error: unknown) => {
        this.logger.error(`Runtime host reconcile failed: ${errorMessage(error)}`);
      });
    }, this.opts.pollIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.configWatchDebounce) {
      clearTimeout(this.configWatchDebounce);
      this.configWatchDebounce = undefined;
    }
    this.closeConfigWatchers();
    await this.reconcile?.catch((error: unknown) => {
      this.logger.error(`Runtime host reconcile failed while stopping: ${errorMessage(error)}`);
    });
    const handles = [...this.agentHandles.values()].map((record) => record.handle);
    this.agentHandles.clear();
    await Promise.allSettled(handles.map((handle) => handle.stop()));
  }

  async reconcileOnce(): Promise<void> {
    if (this.reconcile) return this.reconcile;
    const reconcile = this.reconcileAgents();
    this.reconcile = reconcile;
    try {
      await reconcile;
    } finally {
      if (this.reconcile === reconcile) this.reconcile = undefined;
    }
  }

  runningAgentIds(): string[] {
    return [...this.agentHandles.keys()].sort();
  }

  private async reconcileAgents(): Promise<void> {
    const agents = await this.loadAgents(this.opts);
    this.syncConfigWatchers(agents.map((agent) => agent.id));
    const seenAgentIds = new Set<string>();
    for (const agent of agents) {
      seenAgentIds.add(agent.id);
      const running = this.agentHandles.get(agent.id);
      try {
        await this.validateAgent(agent);
        const skipStatus = agentSkipStatus(agent);
        if (running) {
          await this.reconcileRunningAgent(agent, running, skipStatus);
          continue;
        }
        if (skipStatus) {
          this.logAgentStatus(agent.id, `skip:${skipStatus}`, () => {
            this.logger.log(`Agent ${agent.id}: ${skipStatus}.`);
          });
          continue;
        }
        await this.startAndStore(agent);
      } catch (error) {
        const action = running ? 'failed to reconcile' : 'failed to start';
        const message = `Agent ${agent.id} ${action}: ${errorMessage(error)}`;
        this.logAgentStatus(agent.id, `error:${message}`, () => {
          this.logger.error(message);
        });
      }
    }
    if (!this.opts.agent) await this.stopMissingAgents(seenAgentIds);
  }

  private async reconcileRunningAgent(
    agent: AgentConfig,
    running: RunningAgentRecord,
    skipStatus: string | undefined,
  ): Promise<void> {
    if (skipStatus) {
      if (isHandleActive(running.handle)) {
        this.logAgentStatus(agent.id, `pending-stop:${skipStatus}`, () => {
          this.logger.log(`Agent ${agent.id}: ${skipStatus}; will stop after the active item finishes.`);
        });
        return;
      }
      await running.handle.stop({ drainActive: true });
      this.agentHandles.delete(agent.id);
      this.logAgentStatus(agent.id, `skip:${skipStatus}`, () => {
        this.logger.log(`Agent ${agent.id}: ${skipStatus}.`);
      });
      return;
    }

    const nextFingerprint = runtimeFingerprint(agent);
    if (running.fingerprint === nextFingerprint) return;
    if (isHandleActive(running.handle)) {
      this.logAgentStatus(agent.id, 'pending-restart', () => {
        this.logger.log(`Agent ${agent.id}: config changed; will reload after the active item finishes.`);
      });
      return;
    }

    this.logger.log(`Agent ${agent.id}: config changed; reloading runtime.`);
    await running.handle.stop({ drainActive: true });
    this.agentHandles.delete(agent.id);
    await this.startAndStore(agent, nextFingerprint);
  }

  private async startAndStore(agent: AgentConfig, fingerprint = runtimeFingerprint(agent)): Promise<void> {
    const handle = await this.startAgent(agent, this.animaHome);
    this.agentHandles.set(agent.id, { fingerprint, handle });
    this.statusByAgent.delete(agent.id);
  }

  private async stopMissingAgents(seenAgentIds: Set<string>): Promise<void> {
    for (const [agentId, running] of this.agentHandles) {
      if (seenAgentIds.has(agentId)) continue;
      if (isHandleActive(running.handle)) {
        this.logAgentStatus(agentId, 'pending-remove', () => {
          this.logger.log(`Agent ${agentId}: removed from config; will stop after the active item finishes.`);
        });
        continue;
      }
      await running.handle.stop({ drainActive: true });
      this.agentHandles.delete(agentId);
      this.statusByAgent.delete(agentId);
      this.logger.log(`Agent ${agentId}: removed from config; stopped.`);
    }
  }

  private logAgentStatus(agentId: string, status: string, write: () => void): void {
    if (this.statusByAgent.get(agentId) === status) return;
    this.statusByAgent.set(agentId, status);
    write();
  }

  private syncConfigWatchers(agentIds: string[]): void {
    const nextPaths = new Map<string, string>();
    const root = join(this.animaHome, 'agents');
    if (existsSync(root)) nextPaths.set('agents', root);
    for (const agentId of agentIds) {
      const agentDir = join(root, agentId);
      if (existsSync(agentDir)) nextPaths.set(`agent:${agentId}`, agentDir);
    }

    for (const [key, watcher] of this.configWatchers) {
      if (nextPaths.has(key)) continue;
      watcher.close();
      this.configWatchers.delete(key);
    }
    for (const [key, path] of nextPaths) {
      if (this.configWatchers.has(key)) continue;
      try {
        const watcher = watch(path, { persistent: false }, (_event, filename) => {
          if (key !== 'agents' && !isConfigFileEvent(filename)) return;
          this.scheduleConfigReconcile();
        });
        watcher.on('error', (error: unknown) => {
          this.logger.error(`Runtime host config watcher failed for ${path}: ${errorMessage(error)}`);
          watcher.close();
          this.configWatchers.delete(key);
        });
        this.configWatchers.set(key, watcher);
      } catch (error) {
        this.logger.error(`Runtime host config watcher failed for ${path}: ${errorMessage(error)}`);
      }
    }
  }

  private scheduleConfigReconcile(): void {
    if (this.configWatchDebounce) clearTimeout(this.configWatchDebounce);
    this.configWatchDebounce = setTimeout(() => {
      this.configWatchDebounce = undefined;
      void this.reconcileOnce().catch((error: unknown) => {
        this.logger.error(`Runtime host reconcile failed: ${errorMessage(error)}`);
      });
    }, CONFIG_WATCH_DEBOUNCE_MS);
  }

  private closeConfigWatchers(): void {
    for (const watcher of this.configWatchers.values()) watcher.close();
    this.configWatchers.clear();
  }
}

export async function loadRuntimeAgents(opts: RuntimeHostOptions = {}): Promise<AgentConfig[]> {
  if (opts.agent) return [await defaultAgentRegistryService.serviceFor(opts.agent).getConfig()];
  return defaultAgentRegistryService.listAgentConfigs();
}

async function startAgentFromConfig(agent: AgentConfig, animaHome: string): Promise<RunningAgentHandle> {
  await validateRunnableAgentConfig(agent);
  const server = runtimeServerConfigForAgent(agent);
  await validateSlackConnectionForStart(agent.id, server);
  console.log(
    [
      `Starting Anima agent ${server.config.agentId}.`,
      `State dir: ${server.config.stateDir}`,
      'Reply policy: DMs and @mentions always wake; member channels and involved threads wake unless muted.',
      'Slack output: send enabled.',
    ].join('\n'),
  );
  return startRunningAgent({
    ...server.config,
    agentRuntime: createAgentRuntime(
      runtimeWithEnv(server.runtime, {
        ANIMA_HOME: animaHome,
        ANIMA_RUNTIME_HOME: animaHome,
        ANIMA_SLACK_BOT_TOKEN: server.botToken,
        SLACK_BOT_TOKEN: server.botToken,
      }),
    ),
    appToken: server.appToken,
    botToken: server.botToken,
    ...(server.runtime.idleTimeoutMs !== undefined ? { idleTimeoutMs: server.runtime.idleTimeoutMs } : {}),
  });
}

function isHandleActive(handle: RunningAgentHandle): boolean {
  return handle.isActive?.() ?? false;
}

function runtimeFingerprint(agent: AgentConfig): string {
  return stableJson({
    enabled: agent.enabled,
    homePath: resolveAgentHomePath(agent),
    profile: {
      displayName: agent.profile.displayName,
      role: agent.profile.role,
    },
    provider: agent.provider,
    slack: {
      appToken: agent.slack.appToken,
      botToken: agent.slack.botToken,
      connected: agent.slack.connected,
    },
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function isConfigFileEvent(filename: Buffer | string | null): boolean {
  return filename?.toString() === 'config.json';
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => [key, stableValue(entryValue)]),
  );
}

async function validateSlackConnectionForStart(
  agentId: string,
  server: { appToken: string; botToken: string },
): Promise<void> {
  try {
    await createSlackWebClient(server.botToken).auth.test();
  } catch (error) {
    throw new Error(`Agent ${agentId}: bot token auth.test failed: ${errorMessage(error)}`);
  }
  try {
    await createSlackWebClient(server.appToken).apps.connections.open({});
  } catch (error) {
    throw new Error(`Agent ${agentId}: app token apps.connections.open failed: ${errorMessage(error)}`);
  }
}

function agentSkipStatus(agent: AgentConfig): string | undefined {
  if (!agent.enabled) return 'disabled';
  if (agent.slack.connected !== true || !agent.slack.appToken || !agent.slack.botToken) {
    return 'idle / awaiting Slack connection';
  }
  if (isAgentRunnable(agent)) return undefined;
  return 'idle / incomplete config';
}

function runtimeServerConfigForAgent(agent: AgentConfig): {
  appToken: string;
  botToken: string;
  config: RuntimeWorkerConfig;
  runtime: AgentProviderConfig;
} {
  const slack = agent.slack;
  const config = runtimeWorkerConfigForAgent(agent);
  const botToken = slack.botToken;
  const appToken = slack.appToken;
  const runtime = agent.provider;
  if (!botToken) throw new Error(`Agent ${agent.id}: slack.botToken is required`);
  if (!appToken) throw new Error(`Agent ${agent.id}: slack.appToken is required`);
  if (!runtime) throw new Error(`Agent ${agent.id}: provider is required`);
  return {
    appToken,
    botToken,
    config,
    runtime,
  };
}

function runtimeWorkerConfigForAgent(agent: AgentConfig): RuntimeWorkerConfig {
  const stateDir = resolveAnimaHome();
  return {
    agentId: agent.id,
    homePath: resolveAgentHomePath(agent),
    stateDir,
  };
}

function runtimeWithEnv(config: AgentProviderConfig, env: Record<string, string>): AgentProviderConfig {
  return {
    ...config,
    env: {
      ...(config.env ?? {}),
      ...env,
    },
  };
}

async function awaitShutdown(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    const handle = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      console.log(`Received ${signal}, shutting down...`);
      stop()
        .catch((error) => {
          console.error(`Shutdown error: ${errorMessage(error)}`);
        })
        .finally(() => resolveShutdown());
    };
    process.once('SIGINT', handle);
    process.once('SIGTERM', handle);
  });
}
