import { nowIso } from '../ids.js';
import { CodexAppServerController } from './codex-app-server.js';
import { ControllerAgentRuntime } from './provider-runtime.js';
import {
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
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

export class CodexCliAgentRuntime extends ControllerAgentRuntime<CodexAppServerController> {
  readonly env: Record<string, string> | undefined;
  readonly kind = 'codex-cli';
  private readonly config: CodexCliAgentProviderConfig;

  constructor(config: CodexCliAgentProviderConfig) {
    super();
    this.config = config;
    this.env = config.env;
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    return this.runTurnLifecycle(input, {
      beforeFinishRun: () => this.slot.get()?.detachRun(input),
      label: 'Codex',
      startedPayload: {
        command: CODEX_COMMAND,
        transport: 'app-server',
      },
      turn: async () => {
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
        return { text: result.trim() };
      },
    });
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

  private ensureController(input: AgentRuntimeInput): CodexAppServerController {
    const existing = this.slot.get();
    if (existing) return existing;
    return this.spawnController(
      {
        args: codexAppServerArgs(this.env),
        command: CODEX_COMMAND,
        label: 'Codex app-server runtime',
      },
      input,
      (child) => new CodexAppServerController(child, this.kind),
    );
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
