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
import { SecretHandoffPendingStore } from '../env/secret-handoff-store.js';
import { HumanSecretHandoffPendingStore } from '../env/human-secret-handoff-store.js';
import { errorMessage, nowIso } from '../ids.js';
import { WakeQueueService, wakeQueueServiceForAgent, type InboxItem } from '../inbox/wake-queue.service.js';
import { MemoryCoherenceScheduler } from '../memory/memory-coherence-scheduler.js';
import { createAgentRuntime } from '../providers/factory.js';
import type { AgentProviderConfig } from '../providers/contract.js';
import { isRestartDrainActive } from '../services/restart-drain.js';
import { cacheDelete } from '../storage/json-file.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';
import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import {
  FEISHU_OPEN_API_BASE_URL,
  fetchFeishuTenantAccessToken,
  type FeishuTenantAccessToken,
} from '../feishu/client.js';
import { createSlackWebClient } from '../slack/client.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import { agentHasConnectedTransport } from '../../shared/agent-transports.js';
import {
  AgentRestartCommandStore,
  type AgentRestartCommand,
} from './agent-restart-command.store.js';
import { AgentHealthStore } from './agent-health.store.js';
import {
  AgentHealthService,
  isProviderFailureReason,
  isStaleRunningItem,
  restartStatus,
  runtimeHandleHealth,
  startingTimeoutHealth,
} from './agent-health.service.js';
import { startRunningAgent, type RunningAgentHandle } from './agent-runner.js';
import { findActiveRuntimeItem } from './active-item.js';
import { latestPrimaryRunningItem } from './item-state.js';
import type { RuntimeWorkerConfig } from './types.js';
import type {
  AgentHealthReason,
  AgentRuntimeHandleSnapshot,
} from '../../shared/snapshot.js';
import { ensureAnimaHome } from '../storage/write-root.js';

export interface RuntimeHostOptions {
  agent?: string;
  pollIntervalMs?: number;
}

export type { RunningAgentHandle } from './agent-runner.js';

interface RunningAgentRecord {
  fingerprint: string;
  handle: RunningAgentHandle;
}

interface ManagedAgent {
  config: AgentConfig;
  lastLoggedStatus?: string;
  running?: RunningAgentRecord;
}

export interface StartAgentOptions {
  forceStopAfterMs: number;
  startTimeoutMs: number;
}

export interface RuntimeHostDependencies {
  animaHome?: string;
  forceRestartTimeoutMs?: number;
  loadAgents?: (opts: RuntimeHostOptions) => Promise<AgentConfig[]>;
  ensureDefaultSkills?: () => Promise<void>;
  healthIntervalMs?: number;
  healthStore?: AgentHealthStore;
  logger?: Pick<Console, 'error' | 'log'>;
  memoryCoherenceScheduler?: Pick<MemoryCoherenceScheduler, 'reconcile'>;
  restartCommands?: AgentRestartCommandStore;
  startAgent?: (agent: AgentConfig, animaHome: string, options: StartAgentOptions) => Promise<RunningAgentHandle>;
  startAgentTimeoutMs?: number;
  syncSlackDisplayInfo?: (agent: AgentConfig) => Promise<AgentConfig>;
  validateAgent?: (agent: AgentConfig) => Promise<void> | void;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 5_000;
const DEFAULT_AGENT_START_TIMEOUT_MS = 30_000;
const CONFIG_WATCH_DEBOUNCE_MS = 150;
const AGENT_RESTART_FORCE_KILL_AFTER_MS = 5_000;
const HANDOFF_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export async function startRuntimeHost(opts: RuntimeHostOptions = {}): Promise<void> {
  const host = new RuntimeHost(opts);
  await host.start();
  await awaitShutdown(async () => {
    await host.stop();
  });
}

export class RuntimeHost {
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly animaHome: string;
  private readonly loadAgents: (opts: RuntimeHostOptions) => Promise<AgentConfig[]>;
  private readonly ensureDefaultSkills: () => Promise<void>;
  private readonly logger: Pick<Console, 'error' | 'log'>;
  private readonly memoryCoherenceScheduler: Pick<MemoryCoherenceScheduler, 'reconcile'>;
  private readonly restartCommands: AgentRestartCommandStore;
  private readonly health: AgentHealthService;
  private readonly healthIntervalMs: number;
  private readonly forceRestartTimeoutMs: number;
  private readonly startAgentTimeoutMs: number;
  private readonly startAgent: (agent: AgentConfig, animaHome: string, options: StartAgentOptions) => Promise<RunningAgentHandle>;
  private readonly syncSlackDisplayInfo: (agent: AgentConfig) => Promise<AgentConfig>;
  private readonly validateAgent: (agent: AgentConfig) => Promise<void> | void;
  private pollTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private reconcile?: Promise<void>;
  private healthPublish?: Promise<void>;
  private readonly configWatchers = new Map<string, FSWatcher>();
  private restartCommandWatcher?: FSWatcher;
  private configWatchDebounce?: NodeJS.Timeout;
  private bootHealthInitialized = false;
  private lastHandoffCleanupAt = 0;

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
    this.memoryCoherenceScheduler = deps.memoryCoherenceScheduler ?? new MemoryCoherenceScheduler({
      readServerConfig: () => new ServerConfigStore(this.animaHome).read(),
    });
    this.restartCommands = deps.restartCommands ?? new AgentRestartCommandStore({ animaHome: this.animaHome });
    this.health = new AgentHealthService(deps.healthStore ?? new AgentHealthStore({ animaHome: this.animaHome }));
    this.healthIntervalMs = deps.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.forceRestartTimeoutMs = deps.forceRestartTimeoutMs ?? AGENT_RESTART_FORCE_KILL_AFTER_MS;
    this.startAgentTimeoutMs = deps.startAgentTimeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS;
    this.startAgent = deps.startAgent ?? startAgentFromConfig;
    this.syncSlackDisplayInfo = deps.syncSlackDisplayInfo
      ?? (deps.startAgent
        ? ((agent) => Promise.resolve(agent))
        : syncSlackDisplayInfoForRuntimeStart);
    this.validateAgent = deps.validateAgent ?? validateAgentConfig;
  }

