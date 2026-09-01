import { isRecord, stringField } from '../json.js';
import { classifyProviderFailureReason } from './provider-failure.js';
import { type RunningChildProcess } from './child-process.js';
import {
  claudeCommonArgs,
  claudeFastModeArgs,
  claudeProviderEnv,
  writeSystemPromptFile,
} from './claude-launch.js';
import { createClaudeJsonlActivityMapper, parseClaudeRuntimeOutput } from './claude-events.js';
import { LineBuffer } from './line-buffer.js';
import { ControllerAgentRuntime } from './provider-runtime.js';
import { QuiescentWaiterSet } from './quiescent-waiters.js';
import { withProviderCliLaunchPermit } from '../provider-cli/launch-gate.js';
import type { ProviderWorkSnapshot } from '../../shared/snapshot.js';
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
const CLAUDE_AUTO_REWAKE_GRACE_MS = 30_000;

export class ClaudeCodeAgentRuntime extends ControllerAgentRuntime<ClaudeStreamJsonController> {
  readonly command: string;
  readonly env: Record<string, string>;
  readonly kind = 'claude-code';
  private readonly config: ClaudeCodeAgentProviderConfig;
  private readonly providerArgs: readonly string[];

  constructor(
    config: ClaudeCodeAgentProviderConfig,
    command: string,
    providerArgs: readonly string[] = [],
  ) {
    super({ providerChildIdleTimeoutMs: config.providerChildIdleTimeoutMs });
    this.config = config;
    this.command = command;
    this.env = claudeProviderEnv(config);
    this.providerArgs = [...providerArgs];
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const jsonlMapper = createClaudeJsonlActivityMapper(input.effects, this.kind, {
      ...(this.config.model ? { model: this.config.model } : {}),
    });
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
        command: this.command,
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
        if (!this.slot.get()?.observes(jsonlMapper)) await jsonlMapper.flush();
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
    return withProviderCliLaunchPermit(
      this.kind,
      input.signal,
      () => this.slot.get() ?? this.spawnController(
        {
          args: this.claudeArgs(input.providerSession, systemPromptFilePath),
          command: this.command,
          label: 'Claude Code runtime',
        },
        input,
        (child) => new ClaudeStreamJsonController(child),
      ),
    );
  }

