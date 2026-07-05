import { isRecord, stringField } from '../json.js';
import { classifyProviderFailureReason } from './provider-failure.js';
import { type RunningChildProcess } from './child-process.js';
import {
  CLAUDE_COMMAND,
  claudeCommonArgs,
  claudeProviderEnv,
  writeSystemPromptFile,
} from './claude-launch.js';
import { createClaudeJsonlActivityMapper, parseClaudeRuntimeOutput } from './claude-events.js';
import { LineBuffer } from './line-buffer.js';
import { ControllerAgentRuntime } from './provider-runtime.js';
import { QuiescentWaiterSet } from './quiescent-waiters.js';
import {
  providerSessionPayload,
  type ProviderSessionRecord,
  AgentRuntimeFollowupInput,
  AgentRuntimeFollowupResult,
  AgentRuntimeInput,
  AgentRuntimeResult,
  ClaudeCodeAgentProviderConfig,
} from './contract.js';

const CLAUDE_TRANSIENT_CONTINUE_PROMPT =
  'The previous provider turn ended with a transient API or transport error after partial progress. Continue from the current conversation state. Do not repeat completed tool calls, chat messages, file sends, or file edits; inspect state first if needed, then finish the requested task.';

export class ClaudeCodeAgentRuntime extends ControllerAgentRuntime<ClaudeStreamJsonController> {
  readonly env: Record<string, string>;
  readonly kind = 'claude-code';
  private readonly config: ClaudeCodeAgentProviderConfig;

  constructor(config: ClaudeCodeAgentProviderConfig) {
    super({ providerChildIdleTimeoutMs: config.providerChildIdleTimeoutMs });
    this.config = config;
    this.env = claudeProviderEnv(config);
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const jsonlMapper = createClaudeJsonlActivityMapper(input.effects, this.kind);
    return this.runTurnLifecycle(input, {
      failurePayload: async (error) => {
        const flushError = await flushClaudeMapper(jsonlMapper);
        return {
          ...(error instanceof ClaudeProviderError ? {
            failureSource: 'provider',
            providerReason: error.reason,
            retryable: error.retryable,
          } : {}),
          ...(flushError ? { flushError } : {}),
        };
      },
      label: 'Claude Code',
      startedPayload: {
        command: CLAUDE_COMMAND,
        inputFormat: 'stream-json',
      },
      turn: async () => {
        if (!input.providerSession && this.slot.get()?.hasStartedSession()) {
          await this.slot.reset();
        }
        let result: string;
        let retriedProviderError = false;
        let continuedAfterProviderError = false;
        try {
          for (;;) {
            try {
              result = await this.runTurn(input, jsonlMapper);
              break;
            } catch (error) {
              if (
                error instanceof ClaudeProviderError &&
                error.retryable &&
                error.sideEffectFree &&
                !retriedProviderError &&
                !input.signal?.aborted
              ) {
                retriedProviderError = true;
                await input.effects.recordEvent({
                  error: error.message,
                  eventType: 'claude.provider.retry',
                  reason: error.reason,
                  runtimeKind: this.kind,
                });
                continue;
              }
              if (
                error instanceof ClaudeProviderError &&
                error.retryable &&
                !error.sideEffectFree &&
                !continuedAfterProviderError &&
                !input.signal?.aborted &&
                this.slot.get()?.hasStartedSession()
              ) {
                continuedAfterProviderError = true;
                await input.effects.recordEvent({
                  error: error.message,
                  eventType: 'claude.provider.resume_retry',
                  reason: error.reason,
                  runtimeKind: this.kind,
                });
                result = await this.runTurn(input, jsonlMapper, CLAUDE_TRANSIENT_CONTINUE_PROMPT);
                break;
              }
              throw error;
            }
          }
        } catch (error) {
          if (!(error instanceof ClaudeSessionNotFoundError) || !input.providerSession) throw error;
          await input.effects.recordEvent({
            eventType: 'claude.session.resume_missing',
            providerSession: providerSessionPayload(input.providerSession, this.kind),
            runtimeKind: this.kind,
          });
          await this.slot.reset();
          result = await this.runTurn({ ...input, providerSession: undefined }, jsonlMapper);
        }
        await jsonlMapper.flush();
        return result ? { text: result } : {};
      },
    });
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    const controller = this.slot.get();
    if (!this.activeRun.accepts(input)) return { accepted: false };
    if (!controller) return { accepted: false };
    await controller.writeUserMessage(input.prompt);
    return { accepted: true, text: 'appended to Claude stream-json stdin' };
  }

  private async ensureController(input: AgentRuntimeInput): Promise<ClaudeStreamJsonController> {
    const existing = this.slot.get();
    if (existing) return existing;
    const systemPromptFilePath = await writeSystemPromptFile(input);
    return this.spawnController(
      {
        args: this.claudeArgs(input.providerSession, systemPromptFilePath),
        command: CLAUDE_COMMAND,
        label: 'Claude Code runtime',
      },
      input,
      (child) => new ClaudeStreamJsonController(child),
    );
  }

