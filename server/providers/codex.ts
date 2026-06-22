import { nowIso } from '../ids.js';
import { runtimeErrorPayload } from '../activities/format.js';
import { ActiveRuntimeRun } from './active-runtime.js';
import { startChildProcess } from './child-process.js';
import { CodexAppServerController } from './codex-app-server.js';
import { ProviderControllerSlot } from './controller-slot.js';
import {
  providerSessionPayload,
  type AgentRuntimeCloseOptions,
  type AgentRuntime,
  type AgentRuntimeDrainInput,
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeHealth,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type CodexCliAgentProviderConfig,
} from './contract.js';

const CODEX_COMMAND = 'codex';
const CODEX_TOOL_ENV_BASE_INCLUDE = [
  'COLORTERM',
  'HOME',
  'LANG',
  'LC_*',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'PWD',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
];

export class CodexCliAgentRuntime implements AgentRuntime {
  readonly env: Record<string, string> | undefined;
  readonly kind = 'codex-cli';
  private readonly config: CodexCliAgentProviderConfig;
  private readonly slot = new ProviderControllerSlot<CodexAppServerController>();
  private readonly activeRun = new ActiveRuntimeRun();

  constructor(config: CodexCliAgentProviderConfig) {
    this.config = config;
    this.env = config.env;
  }

  async close(options: AgentRuntimeCloseOptions = {}): Promise<void> {
    await this.slot.reset(options.signal, options);
  }

  health(): AgentRuntimeHealth {
    const controller = this.slot.get();
    return {
      ...(controller ? { child: controller.snapshot() } : {}),
      childExpected: this.activeRun.isActive(),
    };
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    await input.effects.recordRuntime('runtime.started', {
      command: CODEX_COMMAND,
      providerSession: providerSessionPayload(input.providerSession, this.kind),
      transport: 'app-server',
    });

    const finishRun = this.activeRun.start(input, 'Codex', (signal) => void this.slot.reset(signal));
    try {
      if (!input.providerSession && this.slot.get()?.threadId) {
        await this.slot.reset();
      }
      const controller = this.ensureController(input);
      controller.attachRun(input);
      const thread = await controller.ensureThread(input, this.threadParams(input));
      await input.effects.persistProviderSession({
        id: thread.id,
        updatedAt: nowIso(),
      });

      const result = await controller.startTurn({
        input: [codexTextInput(input.prompt)],
        threadId: thread.id,
      }, input, (text) => input.effects.recordAgentText(text));
      await input.effects.recordRuntime('runtime.completed');
      return { text: result.trim() };
    } catch (error) {
      if (!input.suppressFailureRecord) {
        await input.effects.recordRuntime('runtime.failed', runtimeErrorPayload(error));
      }
      throw error;
    } finally {
      this.slot.get()?.detachRun(input);
      finishRun();
    }
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    if (!this.activeRun.accepts(input)) return { accepted: false };
    const controller = this.slot.get();
    if (!controller) return { accepted: false };
    const turnId = await controller.waitForActiveTurnId();
    try {
      await controller.request('turn/steer', {
        expectedTurnId: turnId,
        input: [codexTextInput(input.prompt)],
        threadId: controller.threadId,
      });
    } catch (error) {
      if (isCodexTurnSteerDesyncError(error)) await this.slot.reset();
      throw error;
    }
    return { accepted: true, text: `appended to ${turnId}` };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    if (!this.activeRun.accepts(input)) return;
    const controller = this.slot.get();
    if (!controller) return;
    await controller.waitForQuiescent(input.signal);
  }

  private ensureController(input: AgentRuntimeInput): CodexAppServerController {
    const existing = this.slot.get();
    if (existing) return existing;
    let controller!: CodexAppServerController;
    controller = new CodexAppServerController(
      startChildProcess({
        args: codexAppServerArgs(this.env),
        bufferOutput: false,
        command: CODEX_COMMAND,
        cwd: input.cwd,
        env: input.env,
        label: 'Codex app-server runtime',
        onStderrChunk: (chunk) => controller.acceptStderrChunk(chunk),
        onStdoutChunk: (chunk) => controller.acceptStdoutChunk(chunk),
      }),
      this.kind,
    );
    return this.slot.install(controller);
  }

  private threadParams(input: AgentRuntimeInput): Record<string, unknown> {
    const config = {
      ...(this.config.reasoningEffort ? { model_reasoning_effort: this.config.reasoningEffort } : {}),
      model_reasoning_summary: this.config.reasoningSummary ?? 'auto',
    };
    return {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.systemPrompt ? { developerInstructions: input.systemPrompt } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      config,
    };
  }
}

export function codexAppServerArgs(env: Record<string, string> | undefined): string[] {
  return [
    'app-server',
    '-c',
    'shell_environment_policy.inherit=all',
    '-c',
    'shell_environment_policy.ignore_default_excludes=true',
    '-c',
    `shell_environment_policy.include_only=${JSON.stringify(codexToolEnvIncludeList(env))}`,
    '--listen',
    'stdio://',
  ];
}

export function codexToolEnvIncludeList(env: Record<string, string> | undefined): string[] {
  return Array.from(new Set([
    ...CODEX_TOOL_ENV_BASE_INCLUDE,
    ...Object.keys(env ?? {}),
  ])).sort((a, b) => a.localeCompare(b));
}

function codexTextInput(text: string): Record<string, unknown> {
  return { text, text_elements: [], type: 'text' };
}

function isCodexTurnSteerDesyncError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /expected active turn id/i.test(message) || /no active turn to steer/i.test(message);
}
