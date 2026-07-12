import type { ProviderChildHealthSnapshot } from '../../shared/snapshot.js';
import { runtimeErrorPayload } from '../activities/format.js';
import { ActiveRuntimeRun } from './active-runtime.js';
import { startChildProcess, type RunningChildProcess } from './child-process.js';
import { ProviderControllerSlot } from './controller-slot.js';
import {
  providerSessionPayload,
  type AgentRuntime,
  type AgentRuntimeCloseOptions,
  type AgentRuntimeDrainInput,
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeHealth,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
} from './contract.js';

interface ControllerAgentRuntimeOptions {
  providerChildIdleTimeoutMs?: number;
}

export interface ProviderTurnController {
  completion: Promise<unknown>;
  acceptStderrChunk(chunk: string): Promise<void>;
  acceptStdoutChunk(chunk: string): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
  snapshot(): ProviderChildHealthSnapshot;
  waitForQuiescent(signal?: AbortSignal): Promise<void>;
}

// Shared lifecycle for provider adapters that keep one long-lived child-process
// controller per runtime: controller slot ownership, active-run tracking,
// close/health/drain, and the runtime.started/completed/failed envelope.
// Claude (stream-json), Codex, Grok, and Kimi share this plumbing.
export abstract class ControllerAgentRuntime<C extends ProviderTurnController> implements AgentRuntime {
  abstract readonly env: Record<string, string> | undefined;
  abstract readonly kind: string;
  protected readonly slot = new ProviderControllerSlot<C>();
  protected readonly activeRun = new ActiveRuntimeRun();
  private providerChildIdleReset?: NodeJS.Timeout;

  constructor(private readonly options: ControllerAgentRuntimeOptions = {}) {}

  abstract run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
  abstract appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult>;

  async close(options: AgentRuntimeCloseOptions = {}): Promise<void> {
    this.cancelProviderChildIdleReset();
    await this.slot.reset(options.signal, options);
  }

  health(): AgentRuntimeHealth {
    const controller = this.slot.get();
    return {
      ...(controller ? { child: controller.snapshot() } : {}),
      childExpected: this.activeRun.isActive(),
    };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    if (!this.activeRun.accepts(input)) return;
    const controller = this.slot.get();
    if (!controller) return;
    await controller.waitForQuiescent(input.signal);
  }

  protected spawnController(
    spawn: { args: string[]; command: string; label: string },
    input: AgentRuntimeInput,
    create: (child: RunningChildProcess) => C,
  ): C {
    this.cancelProviderChildIdleReset();
    let controller!: C;
    controller = create(
      startChildProcess({
        args: spawn.args,
        bufferOutput: false,
        command: spawn.command,
        cwd: input.cwd,
        env: input.env,
        label: spawn.label,
        onStderrChunk: (chunk) => controller.acceptStderrChunk(chunk),
        onStdoutChunk: (chunk) => controller.acceptStdoutChunk(chunk),
      }),
    );
    return this.slot.install(controller);
  }

  protected async runTurnLifecycle(
    input: AgentRuntimeInput,
    options: {
      abort?(signal?: NodeJS.Signals): Promise<void> | void;
      beforeFinishRun?(): void;
      // Invoked on every failure, before the suppressFailureRecord check, so
      // adapters can run failure-time side effects (e.g. mapper flush).
      failurePayload?(error: unknown): Promise<Record<string, unknown>>;
      label: string;
      startedPayload: Record<string, unknown>;
      turn(): Promise<AgentRuntimeResult>;
    },
  ): Promise<AgentRuntimeResult> {
    this.cancelProviderChildIdleReset();
    let finishRun: (() => void) | undefined;
    try {
      await input.effects.recordRuntime('runtime.started', {
        ...options.startedPayload,
        providerSession: providerSessionPayload(input.providerSession, this.kind),
      });
      finishRun = this.activeRun.start(
        input,
        options.label,
        (signal) => options.abort?.(signal) ?? this.slot.reset(signal),
      );
      const result = await options.turn();
      await input.effects.recordRuntime('runtime.completed');
      return result;
    } catch (error) {
      const failurePayload = await options.failurePayload?.(error);
      if (!input.suppressFailureRecord) {
        await input.effects.recordRuntime('runtime.failed', {
          ...runtimeErrorPayload(error),
          ...(failurePayload ?? {}),
        });
      }
      throw error;
    } finally {
      if (finishRun) {
        options.beforeFinishRun?.();
        finishRun();
      }
      this.scheduleProviderChildIdleReset();
    }
  }

  private cancelProviderChildIdleReset(): void {
    if (!this.providerChildIdleReset) return;
    clearTimeout(this.providerChildIdleReset);
    this.providerChildIdleReset = undefined;
  }

  private scheduleProviderChildIdleReset(): void {
    this.cancelProviderChildIdleReset();
    const timeoutMs = this.options.providerChildIdleTimeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    const controller = this.slot.get();
    if (!controller || this.activeRun.isActive()) return;

    this.providerChildIdleReset = setTimeout(() => {
      this.providerChildIdleReset = undefined;
      if (this.activeRun.isActive() || this.slot.get() !== controller) return;
      void this.slot.reset().catch(() => {});
    }, timeoutMs);
    this.providerChildIdleReset.unref?.();
  }
}
