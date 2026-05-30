import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord, stringField } from '../json.js';
import { runtimeErrorPayload } from '../activities/format.js';
import { ActiveRuntimeRun } from './active-runtime.js';
import { startChildProcess, type RunningChildProcess } from './child-process.js';
import { createClaudeJsonlActivityMapper, parseClaudeRuntimeOutput } from './claude-events.js';
import {
  CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW,
  providerSessionPayload,
  type ProviderSessionRecord,
  AgentRuntime,
  AgentRuntimeDrainInput,
  AgentRuntimeFollowupInput,
  AgentRuntimeFollowupResult,
  AgentRuntimeInput,
  AgentRuntimeResult,
  ClaudeCodeAgentProviderConfig,
} from './contract.js';

const CLAUDE_COMMAND = 'claude';
const CLAUDE_DEFAULT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW),
};
export const CLAUDE_DISALLOWED_TOOLS = [
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
];
const CLAUDE_TRANSIENT_CONTINUE_PROMPT =
  'The previous provider turn ended with a transient API or transport error after partial progress. Continue from the current conversation state. Do not repeat completed tool calls, Slack messages, file sends, or file edits; inspect state first if needed, then finish the requested task.';

export class ClaudeCodeAgentRuntime implements AgentRuntime {
  readonly env: Record<string, string> | undefined;
  readonly kind = 'claude-code';
  private readonly config: ClaudeCodeAgentProviderConfig;
  private controller?: ClaudeStreamJsonController;
  private readonly activeRun = new ActiveRuntimeRun();

  constructor(config: ClaudeCodeAgentProviderConfig) {
    this.config = config;
    this.env = {
      ...CLAUDE_DEFAULT_ENV,
      ...(config.env ?? {}),
    };
  }

  async close(): Promise<void> {
    await this.resetController();
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    await input.effects.recordRuntime('runtime.started', {
      command: CLAUDE_COMMAND,
      inputFormat: 'stream-json',
      providerSession: providerSessionPayload(input.providerSession, this.kind),
    });
    const jsonlMapper = createClaudeJsonlActivityMapper(input.effects, this.kind);
    const finishRun = this.activeRun.start(input, 'Claude Code', (signal) => void this.resetController(signal));
    try {
      if (!input.providerSession && this.controller?.hasStartedSession()) {
        await this.resetController();
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
              this.controller?.hasStartedSession()
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
        await this.resetController();
        result = await this.runTurn({ ...input, providerSession: undefined }, jsonlMapper);
      }
      await jsonlMapper.flush();
      await input.effects.recordRuntime('runtime.completed');
      return result ? { text: result } : {};
    } catch (error) {
      const flushError = await flushClaudeMapper(jsonlMapper);
      if (!input.suppressFailureRecord) {
        await input.effects.recordRuntime('runtime.failed', {
          ...runtimeErrorPayload(error),
          ...(error instanceof ClaudeProviderError ? {
            failureSource: 'provider',
            providerReason: error.reason,
            retryable: error.retryable,
          } : {}),
          ...(flushError ? { flushError } : {}),
        });
      }
      throw error;
    } finally {
      finishRun();
    }
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    const controller = this.controller;
    if (!this.activeRun.accepts(input)) return { accepted: false };
    if (!controller) return { accepted: false };
    controller.writeUserMessage(input.prompt);
    return { accepted: true, text: 'appended to Claude stream-json stdin' };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    const controller = this.controller;
    if (!this.activeRun.accepts(input)) return;
    if (!controller) return;
    await controller.waitForQuiescent(input.signal);
  }