  private async runTurn(
    input: AgentRuntimeInput,
    jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>,
    prompt = input.prompt,
  ): Promise<string> {
    const controller = await this.ensureController(input);
    const turn = controller.startTurn(input, jsonlMapper);
    try {
      await controller.writeUserMessage(prompt);
    } catch (error) {
      controller.abortCurrentTurn(error);
      throw error;
    }
    return turn;
  }

  private claudeArgs(providerSession: ProviderSessionRecord | undefined, systemPromptFilePath: string | undefined): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--include-hook-events',
      '--input-format', 'stream-json',
    ];
    if (providerSession) args.push('--resume', providerSession.id);
    args.push(...claudeCommonArgs(this.config, systemPromptFilePath));
    return args;
  }
}

async function flushClaudeMapper(jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>): Promise<string | undefined> {
  try {
    await jsonlMapper.flush();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

class ClaudeSessionNotFoundError extends Error {
  constructor(stderr: string) {
    super(stderr.trim());
    this.name = 'ClaudeSessionNotFoundError';
  }
}

class ClaudeProviderError extends Error {
  readonly reason: string;
  readonly retryable: boolean;
  readonly sideEffectFree: boolean;

  constructor(input: { message: string; reason: string; retryable: boolean; sideEffectFree: boolean }) {
    super(input.message);
    this.name = 'ClaudeProviderError';
    this.reason = input.reason;
    this.retryable = input.retryable;
    this.sideEffectFree = input.sideEffectFree;
  }
}

function claudeSessionNotFound(stderr: string): boolean {
  return /No conversation found with session ID:/.test(stderr);
}

class ClaudeStreamJsonController {
  private readonly activeToolUseIds = new Set<string>();
  private readonly stdoutLines = new LineBuffer();
  private compacting = false;
  private stderrText = '';
  private currentTurn?: {
    hadProviderToolCall: boolean;
    input: AgentRuntimeInput;
    jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>;
    lastText?: string;
    reject(error: unknown): void;
    resolve(value: string): void;
  };
  private readonly queuedMessages: Array<{
    reject(error: unknown): void;
    resolve(): void;
    text: string;
  }> = [];
  private readonly quiescentWaiters = new QuiescentWaiterSet();
  private startedSession = false;

  constructor(private readonly child: RunningChildProcess) {
    child.completion
      .then(({ stderr, stdout }) => {
        const exitError = new Error('Claude Code runtime exited before queued input reached stdin');
        this.rejectQuiescentWaiters(new Error('Claude Code runtime exited before drain reached a quiescent point'));
        this.rejectQueuedMessages(exitError);
        const stderrOutput = stderr || this.stderrText;
        if (claudeSessionNotFound(stderrOutput)) {
          this.rejectCurrentTurn(new ClaudeSessionNotFoundError(stderrOutput));
          return;
        }
        this.resolveCurrentTurn(parseClaudeRuntimeOutput(stdout).text ?? '');
      })
      .catch((error) => {
        this.rejectQuiescentWaiters(error);
        this.rejectQueuedMessages(error);
        this.rejectCurrentTurn(error);
      });
  }

  get completion(): Promise<{ stdout: string; stderr: string }> {
    return this.child.completion;
  }

  hasStartedSession(): boolean {
    return this.startedSession;
  }

  snapshot() {
    return this.child.snapshot();
  }

  startTurn(
    input: AgentRuntimeInput,
    jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>,
  ): Promise<string> {
    if (this.currentTurn) throw new Error('Claude Code runtime already has an active turn');
    return new Promise((resolve, reject) => {
      this.currentTurn = {
        hadProviderToolCall: false,
        input,
        jsonlMapper,
        reject,
        resolve,
      };
    });
  }

  writeUserMessage(text: string): Promise<void> {
    if (this.inputGateClosed()) {
      return new Promise((resolve, reject) => {
        this.queuedMessages.push({ reject, resolve, text });
      });
    }
    this.sendUserMessage(text);
    return Promise.resolve();
  }

  abortCurrentTurn(error: unknown): void {
    this.rejectCurrentTurn(error);
  }

  private sendUserMessage(text: string): void {
    this.child.writeStdin(`${JSON.stringify({
      message: {
        content: [{ text, type: 'text' }],
        role: 'user',
      },
      type: 'user',
    })}\n`);
  }

  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  waitForQuiescent(signal?: AbortSignal): Promise<void> {
    return this.quiescentWaiters.waitUntilReady(() => !this.inputGateClosed(), signal);
  }

  async acceptStdoutChunk(chunk: string): Promise<void> {
    this.currentTurn?.input.onActivity?.();
    await this.currentTurn?.jsonlMapper.accept(chunk);
    for (const line of this.stdoutLines.accept(chunk)) this.acceptStdoutLine(line);
  }

  async acceptStderrChunk(chunk: string): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    this.stderrText += chunk;
    turn.input.onActivity?.();
    await turn.input.effects.recordOutput('stderr', chunk);
  }

  private acceptStdoutLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const type = stringField(parsed, 'type');
    if (type === 'system' && stringField(parsed, 'subtype') === 'init') {
      this.startedSession = true;
    }
    this.updateInputGate(parsed);
    const text = textFromClaudeAssistantEvent(parsed);
    if (text && this.currentTurn) this.currentTurn.lastText = text;
    const result = parsed['result'];
    if (type === 'result') {
      this.compacting = false;
      this.activeToolUseIds.clear();
      this.resolveQuiescentWaitersIfReady();
      const providerError = claudeProviderErrorFromResult(parsed, {
        sideEffectFree: this.currentTurn?.hadProviderToolCall !== true,
      });
      if (providerError) {
        this.rejectCurrentTurn(providerError);
        return;
      }
      if (this.flushQueuedMessages() > 0) return;
      this.resolveCurrentTurn(typeof result === 'string' ? result : this.currentTurn?.lastText ?? '');
      return;
    }
    this.flushQueuedMessages();
    this.resolveQuiescentWaitersIfReady();
  }

  private resolveCurrentTurn(value: string): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = undefined;
    turn.resolve(value || turn.lastText || '');
  }

  private rejectCurrentTurn(error: unknown): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = undefined;
    turn.reject(error);
  }

  private flushQueuedMessages(): number {
    if (this.inputGateClosed()) return 0;
    let flushed = 0;
    while (this.queuedMessages.length > 0) {
      const message = this.queuedMessages.shift();
      if (!message) continue;
      try {
        this.sendUserMessage(message.text);
        message.resolve();
        flushed += 1;
      } catch (error) {
        message.reject(error);
      }
    }
    return flushed;
  }

  private inputGateClosed(): boolean {
    return this.compacting || this.activeToolUseIds.size > 0;
  }

  private updateInputGate(value: Record<string, unknown>): void {
    const type = stringField(value, 'type');
    const subtype = stringField(value, 'subtype');
    if (type === 'system' && subtype === 'status') {
      if (stringField(value, 'status') === 'compacting') this.compacting = true;
      if (stringField(value, 'compact_result') === 'failed') this.compacting = false;
    }
    if (type === 'system' && subtype === 'compact_boundary') this.compacting = false;

    const message = value['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) return;
    for (const item of message['content']) {
      if (!isRecord(item)) continue;
      if (type === 'assistant' && stringField(item, 'type') === 'tool_use') {
        const id = stringField(item, 'id');
        if (this.currentTurn) this.currentTurn.hadProviderToolCall = true;
        if (id) this.activeToolUseIds.add(id);
      }
      if (stringField(item, 'type') === 'tool_result') {
        const id = stringField(item, 'tool_use_id');
        if (id) this.activeToolUseIds.delete(id);
      }
    }
    this.resolveQuiescentWaitersIfReady();
  }

  private resolveQuiescentWaitersIfReady(): void {
    this.quiescentWaiters.resolveIfReady(() => !this.inputGateClosed());
  }

  private rejectQuiescentWaiters(error: unknown): void {
    this.quiescentWaiters.reject(error);
  }

  private rejectQueuedMessages(error: unknown): void {
    while (this.queuedMessages.length > 0) {
      const message = this.queuedMessages.shift();
      message?.reject(error);
    }
  }
}