  private async runTurn(
    input: AgentRuntimeInput,
    jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>,
    prompt = input.prompt,
  ): Promise<string> {
    const controller = await this.ensureController(input);
    const turn = controller.startTurn(input, jsonlMapper);
    const usageRecordCount = jsonlMapper.usageRecordCount();
    try {
      await controller.writeUserMessage(prompt);
      return await turn;
    } catch (error) {
      controller.abortCurrentTurn(error);
      if (jsonlMapper.usageRecordCount() === usageRecordCount) {
        await jsonlMapper.recordUnavailable();
      }
      throw error;
    }
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
    // Raw Runtime Arguments remain the advanced override when they also set
    // `--settings`: Claude Code uses the last CLI settings source wholesale.
    return [...claudeFastModeArgs(this.config), ...this.providerArgs, ...args];
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
  private readonly activeHookIds = new Set<string>();
  private autoRewakePending = false;
  private autoRewakePendingReset?: NodeJS.Timeout;
  private backgroundObserver?: {
    input: AgentRuntimeInput;
    jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>;
  };
  private backgroundTaskCount = 0;
  private visibleBackgroundTaskCount = 0;
  private readonly stdoutLines = new LineBuffer();
  private compacting = false;
  private providerTurnOwner?: 'background' | 'current';
  private providerTurnActive = false;
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
      .then(async ({ stderr, stdout }) => {
        this.clearAutoRewakePending();
        const exitError = new Error('Claude Code runtime exited before queued input reached stdin');
        this.rejectQuiescentWaiters(new Error('Claude Code runtime exited before drain reached a quiescent point'));
        this.rejectQueuedMessages(exitError);
        await this.clearBackgroundObserver();
        const stderrOutput = stderr || this.stderrText;
        if (claudeSessionNotFound(stderrOutput)) {
          this.rejectCurrentTurn(new ClaudeSessionNotFoundError(stderrOutput));
          return;
        }
        this.resolveCurrentTurn(parseClaudeRuntimeOutput(stdout).text ?? '');
      })
      .catch(async (error) => {
        this.clearAutoRewakePending();
        this.rejectQuiescentWaiters(error);
        this.rejectQueuedMessages(error);
        await this.clearBackgroundObserver();
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

  workSnapshot(): ProviderWorkSnapshot | undefined {
    const backgroundTaskCount = this.visibleBackgroundTaskCount + this.activeHookIds.size;
    if (this.providerTurnActive || this.autoRewakePending) {
      return {
        ...(backgroundTaskCount > 0 ? { backgroundTaskCount } : {}),
        state: 'working',
      };
    }
    if (backgroundTaskCount > 0) {
      return { backgroundTaskCount, state: 'background' };
    }
    return undefined;
  }

  observes(jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>): boolean {
    return this.backgroundObserver?.jsonlMapper === jsonlMapper;
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
    return this.quiescentWaiters.waitUntilReady(() => this.isQuiescent(), signal);
  }

  isQuiescent(): boolean {
    return !this.inputGateClosed()
      && this.backgroundTaskCount === 0
      && this.activeHookIds.size === 0
      && !this.providerTurnActive
      && !this.autoRewakePending;
  }

  async acceptStdoutChunk(chunk: string): Promise<void> {
    for (const line of this.stdoutLines.accept(chunk)) {
      const value = this.parseStdoutLine(line);
      // Close or open the stdin gate and select the native turn owner before
      // activity persistence can expose output to a concurrent Anima wake.
      if (value) this.updateInputGate(value);
      const sink = this.outputSink(value);
      sink?.input.onActivity?.();
      await sink?.jsonlMapper.accept(`${line}\n`);
      if (value) await this.acceptStdoutValue(value, this.providerTurnOwner);
    }
  }

  async acceptStderrChunk(chunk: string): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    this.stderrText += chunk;
    turn.input.onActivity?.();
    await turn.input.effects.recordOutput('stderr', chunk);
  }

  private parseStdoutLine(line: string): Record<string, unknown> | undefined {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    return parsed;
  }

  private async acceptStdoutValue(
    parsed: Record<string, unknown>,
    owner: 'background' | 'current' | undefined,
  ): Promise<void> {
    const type = stringField(parsed, 'type');
    if (type === 'system' && stringField(parsed, 'subtype') === 'init') {
      this.startedSession = true;
      const version = stringField(parsed, 'claude_code_version');
      if (version) this.child.setVersion(version);
    }
    const text = textFromClaudeAssistantEvent(parsed);
    if (text && owner !== 'background' && this.currentTurn) this.currentTurn.lastText = text;
    const result = parsed['result'];
    if (type === 'result') {
      this.providerTurnActive = false;
      this.providerTurnOwner = undefined;
      this.clearAutoRewakePending();
      this.compacting = false;
      this.activeToolUseIds.clear();
      this.resolveQuiescentWaitersIfReady();
      const providerError = claudeProviderErrorFromResult(parsed, {
        sideEffectFree: owner !== 'background' && this.currentTurn?.hadProviderToolCall !== true,
      });
      if (providerError) {
        if (owner !== 'background') this.rejectCurrentTurn(providerError);
        if (!this.currentTurn && this.isQuiescent()) await this.clearBackgroundObserver();
        return;
      }
      if (this.flushQueuedMessages() > 0) return;
      if (owner !== 'background') {
        this.resolveCurrentTurn(typeof result === 'string' ? result : this.currentTurn?.lastText ?? '');
      }
      if (!this.currentTurn && this.isQuiescent()) await this.clearBackgroundObserver();
      return;
    }
    this.flushQueuedMessages();
    this.resolveQuiescentWaitersIfReady();
    if (!this.currentTurn && this.isQuiescent()) await this.clearBackgroundObserver();
  }

  private resolveCurrentTurn(value: string): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = undefined;
    if (!this.backgroundObserver && (this.backgroundTaskCount > 0 || this.activeHookIds.size > 0)) {
      this.backgroundObserver = { input: turn.input, jsonlMapper: turn.jsonlMapper };
    }
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

  private outputSink(value: Record<string, unknown> | undefined) {
    if (this.providerTurnOwner === 'background') return this.backgroundObserver ?? this.currentTurn;
    if (this.providerTurnOwner === 'current') return this.currentTurn ?? this.backgroundObserver;
    const subtype = value && stringField(value, 'type') === 'system'
      ? stringField(value, 'subtype')
      : undefined;
    if (
      this.backgroundObserver
      && (subtype === 'background_tasks_changed'
        || subtype === 'hook_response'
        || subtype === 'task_notification')
    ) {
      return this.backgroundObserver;
    }
    return this.currentTurn ?? this.backgroundObserver;
  }

  private updateInputGate(value: Record<string, unknown>): void {
    const type = stringField(value, 'type');
    const subtype = stringField(value, 'subtype');
    if (type === 'system' && subtype === 'background_tasks_changed' && Array.isArray(value['tasks'])) {
      // Claude defines this as a replace-all level signal, so missed task edge events cannot leave stale state.
      const previousCount = this.backgroundTaskCount;
      this.backgroundTaskCount = value['tasks'].length;
      this.visibleBackgroundTaskCount = value['tasks'].filter((task) => (
        !isRecord(task) || task['ambient'] !== true
      )).length;
      if (previousCount > 0 && this.backgroundTaskCount === 0 && !this.currentTurn) {
        this.markAutoRewakePending();
      }
    }
    if (type === 'system' && subtype === 'hook_started') {
      const hookId = stringField(value, 'hook_id');
      if (hookId) this.activeHookIds.add(hookId);
    }
    if (type === 'system' && subtype === 'hook_response') {
      const hookId = stringField(value, 'hook_id');
      if (hookId) this.activeHookIds.delete(hookId);
      if (value['exit_code'] === 2 && !this.currentTurn) this.markAutoRewakePending();
    }
    if (type === 'system' && subtype === 'turn_starting') {
      this.clearAutoRewakePending();
      this.providerTurnActive = true;
      this.providerTurnOwner = stringField(value, 'mode') === 'task-notification'
        ? 'background'
        : this.currentTurn
          ? 'current'
          : 'background';
    }
    if (type === 'system' && subtype === 'task_notification' && stringField(value, 'status') === 'stopped') {
      this.clearAutoRewakePending();
    }
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
        if (this.providerTurnOwner !== 'background' && this.currentTurn) {
          this.currentTurn.hadProviderToolCall = true;
        }
        if (id) this.activeToolUseIds.add(id);
      }
      if (stringField(item, 'type') === 'tool_result') {
        const id = stringField(item, 'tool_use_id');
        if (id) this.activeToolUseIds.delete(id);
      }
    }
  }