  async start(): Promise<void> {
    // Create the home deliberately, once. Every later write asserts this root
    // rather than manufacturing it (see storage/write-root.ts).
    //
    // `this.animaHome`, not the ambient root: this host's stores are all built
    // with that authority, and provisioning a different directory would leave
    // them refusing to write to a home nobody created.
    await ensureAnimaHome(this.animaHome);
    await this.restartCommands.ensureDirectory();
    await this.health.ensureDirectory();
    this.syncRestartCommandWatcher();
    await this.ensureDefaultSkills().catch((error: unknown) => {
      this.logger.error(`Default skill setup failed: ${errorMessage(error)}`);
    });
    await this.reconcileOnce();
    this.healthTimer = setInterval(() => {
      void this.publishKnownHealthSnapshots().catch((error: unknown) => {
        this.logger.error(`Runtime host health publish failed: ${errorMessage(error)}`);
      });
    }, this.healthIntervalMs);
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
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.configWatchDebounce) {
      clearTimeout(this.configWatchDebounce);
      this.configWatchDebounce = undefined;
    }
    this.closeConfigWatchers();
    this.closeRestartCommandWatcher();
    await this.reconcile?.catch((error: unknown) => {
      this.logger.error(`Runtime host reconcile failed while stopping: ${errorMessage(error)}`);
    });
    await this.healthPublish?.catch((error: unknown) => {
      this.logger.error(`Runtime host health publish failed while stopping: ${errorMessage(error)}`);
    });
    const handles = [...this.agents.values()].flatMap((record) => record.running ? [record.running.handle] : []);
    this.agents.clear();
    const stopOptions = await this.shutdownStopOptions();
    await Promise.allSettled(handles.map((handle) => handle.stop(stopOptions)));
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
    return [...this.agents.entries()]
      .filter(([, record]) => record.running)
      .map(([agentId]) => agentId)
      .sort();
  }

  private async reconcileAgents(): Promise<void> {
    const agents = await this.loadAgents(this.opts);
    await this.cleanupExpiredHandoffs(agents);
    await this.initializeBootHealth(agents);
    this.syncConfigWatchers(agents.map((agent) => agent.id));
    const pendingRestartAgentIds = new Set(await this.restartCommands.pendingAgentIds());
    const seenAgentIds = new Set<string>();
    for (const agent of agents) {
      seenAgentIds.add(agent.id);
      const record = this.managedAgent(agent);
      const running = record.running;
      try {
        await this.validateAgent(agent);
        const skipStatus = agentSkipStatus(agent);
        const restartCommand = pendingRestartAgentIds.has(agent.id)
          ? await this.restartCommands.take(agent.id)
          : undefined;
        if (restartCommand) {
          await this.forceRestartAgent(record, skipStatus, restartCommand);
          continue;
        }
        if (running) {
          await this.reconcileRunningAgent(record, running, skipStatus);
          continue;
        }
        if (skipStatus) {
          await this.writeUnknownHealth(agent.id);
          this.logAgentStatus(record, `skip:${skipStatus}`, () => {
            this.logger.log(`Agent ${agent.id}: ${skipStatus}.`);
          });
          continue;
        }
        await this.startAndStore(agent);
      } catch (error) {
        const action = running ? 'failed to reconcile' : 'failed to start';
        const message = `Agent ${agent.id} ${action}: ${errorMessage(error)}`;
        this.logAgentStatus(record, `error:${message}`, () => {
          this.logger.error(message);
        });
        await this.writeFailedHealth(agent.id, running ? 'stale_running_item' : 'start_failed');
      }
    }
    await this.clearMissingRestartCommands(seenAgentIds, pendingRestartAgentIds);
    if (!this.opts.agent) await this.stopMissingAgents(seenAgentIds);
    await this.reconcileMemoryCoherence(agents);
    await this.publishKnownHealthSnapshots();
  }

  private async cleanupExpiredHandoffs(agents: AgentConfig[]): Promise<void> {
    const now = Date.now();
    if (now - this.lastHandoffCleanupAt < HANDOFF_CLEANUP_INTERVAL_MS) return;
    this.lastHandoffCleanupAt = now;
    const cleanups = agents.flatMap((agent) => [
      {
        agentId: agent.id,
        run: () => new SecretHandoffPendingStore(agent.id, this.animaHome).cleanupExpired(),
      },
      {
        agentId: agent.id,
        run: () => new HumanSecretHandoffPendingStore(agent.id, this.animaHome).cleanupExpired(),
      },
    ]);
    const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup.run()));
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      this.logger.error(
        `Agent ${cleanups[index]?.agentId ?? 'unknown'} handoff cleanup failed: ${errorMessage(result.reason)}`,
      );
    }
  }

  private managedAgent(agent: AgentConfig): ManagedAgent {
    const existing = this.agents.get(agent.id);
    if (existing) {
      existing.config = agent;
      return existing;
    }
    const record: ManagedAgent = { config: agent };
    this.agents.set(agent.id, record);
    return record;
  }

  private async reconcileMemoryCoherence(agents: AgentConfig[]): Promise<void> {
    try {
      await this.memoryCoherenceScheduler.reconcile(agents);
    } catch (error) {
      this.logger.error(`Memory coherence scheduler reconcile failed: ${errorMessage(error)}`);
    }
  }

  private async initializeBootHealth(agents: AgentConfig[]): Promise<void> {
    if (this.bootHealthInitialized) return;
    this.bootHealthInitialized = true;
    await Promise.allSettled(
      agents
        .filter((agent) => agent.enabled !== false && agentHasConnectedTransport(agent) && isAgentRunnable(agent))
        .map(async (agent) => {
          const previous = await this.health.get(agent.id);
          if (previous?.state === 'unhealthy' && isProviderFailureReason(previous.reason)) return;
          await this.health.writeHealth({
            agentId: agent.id,
            state: 'starting',
            updatedAt: nowIso(),
          });
        }),
    );
  }

  private async forceRestartAgent(
    record: ManagedAgent,
    skipStatus: string | undefined,
    command: AgentRestartCommand,
  ): Promise<void> {
    const agent = record.config;
    const running = record.running;
    if (skipStatus) {
      this.logAgentStatus(record, `restart-skip:${skipStatus}`, () => {
        this.logger.log(`Agent ${agent.id}: restart ${command.requestId} skipped; ${skipStatus}.`);
      });
      await this.writeRestartFailed(agent.id, command, 'start_failed');
      if (running) await this.reconcileRunningAgent(record, running, skipStatus);
      return;
    }
    this.logger.log(`Agent ${agent.id}: restart requested by operator (${command.requestId}).`);
    await this.writeRestartPending(agent.id, command, running?.handle.health?.());
    try {
      await this.resolveStaleRestartItem(agent.id, running?.handle.health?.());
      if (running) {
        await running.handle.stop({
          abortReason: command.reason,
          forceAfterMs: this.forceRestartTimeoutMs,
        });
        record.running = undefined;
      }
      await this.startAndStore(agent, command);
    } catch (error) {
      await this.writeRestartFailed(agent.id, command, 'restart_failed');
      throw error;
    }
  }

  private async reconcileRunningAgent(
    record: ManagedAgent,
    running: RunningAgentRecord,
    skipStatus: string | undefined,
  ): Promise<void> {
    const agent = record.config;
    if (skipStatus) {
      if (isHandleActive(running.handle)) {
        this.logAgentStatus(record, `pending-stop:${skipStatus}`, () => {
          this.logger.log(`Agent ${agent.id}: ${skipStatus}; will stop after the active item finishes.`);
        });
        return;
      }
      await running.handle.stop({ drainActive: true });
      record.running = undefined;
      await this.writeUnknownHealth(agent.id);
      this.logAgentStatus(record, `skip:${skipStatus}`, () => {
        this.logger.log(`Agent ${agent.id}: ${skipStatus}.`);
      });
      return;
    }

    const nextFingerprint = runtimeFingerprint(agent);
    if (running.fingerprint === nextFingerprint) return;
    if (isHandleActive(running.handle)) {
      this.logAgentStatus(record, 'pending-restart', () => {
        this.logger.log(`Agent ${agent.id}: config changed; will reload after the active item finishes.`);
      });
      return;
    }

    this.logger.log(`Agent ${agent.id}: config changed; reloading runtime.`);
    await running.handle.stop({
      drainActive: true,
      forceAfterMs: this.forceRestartTimeoutMs,
    });
    record.running = undefined;
    await this.startAndStore(agent);
  }

  private async startAndStore(
    agent: AgentConfig,
    restartCommand?: AgentRestartCommand,
  ): Promise<void> {
    await this.health.writeHealth({
      agentId: agent.id,
      ...(restartCommand ? {
        reason: 'restart_pending',
        restart: restartStatus(restartCommand, 'pending', nowIso()),
      } : {}),
      state: 'starting',
      updatedAt: nowIso(),
    });
    const started = await this.startAgentWithTimeout(agent);
    const record = this.managedAgent(started.agent);
    record.running = { fingerprint: runtimeFingerprint(started.agent), handle: started.handle };
    record.lastLoggedStatus = undefined;
    await this.publishHealthForAgent(record, restartCommand);
  }

  private async startAgentWithTimeout(agent: AgentConfig): Promise<{ agent: AgentConfig; handle: RunningAgentHandle }> {
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    const startPromise = (async () => {
      const startAgent = await this.agentAfterSlackDisplayInfoSync(agent);
      const handle = await this.startAgent(startAgent, this.animaHome, {
        forceStopAfterMs: this.forceRestartTimeoutMs,
        startTimeoutMs: this.startAgentTimeoutMs,
      });
      return { agent: startAgent, handle };
    })();
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Agent ${agent.id} startup timed out after ${this.startAgentTimeoutMs}ms`));
      }, this.startAgentTimeoutMs);
    });
    try {
      return await Promise.race([startPromise, timeoutPromise]);
    } catch (error) {
      if (timedOut) {
        void startPromise.then(
          async (lateStart) => {
            try {
              await lateStart.handle.stop({
                abortReason: 'operator_restart',
                forceAfterMs: this.forceRestartTimeoutMs,
              });
              this.logger.log(`Agent ${agent.id}: stopped late startup handle after timeout.`);
            } catch (stopError) {
              this.logger.error(`Agent ${agent.id}: late startup handle stop failed: ${errorMessage(stopError)}`);
            }
          },
          (lateError: unknown) => {
            this.logger.error(`Agent ${agent.id}: timed-out startup later failed: ${errorMessage(lateError)}`);
          },
        );
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async agentAfterSlackDisplayInfoSync(agent: AgentConfig): Promise<AgentConfig> {
    try {
      return await this.syncSlackDisplayInfo(agent);
    } catch (error) {
      this.logger.error(`Agent ${agent.id}: Slack display-info sync failed before runtime start: ${errorMessage(error)}`);
      return agent;
    }
  }

  private async stopMissingAgents(seenAgentIds: Set<string>): Promise<void> {
    for (const [agentId, record] of this.agents) {
      if (seenAgentIds.has(agentId)) continue;
      const running = record.running;
      if (!running) {
        this.agents.delete(agentId);
        continue;
      }
      if (isHandleActive(running.handle)) {
        this.logAgentStatus(record, 'pending-remove', () => {
          this.logger.log(`Agent ${agentId}: removed from config; will stop after the active item finishes.`);
        });
        continue;
      }
      await running.handle.stop({ drainActive: true });
      this.agents.delete(agentId);
      await this.health.clear(agentId);
      this.logger.log(`Agent ${agentId}: removed from config; stopped.`);
    }
  }

  private async clearMissingRestartCommands(
    seenAgentIds: Set<string>,
    pendingRestartAgentIds: Set<string>,
  ): Promise<void> {
    for (const agentId of pendingRestartAgentIds) {
      if (seenAgentIds.has(agentId)) continue;
      await this.restartCommands.clear(agentId);
      await this.writeUnknownHealth(agentId);
      this.logger.log(`Agent ${agentId}: restart request discarded; agent not found.`);
    }
  }

  private async publishKnownHealthSnapshots(): Promise<void> {
    if (this.healthPublish) return this.healthPublish;
    const publish = Promise.allSettled(
      [...this.agents.values()].map((record) => this.publishHealthForAgent(record)),
    ).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.error(`Runtime host health publish failed: ${errorMessage(result.reason)}`);
        }
      }
    });
    this.healthPublish = publish;
    try {
      await publish;
    } finally {
      if (this.healthPublish === publish) this.healthPublish = undefined;
    }
  }

  private async publishHealthForAgent(
    record: ManagedAgent,
    recoveredCommand?: AgentRestartCommand,
  ): Promise<void> {
    const agent = record.config;
    const skipStatus = agentSkipStatus(agent);
    const running = record.running;
    if (skipStatus) {
      if (!running) await this.writeUnknownHealth(agent.id);
      return;
    }
    if (!running) {
      await this.resolveMissingHandleHealth(agent.id);
      return;
    }

    const runtime = running.handle.health?.();
    const health = runtimeHandleHealth(runtime, await this.health.get(agent.id), nowIso());
    const restart = recoveredCommand
      ? health.state === 'healthy'
        ? restartStatus(recoveredCommand, 'recovered', nowIso(), runtime)
        : restartStatus(recoveredCommand, 'failed', nowIso(), runtime, health.reason ?? 'restart_failed')
      : undefined;
    await this.health.writeHealth({
      agentId: agent.id,
      ...(health.reason ? { reason: health.reason } : {}),
      ...(restart ? { restart } : {}),
      ...(runtime ? { runtime } : {}),
      state: health.state,
      updatedAt: health.updatedAt,
    });
  }

  private async resolveMissingHandleHealth(agentId: string): Promise<void> {
    const snapshot = await this.health.get(agentId);
    if (!snapshot) {
      await this.writeUnknownHealth(agentId);
      return;
    }
    const timedOut = startingTimeoutHealth(snapshot, nowIso());
    if (timedOut) {
      await this.health.writeHealth({ agentId, ...timedOut });
      return;
    }
    if (
      snapshot.state === 'unhealthy' &&
      (snapshot.reason === 'start_failed' || snapshot.reason === 'restart_failed')
    ) {
      return;
    }
    await this.writeUnknownHealth(agentId);
  }

  private async writeUnknownHealth(agentId: string): Promise<void> {
    await this.health.writeHealth({
      agentId,
      state: 'unknown',
      updatedAt: nowIso(),
    });
  }

  private async writeFailedHealth(agentId: string, reason: AgentHealthReason): Promise<void> {
    await this.health.writeHealth({
      agentId,
      reason,
      state: 'unhealthy',
      updatedAt: nowIso(),
    });
  }

  private async writeRestartPending(
    agentId: string,
    command: AgentRestartCommand,
    runtime?: AgentRuntimeHandleSnapshot,
  ): Promise<void> {
    await this.health.writeHealth({
      agentId,
      reason: 'restart_pending',
      restart: restartStatus(command, 'pending', nowIso(), runtime),
      ...(runtime ? { runtime } : {}),
      state: 'starting',
      updatedAt: nowIso(),
    });
  }

  private async writeRestartFailed(
    agentId: string,
    command: AgentRestartCommand,
    reason: AgentHealthReason,
  ): Promise<void> {
    await this.health.writeHealth({
      agentId,
      reason,
      restart: restartStatus(command, 'failed', nowIso(), undefined, reason),
      state: 'unhealthy',
      updatedAt: nowIso(),
    });
  }

  private async resolveStaleRestartItem(
    agentId: string,
    runtime: AgentRuntimeHandleSnapshot | undefined,
  ): Promise<void> {
    const queue = wakeQueueServiceForAgent(agentId);
    const stale = await staleRunningItemForAgent(agentId, runtime, queue);
    if (!stale) return;
    await queue.fail(stale.id);
    await queue.requeueAppendedTo(stale.id);
    const current = await this.health.get(agentId);
    await this.health.writeHealth({
      agentId,
      reason: 'restart_pending',
      ...(current?.restart ? { restart: current.restart } : {}),
      state: 'starting',
      updatedAt: nowIso(),
    });
    this.logger.log(`Agent ${agentId}: stale running item ${stale.id} failed before restart.`);
  }

  private logAgentStatus(record: ManagedAgent, status: string, write: () => void): void {
    if (record.lastLoggedStatus === status) return;
    record.lastLoggedStatus = status;
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
          if (!invalidateConfigCacheForWatchEvent(key, path, filename)) return;
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

  private syncRestartCommandWatcher(): void {
    if (this.restartCommandWatcher) return;
    const runDir = this.restartCommands.directory();
    try {
      const watcher = watch(runDir, { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== this.restartCommands.filename()) return;
        this.scheduleConfigReconcile();
      });
      watcher.on('error', (error: unknown) => {
        this.logger.error(`Runtime host restart-command watcher failed for ${runDir}: ${errorMessage(error)}`);
        watcher.close();
        if (this.restartCommandWatcher === watcher) this.restartCommandWatcher = undefined;
      });
      this.restartCommandWatcher = watcher;
    } catch (error) {
      this.logger.error(`Runtime host restart-command watcher failed for ${runDir}: ${errorMessage(error)}`);
    }
  }

  private closeRestartCommandWatcher(): void {
    this.restartCommandWatcher?.close();
    this.restartCommandWatcher = undefined;
  }

  private async shutdownStopOptions(): Promise<Parameters<RunningAgentHandle['stop']>[0]> {
    const restartDrainActive = await isRestartDrainActive().catch(() => false);
    if (!restartDrainActive) return undefined;
    return {
      abortReason: 'restart_drain',
      forceAfterMs: this.forceRestartTimeoutMs,
    };
  }
}

export async function loadRuntimeAgents(opts: RuntimeHostOptions = {}): Promise<AgentConfig[]> {
  if (opts.agent) return [await defaultAgentRegistryService.serviceFor(opts.agent).getConfig()];
  return defaultAgentRegistryService.listAgentConfigs();
}

async function syncSlackDisplayInfoForRuntimeStart(
  agent: AgentConfig,
): Promise<AgentConfig> {
  if (!agent.slack.connected || !agent.slack.botToken) return agent;
  return agentSlackServiceForAgent(agent.id).syncDisplayInfo();
}

async function startAgentFromConfig(
  agent: AgentConfig,
  animaHome: string,
  options: StartAgentOptions,
): Promise<RunningAgentHandle> {
  await validateRunnableAgentConfig(agent);
  const server = runtimeServerConfigForAgent(agent);
  if (server.slack) await validateSlackConnectionForStart(agent.id, server.slack);
  const managedEnv = await managedProviderEnvForAgent(agent, animaHome, server.slack?.botToken);
  const outputLines = [
    server.slack ? 'Slack output: send enabled.' : undefined,
    server.feishu.connected ? 'Feishu output: send enabled.' : undefined,
  ].filter((line): line is string => Boolean(line));
  console.log(
    [
      `Starting Anima agent ${server.config.agentId}.`,
      `State dir: ${server.config.stateDir}`,
      'Reply policy: DMs and @mentions always wake; member channels and involved threads wake unless muted.',
      ...outputLines,
    ].join('\n'),
  );
  return startRunningAgent({
    ...server.config,
    agentRuntime: createAgentRuntime(runtimeWithEnv(server.runtime, managedEnv)),
    ...(server.slack ? { appToken: server.slack.appToken, botToken: server.slack.botToken } : {}),
    feishu: server.feishu,
    ...(server.runtime.idleTimeoutMs !== undefined ? { idleTimeoutMs: server.runtime.idleTimeoutMs } : {}),
    startAbortForceAfterMs: options.forceStopAfterMs,
    startTimeoutMs: options.startTimeoutMs,
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
    feishu: {
      appId: agent.feishu.appId,
      appSecret: agent.feishu.appSecret,
      botOpenId: agent.feishu.botOpenId,
      connected: agent.feishu.connected,
      encryptKey: agent.feishu.encryptKey,
      verificationToken: agent.feishu.verificationToken,
    },
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

export function invalidateConfigCacheForWatchEvent(
  key: string,
  path: string,
  filename: Buffer | string | null,
): boolean {
  if (key === 'agents') return true;
  const name = filename?.toString();
  if (name !== 'config.json') return false;
  cacheDelete(join(path, name));
  return true;
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
  if (isAgentRunnable(agent)) return undefined;
  if (!agent.slack.connected && !agent.feishu.connected) return 'idle / awaiting platform connection';
  return 'idle / incomplete config';
}

function runtimeServerConfigForAgent(agent: AgentConfig): {
  config: RuntimeWorkerConfig;
  feishu: AgentConfig['feishu'];
  runtime: AgentProviderConfig;
  slack?: { appToken: string; botToken: string };
} {
  const slack = agent.slack;
  const config = runtimeWorkerConfigForAgent(agent);
  const botToken = slack.botToken;
  const appToken = slack.appToken;
  const runtime = agent.provider;
  if (!runtime) throw new Error(`Agent ${agent.id}: provider is required`);
  const connectedSlack = slack.connected && botToken && appToken
    ? { appToken, botToken }
    : undefined;
  return {
    config,
    feishu: agent.feishu,
    runtime,
    ...(connectedSlack ? { slack: connectedSlack } : {}),
  };
}

export async function managedProviderEnvForAgent(
  agent: AgentConfig,
  animaHome: string,
  botToken?: string,
  deps: {
    fetchFeishuTenantAccessToken?: (config: AgentConfig['feishu']) => Promise<FeishuTenantAccessToken>;
  } = {},
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    ANIMA_HOME: animaHome,
    ANIMA_RUNTIME_HOME: animaHome,
  };
  if (botToken) {
    env.ANIMA_SLACK_BOT_TOKEN = botToken;
    env.SLACK_BOT_TOKEN = botToken;
  }
  if (!agent.feishu.connected) return env;

  env.FEISHU_API_BASE_URL = FEISHU_OPEN_API_BASE_URL;
  env.FEISHU_APP_ID = agent.feishu.appId;
  env.FEISHU_APP_SECRET = agent.feishu.appSecret;
  if (agent.feishu.botOpenId) env.FEISHU_BOT_OPEN_ID = agent.feishu.botOpenId;

  const token = await (deps.fetchFeishuTenantAccessToken ?? fetchFeishuTenantAccessToken)(agent.feishu);
  env.FEISHU_TENANT_ACCESS_TOKEN = token.tenantAccessToken;
  if (token.expiresAt) env.FEISHU_TENANT_ACCESS_TOKEN_EXPIRES_AT = token.expiresAt;
  return env;
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

async function staleRunningItemForAgent(
  agentId: string,
  runtime: AgentRuntimeHandleSnapshot | undefined,
  queue: Pick<WakeQueueService, 'list'> = wakeQueueServiceForAgent(agentId),
): Promise<InboxItem | undefined> {
  const running = latestPrimaryRunningItem(await queue.list());
  if (!running) return undefined;
  const active = await findActiveRuntimeItem(agentId, queue);
  // Zero grace and the provider-child check: the host is about to fail this
  // item before a restart, so every wedged shape must count as stale.
  const stale = isStaleRunningItem({
    ...(active ? { active } : {}),
    activeItemMismatchGraceMs: 0,
    includeProviderChildCheck: true,
    nowMs: Date.now(),
    runningItemId: running.id,
    runtime,
  });
  return stale ? running : undefined;
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
