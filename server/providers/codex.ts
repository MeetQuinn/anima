import { nowIso } from '../ids.js';
import { runtimeErrorPayload } from '../activities/format.js';
import { ActiveRuntimeRun } from './active-runtime.js';
import { startChildProcess } from './child-process.js';
import { CodexAppServerController } from './codex-app-server.js';
import {
  providerSessionPayload,
  type AgentRuntime,
  type AgentRuntimeDrainInput,
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type CodexCliAgentProviderConfig,
} from './contract.js';

const CODEX_COMMAND = 'codex';

export class CodexCliAgentRuntime implements AgentRuntime {
  readonly env: Record<string, string> | undefined;
  readonly kind = 'codex-cli';
  private readonly config: CodexCliAgentProviderConfig;
  private controller?: CodexAppServerController;
  private readonly activeRun = new ActiveRuntimeRun();

  constructor(config: CodexCliAgentProviderConfig) {
    this.config = config;
    this.env = config.env;
  }

  async close(): Promise<void> {
    await this.resetController();
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    await input.effects.recordRuntime('runtime.started', {
      command: CODEX_COMMAND,
      providerSession: providerSessionPayload(input.providerSession, this.kind),
      transport: 'app-server',
    });

    const finishRun = this.activeRun.start(input, 'Codex', (signal) => void this.resetController(signal));
    try {
      if (!input.providerSession && this.controller?.threadId) {
        await this.resetController();
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
      this.controller?.detachRun(input);
      finishRun();
    }
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    if (!this.activeRun.accepts(input)) return { accepted: false };
    const controller = this.controller;
    if (!controller) return { accepted: false };
    const turnId = await controller.waitForActiveTurnId();
    await controller.request('turn/steer', {
      expectedTurnId: turnId,
      input: [codexTextInput(input.prompt)],
      threadId: controller.threadId,
    });
    return { accepted: true, text: `appended to ${turnId}` };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    if (!this.activeRun.accepts(input)) return;
    const controller = this.controller;
    if (!controller) return;
    await controller.waitForQuiescent(input.signal);
  }

  private ensureController(input: AgentRuntimeInput): CodexAppServerController {
    if (this.controller) return this.controller;
    let controller!: CodexAppServerController;
    controller = new CodexAppServerController(
      startChildProcess({
        args: ['app-server', '--listen', 'stdio://'],
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
    this.controller = controller;
    controller.completion
      .catch(() => {})
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
      });
    return controller;
  }

  private async resetController(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    this.controller = undefined;
    controller.kill(signal);
    await controller.completion.catch(() => {});
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

function codexTextInput(text: string): Record<string, unknown> {
  return { text, text_elements: [], type: 'text' };
}