  private resolveQuiescentWaitersIfReady(): void {
    this.quiescentWaiters.resolveIfReady(() => this.isQuiescent());
  }

  private markAutoRewakePending(): void {
    this.clearAutoRewakePending();
    this.autoRewakePending = true;
    this.autoRewakePendingReset = setTimeout(() => {
      this.autoRewakePendingReset = undefined;
      this.autoRewakePending = false;
      this.resolveQuiescentWaitersIfReady();
      if (!this.currentTurn && this.isQuiescent()) {
        void this.clearBackgroundObserver().catch(() => {});
      }
    }, CLAUDE_AUTO_REWAKE_GRACE_MS);
    this.autoRewakePendingReset.unref?.();
  }

  private clearAutoRewakePending(): void {
    if (this.autoRewakePendingReset) clearTimeout(this.autoRewakePendingReset);
    this.autoRewakePendingReset = undefined;
    this.autoRewakePending = false;
  }

  private async clearBackgroundObserver(): Promise<void> {
    const observer = this.backgroundObserver;
    this.backgroundObserver = undefined;
    await observer?.jsonlMapper.flush();
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
  // Local TLS/connectivity failures and provider overload clear on their own.
  if (/\b(unable to connect|certificate|overloaded)\b/i.test(input.message)) return true;
  // Anthropic safeguard refusals self-describe as frequent false positives on
  // ordinary conversations; a re-send on the same session usually passes.
  if (/safeguards flagged/i.test(input.message)) return true;
  // Claude Code reports a mid-stream stall as "Response stalled mid-stream" (older builds)
  // or "The response stopped arriving" (current builds); both end the turn without a
  // provider-side retry, so the runtime must resume the session itself.
  if (/\bresponse (?:stalled mid-stream|stopped arriving)\b/i.test(input.message)) return true;
  if (/\bresponse above may be incomplete\b/i.test(input.message)) return true;
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