  private async ensureController(input: AgentRuntimeInput): Promise<ClaudeStreamJsonController> {
    if (this.controller) return this.controller;
    const systemPromptFilePath = await writeSystemPromptFile(input);
    let controller!: ClaudeStreamJsonController;
    controller = new ClaudeStreamJsonController(startChildProcess({
      args: this.claudeArgs(input.providerSession, systemPromptFilePath),
      bufferOutput: false,
      command: CLAUDE_COMMAND,
      cwd: input.cwd,
      env: input.env,
      label: 'Claude Code runtime',
      onStderrChunk: (chunk) => {
        return controller.acceptStderrChunk(chunk);
      },
      onStdoutChunk: async (chunk) => {
        await controller.acceptStdoutChunk(chunk);
      },
    }));
    this.controller = controller;
    controller.completion
      .catch(() => {})
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
      });
    return controller;
  }

  private async runTurn(
    input: AgentRuntimeInput,
    jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>,
    prompt = input.prompt,
  ): Promise<string> {
    const controller = await this.ensureController(input);
    const turn = controller.startTurn(input, jsonlMapper);
    try {
      controller.writeUserMessage(prompt);
    } catch (error) {
      controller.abortCurrentTurn(error);
      throw error;
    }
    return turn;
  }

  private async resetController(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    this.controller = undefined;
    controller.kill(signal);
    await controller.completion.catch(() => {});
  }

  private claudeArgs(providerSession: ProviderSessionRecord | undefined, systemPromptFilePath: string | undefined): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--include-hook-events',
      '--input-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', CLAUDE_DISALLOWED_TOOLS.join(','),
    ];
    if (providerSession) args.push('--resume', providerSession.id);
    if (this.config.model) args.push('--model', this.config.model);
    if (this.config.reasoningEffort) args.push('--effort', this.config.reasoningEffort);
    if (systemPromptFilePath) args.push('--system-prompt-file', systemPromptFilePath);
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

async function writeSystemPromptFile(input: AgentRuntimeInput): Promise<string | undefined> {
  if (!input.systemPrompt || !input.systemPromptFilePath) return undefined;
  await mkdir(dirname(input.systemPromptFilePath), { recursive: true });
  await writeFile(input.systemPromptFilePath, input.systemPrompt, 'utf8');
  return input.systemPromptFilePath;
}

class ClaudeStreamJsonController {
  private readonly activeToolUseIds = new Set<string>();
  private buffer = '';
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
  private readonly queuedMessages: string[] = [];
  private readonly quiescentWaiters = new Set<{
    cleanup(): void;
    reject(error: unknown): void;
    resolve(): void;
  }>();
  private startedSession = false;

  constructor(private readonly child: RunningChildProcess) {
    child.completion
      .then(({ stderr, stdout }) => {
        this.rejectQuiescentWaiters(new Error('Claude Code runtime exited before drain reached a quiescent point'));
        const stderrOutput = stderr || this.stderrText;
        if (claudeSessionNotFound(stderrOutput)) {
          this.rejectCurrentTurn(new ClaudeSessionNotFoundError(stderrOutput));
          return;
        }
        this.resolveCurrentTurn(parseClaudeRuntimeOutput(stdout).text ?? '');
      })
      .catch((error) => {
        this.rejectQuiescentWaiters(error);
        this.rejectCurrentTurn(error);
      });
  }

  get completion(): Promise<{ stdout: string; stderr: string }> {
    return this.child.completion;
  }

  hasStartedSession(): boolean {
    return this.startedSession;
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

  writeUserMessage(text: string): void {
    if (this.inputGateClosed()) {
      this.queuedMessages.push(text);
      return;
    }
    this.sendUserMessage(text);
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
    if (!this.inputGateClosed()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort);
          this.quiescentWaiters.delete(waiter);
        },
        reject: (error: unknown) => {
          waiter.cleanup();
          reject(error);
        },
        resolve: () => {
          waiter.cleanup();
          resolve();
        },
      };
      const onAbort = () => waiter.reject(signal?.reason ?? new Error('Drain wait aborted'));
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Drain wait aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.quiescentWaiters.add(waiter);
    });
  }

  async acceptStdoutChunk(chunk: string): Promise<void> {
    this.currentTurn?.input.onActivity?.();
    await this.currentTurn?.jsonlMapper.accept(chunk);
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.acceptStdoutLine(line);
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
      this.sendUserMessage(message);
      flushed += 1;
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
    if (this.inputGateClosed()) return;
    for (const waiter of [...this.quiescentWaiters]) waiter.resolve();
  }

  private rejectQuiescentWaiters(error: unknown): void {
    for (const waiter of [...this.quiescentWaiters]) waiter.reject(error);
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