function claudeProviderErrorFromResult(
  value: Record<string, unknown>,
  input: { sideEffectFree: boolean },
): ClaudeProviderError | undefined {
  if (stringField(value, 'type') !== 'result') return undefined;
  const subtype = stringField(value, 'subtype');
  if (value['is_error'] !== true && !subtype?.startsWith('error')) return undefined;
  const result = stringField(value, 'result');
  const error = stringField(value, 'error');
  const status = value['api_error_status'];
  const statusText = typeof status === 'number' ? ` (api status ${status})` : '';
  const message = result ?? error ?? subtype ?? 'Claude Code provider error';
  return new ClaudeProviderError({
    message: `${message}${statusText}`,
    reason: claudeProviderErrorReason({ message, status, subtype }),
    retryable: isRetryableClaudeProviderError({ message, status, subtype }),
    sideEffectFree: input.sideEffectFree,
  });
}

function claudeProviderErrorReason(input: { message: string; status: unknown; subtype: string | undefined }): string {
  const classified = classifyProviderFailureReason(input);
  if (classified !== 'provider_error') return classified;
  if (typeof input.status === 'number') return `api_status_${input.status}`;
  if (input.subtype?.startsWith('error')) return input.subtype;
  return 'provider_error';
}

function isRetryableClaudeProviderError(input: { message: string; status: unknown; subtype: string | undefined }): boolean {
  if (typeof input.status === 'number') return input.status === 408 || input.status >= 500;
  if (/\b(socket|connection|timeout|timed out|network|fetch)\b/i.test(input.message)) return true;
  return input.subtype === 'error_during_execution';
}

function textFromClaudeAssistantEvent(value: Record<string, unknown>): string | undefined {
  if (stringField(value, 'type') !== 'assistant') return undefined;
  const message = value['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return undefined;
  const parts = message['content']
    .map((item) => {
      if (!isRecord(item) || stringField(item, 'type') !== 'text') return undefined;
      return stringField(item, 'text');
    })
    .filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join('\n') : undefined;
}
