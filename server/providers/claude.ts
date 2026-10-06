import { randomUUID } from 'node:crypto';
import { ClaudeBackgroundEvidence } from './claude-background-evidence.js';
import { observeInputTrace } from './input-trace.js';
import { isRecord, stringField } from '../json.js';
import { classifyProviderFailureReason, ProviderTurnFailedError } from './provider-failure.js';
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
  AgentRuntimeInputTraceContext,
  AgentRuntimeInputReceipt,
  AgentRuntimeFollowupInput,
  AgentRuntimeFollowupResult,
  AgentRuntimeInput,
  AgentRuntimeResult,
  ClaudeCodeAgentProviderConfig,
} from './contract.js';

const CLAUDE_TRANSIENT_CONTINUE_PROMPT =
  'The previous provider turn ended with a transient API or transport error after partial progress. Continue from the current conversation state. Do not repeat completed tool calls, chat messages, file sends, or file edits; inspect state first if needed, then finish the requested task.';
const CLAUDE_AUTO_REWAKE_GRACE_MS = 30_000;
const CLAUDE_INPUT_COMPLETION_GRACE_MS = 30_000;

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
    if (!controller?.hasCurrentTurn()) return { accepted: false };
    const inputReceipt = await controller.writeUserMessage(input.prompt, input);
    return { accepted: true, inputReceipt, text: 'appended to Claude stream-json stdin' };
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
      const context = { batchId: randomUUID(), activeItemId: input.itemId, itemIds: [input.itemId] };
      observeInputTrace((payload) => input.effects.recordEvent(payload), { phase: 'input.prepared', context });
      await controller.writeUserMessage(prompt, context);
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
  private readonly controllerInstanceId = randomUUID();
  private readonly activeToolUseIds = new Set<string>();
  private readonly activeHookIds = new Set<string>();
  private readonly backgroundEvidence = new ClaudeBackgroundEvidence();
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
  private commandLifecycleAvailable = false;
  private inputCompletionTimeout?: NodeJS.Timeout;
  private nativeResultCount = 0;
  private providerTurnOwner?: 'background' | 'current';
  private providerTurnActive = false;
  private stderrText = '';
  private currentTurn?: {
    commands: Map<string, {
      startedAfterResult?: number;
      completed: boolean;
      context: AgentRuntimeInputTraceContext;
      receipt: AgentRuntimeInputReceipt;
    }>;
    hadProviderToolCall: boolean;
    input: AgentRuntimeInput;
    jsonlMapper: ReturnType<typeof createClaudeJsonlActivityMapper>;
    lastText?: string;
    lastResult?: string;
    reject(error: unknown): void;
    resolve(value: string): void;
  };
  private readonly queuedMessages: Array<{
    reject(error: unknown): void;
    resolve(receipt: AgentRuntimeInputReceipt): void;
    context: AgentRuntimeInputTraceContext;
    text: string;
  }> = [];
  private readonly quiescentWaiters = new QuiescentWaiterSet();
  private startedSession = false;

  constructor(private readonly child: RunningChildProcess) {
    void child.completion.then(
      () => this.observeExitGap(),
      () => this.observeExitGap(),
    );
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
        if (this.commandLifecycleAvailable && this.currentTurn) {
          this.rejectCurrentTurn(new Error('Claude Code runtime exited before sent input completion was confirmed'));
        } else {
          this.resolveCurrentTurn(parseClaudeRuntimeOutput(stdout).text ?? '');
        }
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

  hasCurrentTurn(): boolean {
    return this.currentTurn !== undefined;
  }

  snapshot() {
    return this.child.snapshot();
  }

  workSnapshot(): ProviderWorkSnapshot | undefined {
    const backgroundTaskCount = this.visibleBackgroundTaskCount + this.activeHookIds.size;
    const evidence = this.backgroundEvidence.snapshot();
    const hookIds = [...this.activeHookIds].filter((id) => /^[a-zA-Z0-9_.-]{1,128}$/.test(id)).slice(0, 32);
    const hooks = this.activeHookIds.size > 0 ? {
      backgroundHookIds: hookIds,
      backgroundHookIdsTruncated: hookIds.length < this.activeHookIds.size,
    } : {};
    if (this.providerTurnActive || this.autoRewakePending || (this.currentTurn?.commands.size ?? 0) > 0) {
      return {
        ...(backgroundTaskCount > 0 ? { backgroundTaskCount } : {}),
        ...(evidence ? { backgroundEvidence: evidence } : {}),
        ...hooks,
        state: 'working',
      };
    }
    if (backgroundTaskCount > 0) {
      return { backgroundTaskCount, ...(evidence ? { backgroundEvidence: evidence } : {}), ...hooks, state: 'background' };
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
        commands: new Map(),
        hadProviderToolCall: false,
        input,
        jsonlMapper,
        reject,
        resolve,
      };
    });
  }

  writeUserMessage(text: string, context: AgentRuntimeInputTraceContext): Promise<AgentRuntimeInputReceipt> {
    if (this.inputGateClosed()) {
      return new Promise((resolve, reject) => {
        this.queuedMessages.push({ context, reject, resolve, text });
      });
    }
    return Promise.resolve(this.sendUserMessage(text, context));
  }

  abortCurrentTurn(error: unknown): void {
    this.rejectCurrentTurn(error);
  }

  private sendUserMessage(text: string, context: AgentRuntimeInputTraceContext): AgentRuntimeInputReceipt {
    const uuid = randomUUID();
    const turn = this.currentTurn;
    const receipt = { controllerInstanceId: this.controllerInstanceId, nativeInputId: uuid };
    const traceContext = { batchId: context.batchId, activeItemId: context.activeItemId, itemIds: [...context.itemIds] };
    turn?.commands.set(uuid, { completed: false, context: traceContext, receipt });
    try {
      this.child.writeStdin(`${JSON.stringify({
        message: {
          content: [{ text, type: 'text' }],
          role: 'user',
        },
        type: 'user',
        uuid,
      })}\n`);
    } catch (error) {
      turn?.commands.delete(uuid);
      if (turn) observeInputTrace((payload) => turn.input.effects.recordEvent(payload), {
        phase: 'input.rejected_before_write', context: traceContext,
      });
      throw error;
    }
    if (turn) observeInputTrace((payload) => turn.input.effects.recordEvent(payload), {
      phase: 'input.written', context: traceContext, receipt,
    });
    return receipt;
  }

  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  waitForQuiescent(signal?: AbortSignal): Promise<void> {
    return this.quiescentWaiters.waitUntilReady(() => this.isQuiescent(), signal);
  }

  isQuiescent(): boolean {
    return !this.compacting
      && this.activeToolUseIds.size === 0
      && this.queuedMessages.length === 0
      && (this.currentTurn?.commands.size ?? 0) === 0
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
      if (value) {
        this.updateInputGate(value);
        this.refreshInputCompletionTimeout();
        this.observeNativeLifecycle(value);
      }
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
    if (type === 'command_lifecycle') {
      const uuid = stringField(parsed, 'command_uuid');
      const state = stringField(parsed, 'state');
      if (uuid && this.currentTurn?.commands.has(uuid)
        && (state === 'cancelled' || state === 'discarded' || state === 'refused')) {
        const error = new Error(`Claude Code input ${state}; sent input must not be automatically replayed`);
        this.rejectQueuedMessages(error);
        this.rejectCurrentTurn(error);
        this.child.kill();
        return;
      }
      this.flushQueuedMessages();
      this.resolveCompletedInputTurn();
      this.refreshInputCompletionTimeout();
      this.resolveQuiescentWaitersIfReady();
      return;
    }
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
      const resultSink = owner === 'background'
        ? this.backgroundObserver ?? this.currentTurn
        : this.currentTurn ?? this.backgroundObserver;
      const effects = resultSink?.input.effects;
      const providerError = claudeProviderErrorFromResult(parsed, {
        sideEffectFree: owner !== 'background' && this.currentTurn?.hadProviderToolCall !== true,
      });
      if (effects) observeInputTrace((payload) => effects.recordEvent(payload), {
        // Controller-level evidence only: an old/background result must not
        // acquire the batch or UUID of a pending human input.
        phase: 'result.observed', controllerInstanceId: this.controllerInstanceId,
        resultOrdinal: this.nativeResultCount + (owner !== 'background' && !providerError ? 1 : 0), owner: owner ?? 'unknown',
      });
      if (providerError) {
        if (owner !== 'background') {
          this.rejectQueuedMessages(providerError);
          this.rejectCurrentTurn(providerError);
        }
        if (!this.currentTurn && this.isQuiescent()) await this.clearBackgroundObserver();
        return;
      }
      const flushed = this.flushQueuedMessages();
      if (owner !== 'background') {
        this.nativeResultCount += 1;
        if (this.currentTurn) {
          this.currentTurn.lastResult = typeof result === 'string' ? result : this.currentTurn.lastText ?? '';
        }
        if (this.commandLifecycleAvailable) {
          this.resolveCompletedInputTurn();
          this.refreshInputCompletionTimeout();
        } else if (flushed === 0) {
          this.resolveCurrentTurn(typeof result === 'string' ? result : this.currentTurn?.lastText ?? '');
        }
      }
      if (!this.currentTurn && this.isQuiescent()) await this.clearBackgroundObserver();
      return;
    }
    this.flushQueuedMessages();
    this.refreshInputCompletionTimeout();
    this.resolveQuiescentWaitersIfReady();
    if (!this.currentTurn && this.isQuiescent()) await this.clearBackgroundObserver();
  }

  private resolveCurrentTurn(value: string): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.clearInputCompletionTimeout();
    this.currentTurn = undefined;
    if (!this.backgroundObserver && (this.backgroundTaskCount > 0 || this.activeHookIds.size > 0)) {
      this.backgroundObserver = { input: turn.input, jsonlMapper: turn.jsonlMapper };
    }
    turn.resolve(value || turn.lastText || '');
    this.resolveQuiescentWaitersIfReady();
  }

  private rejectCurrentTurn(error: unknown): void {
    const turn = this.currentTurn;
    if (!turn) return;
    if (this.commandLifecycleAvailable && turn.commands.size > 1) {
      // A failed native turn may leave already-written followups unconsumed.
      // Stop this process and require a decision instead of replaying the wake
      // or continuing on a session that still owns those inputs.
      const message = error instanceof Error ? error.message : String(error);
      error = new ProviderTurnFailedError(`Claude Code failed after followup input was sent: ${message}`);
      this.child.kill();
    }
    this.clearInputCompletionTimeout();
    this.currentTurn = undefined;
    turn.reject(error);
    this.resolveQuiescentWaitersIfReady();
    // Rejection discards the control map before the process may exit. Preserve
    // written identities at this actual failure point, without claiming exit,
    // native cancellation, or permission to replay any input.
    for (const command of turn.commands.values()) {
      observeInputTrace((payload) => turn.input.effects.recordEvent(payload), {
        phase: 'input.run_failed', context: command.context, receipt: command.receipt,
      });
    }
  }

  private flushQueuedMessages(): number {
    if (this.inputGateClosed()) return 0;
    let flushed = 0;
    while (this.queuedMessages.length > 0) {
      const message = this.queuedMessages.shift();
      if (!message) continue;
      try {
        const receipt = this.sendUserMessage(message.text, message.context);
        message.resolve(receipt);
        flushed += 1;
      } catch (error) {
        message.reject(error);
      }
    }
    return flushed;
  }

  private observeNativeLifecycle(value: Record<string, unknown>): void {
    if (stringField(value, 'type') !== 'command_lifecycle') return;
    const uuid = stringField(value, 'command_uuid');
    const turn = this.currentTurn;
    const command = uuid && turn?.commands.get(uuid);
    const state = stringField(value, 'state');
    if (!command || !turn || !state
      || !['queued', 'started', 'completed', 'cancelled', 'discarded', 'refused'].includes(state)) return;
    observeInputTrace((payload) => turn.input.effects.recordEvent(payload), {
      phase: 'input.native_lifecycle', context: command.context, receipt: command.receipt,
      nativeState: state, resultOrdinal: this.nativeResultCount,
    });
  }

  private observeExitGap(): void {
    const turn = this.currentTurn;
    if (!turn) return;
    for (const command of turn.commands.values()) {
      if (command.completed && command.startedAfterResult !== undefined
        && this.nativeResultCount > command.startedAfterResult) continue;
      observeInputTrace((payload) => turn.input.effects.recordEvent(payload), {
        phase: 'input.unconfirmed_on_exit', context: command.context, receipt: command.receipt,
      });
    }
  }

  private inputGateClosed(): boolean {
    // The UUID lifecycle is an internal CLI capability: only bypass the tool
    // gate after this process has demonstrated it for one of our own inputs.
    return this.compacting || (!this.commandLifecycleAvailable && this.activeToolUseIds.size > 0);
  }

  private updateCommandLifecycle(value: Record<string, unknown>): void {
    const uuid = stringField(value, 'command_uuid');
    const command = uuid && this.currentTurn?.commands.get(uuid);
    const state = stringField(value, 'state');
    if (!command || !state) return;
    if (!['queued', 'started', 'completed', 'cancelled', 'discarded', 'refused'].includes(state)) return;
    this.commandLifecycleAvailable = true;
    if (state === 'started' && command.startedAfterResult === undefined) {
      command.startedAfterResult = this.nativeResultCount;
      this.providerTurnActive = true;
      this.providerTurnOwner ??= 'current';
    }
    if (state === 'completed') command.completed = true;
  }

  private resolveCompletedInputTurn(): void {
    const turn = this.currentTurn;
    if (!turn || turn.lastResult === undefined || this.queuedMessages.length > 0) return;
    // A merged input completes before its result; a new native turn completes
    // after its result. Both signals are required, including a result newer
    // than the input's started frame, so an old result cannot settle a followup.
    if (this.hasUnconfirmedInput()) return;
    this.resolveCurrentTurn(turn.lastResult);
  }

  private hasUnconfirmedInput(): boolean {
    for (const command of this.currentTurn?.commands.values() ?? []) {
      if (!command.completed || command.startedAfterResult === undefined
        || this.nativeResultCount <= command.startedAfterResult) return true;
    }
    return false;
  }

  private inputCompletionDeadlineApplies(): boolean {
    return this.commandLifecycleAvailable && this.currentTurn?.lastResult !== undefined
      && !this.providerTurnActive && !this.compacting && this.activeToolUseIds.size === 0
      && this.activeHookIds.size === 0 && this.queuedMessages.length === 0
      && this.hasUnconfirmedInput();
  }

  private refreshInputCompletionTimeout(): void {
    if (!this.inputCompletionDeadlineApplies()) {
      this.clearInputCompletionTimeout();
      return;
    }
    if (this.inputCompletionTimeout) return;
    this.inputCompletionTimeout = setTimeout(() => {
      this.inputCompletionTimeout = undefined;
      if (!this.inputCompletionDeadlineApplies()) return;
      this.rejectCurrentTurn(new Error('Claude Code did not confirm sent input completion after its result'));
      this.child.kill();
    }, CLAUDE_INPUT_COMPLETION_GRACE_MS);
    this.inputCompletionTimeout.unref?.();
  }

  private clearInputCompletionTimeout(): void {
    if (this.inputCompletionTimeout) clearTimeout(this.inputCompletionTimeout);
    this.inputCompletionTimeout = undefined;
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
    this.backgroundEvidence.record(value);
    const type = stringField(value, 'type');
    const subtype = stringField(value, 'subtype');
    if (type === 'command_lifecycle') this.updateCommandLifecycle(value);
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
      if (!message) continue;
      const turn = this.currentTurn;
      if (turn) observeInputTrace((payload) => turn.input.effects.recordEvent(payload), {
        phase: 'input.rejected_before_write', context: message.context,
      });
      message.reject(error);
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
