import { nowIso } from '../ids.js';
import { CodexAppServerController } from './codex-app-server.js';
import { ControllerAgentRuntime } from './provider-runtime.js';
import { withProviderCliLaunchPermit } from '../provider-cli/launch-gate.js';
import {
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type CodexCliAgentProviderConfig,
} from './contract.js';
import {
  ProviderSessionCorruptionError,
  type ProviderSessionCorruptionReason,
} from './session-corruption.js';

const CODEX_COMMAND = 'codex';
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT_ENV = 'ANIMA_CODEX_AUTO_COMPACT_TOKEN_LIMIT';
export const CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 240000;
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE = 'total';
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
  private pendingSessionCorruption?: ProviderSessionCorruptionReason;
  private resumedProviderSessionId?: string;

  constructor(config: CodexCliAgentProviderConfig) {
    super({ providerChildIdleTimeoutMs: config.providerChildIdleTimeoutMs });
    this.config = config;
    this.env = config.env;
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.resumedProviderSessionId = input.providerSession?.id;
    this.pendingSessionCorruption = undefined;
    try {
      return await this.runTurnLifecycle(input, {
        beforeFinishRun: () => this.slot.get()?.detachRun(input),
        label: 'Codex',
        startedPayload: {
          command: CODEX_COMMAND,
          transport: 'app-server',
        },
        turn: async () => {
          try {
            if (!input.providerSession && this.slot.get()?.threadId) {
              await this.slot.reset();
            }
            const controller = await this.ensureController(input);
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
          } catch (error) {
            throw this.sessionCorruptionError(error) ?? error;
          }
        },
      });
    } finally {
      this.pendingSessionCorruption = undefined;
      this.resumedProviderSessionId = undefined;
    }
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    if (!this.activeRun.accepts(input)) return { accepted: false };
    const controller = this.slot.get();
    if (!controller) return { accepted: false, retryable: true };
    const activeTurnId = controller.activeTurnId();
    if (!activeTurnId) return { accepted: false, retryable: true };
    const turnId = await activeTurnId;
    try {
      await controller.request('turn/steer', {
        expectedTurnId: turnId,
        input: [codexTextInput(input.prompt)],
        threadId: controller.threadId,
      });
    } catch (error) {
      if (isCodexTurnSteerDesyncError(error)) {
        this.markSessionCorruption('turn_desync');
        await this.slot.reset();
      }
      throw error;
    }
    return { accepted: true, text: `appended to ${turnId}` };
  }

  private async ensureController(input: AgentRuntimeInput): Promise<CodexAppServerController> {
    const existing = this.slot.get();
    if (existing) return existing;
    return withProviderCliLaunchPermit(
      this.kind,
      input.signal,
      () => this.slot.get() ?? this.spawnController(
        {
          args: codexAppServerArgs(this.env),
          command: CODEX_COMMAND,
          label: 'Codex app-server runtime',
        },
        input,
        (child) => new CodexAppServerController(
          child,
          this.kind,
          (reason) => this.markSessionCorruption(reason),
        ),
      ),
    );
  }

  private markSessionCorruption(reason: ProviderSessionCorruptionReason): void {
    if (!this.resumedProviderSessionId || this.pendingSessionCorruption) return;
    this.pendingSessionCorruption = reason;
  }

  private sessionCorruptionError(error: unknown): ProviderSessionCorruptionError | undefined {
    const providerSessionId = this.resumedProviderSessionId;
    if (!providerSessionId) return undefined;
    const reason = this.pendingSessionCorruption
      ?? (codexMissingToolOutputMessage(error) ? 'missing_tool_output' : undefined);
    return reason ? new ProviderSessionCorruptionError(providerSessionId, reason, error) : undefined;
  }

  private threadParams(input: AgentRuntimeInput): Record<string, unknown> {
    const config = {
      model_auto_compact_token_limit: codexAutoCompactTokenLimitFor(this.env),
      model_auto_compact_token_limit_scope: CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
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

export function codexAutoCompactTokenLimitFor(
  env: Record<string, string> | undefined,
): number {
  const configured = env?.[CODEX_AUTO_COMPACT_TOKEN_LIMIT_ENV];
  if (configured === undefined) return CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT;
  if (!/^\d+$/.test(configured)) {
    throw new Error(`${CODEX_AUTO_COMPACT_TOKEN_LIMIT_ENV} must be a positive integer`);
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${CODEX_AUTO_COMPACT_TOKEN_LIMIT_ENV} must be a positive integer`);
  }
  return value;
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

function codexMissingToolOutputMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Custom tool call output is missing for call id:\s*call_[A-Za-z0-9_-]+/i.test(message);
}
