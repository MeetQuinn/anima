import { randomUUID } from 'node:crypto';

import { errorMessage, nowIso } from '../ids.js';
import { isRecord, numberField, singleLineForActivity, stringField } from '../json.js';
import { truncateForActivity } from '../activities/format.js';
import { writeSystemPromptFile } from './claude-launch.js';
import { type RunningChildProcess } from './child-process.js';
import { LineBuffer } from './line-buffer.js';
import { classifyProviderFailureReason } from './provider-failure.js';
import { providerUsageFromStats } from './provider-usage.js';
import { exposedReasoningEvent } from './reasoning-events.js';
import { ControllerAgentRuntime } from './provider-runtime.js';
import { QuiescentWaiterSet } from './quiescent-waiters.js';
import { withProviderCliLaunchPermit } from '../provider-cli/launch-gate.js';
import {
  providerSessionPayload,
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type PiAgentProviderConfig,
} from './contract.js';

const PI_RUNTIME_KIND = 'pi';
const PI_TRANSPORT = 'rpc';
const PI_RPC_REQUEST_TIMEOUT_MS = 30_000;
const PI_STEER_TIMEOUT_MS = 5_000;
const PI_CREDENTIAL_HINT =
  'Configure a machine-level pi credential: run `pi` and `/login`, add the key to `~/.pi/agent/auth.json`, '
  + 'or export the provider API key in the Anima service environment.';

export function piLaunchArgs(
  providerArgs: readonly string[],
  options: {
    model?: string;
    reasoningEffort?: string;
    sessionId: string;
    systemPromptFilePath?: string;
  },
): string[] {
  // `--session-id` both resumes an existing session with that id under the
  // agent's cwd and creates a fresh session with that id when none exists, so
  // Anima never has to discover pi's session file path. `--no-extensions` keeps
  // pi's extension UI requests (which would block a headless run) out of the
  // loop; built-in tools, skills, and AGENTS.md context files remain.
  return [
    ...providerArgs,
    '--mode',
    'rpc',
    '--no-extensions',
    '--session-id',
    options.sessionId,
    ...(options.model ? ['--model', options.model] : []),
    ...(options.reasoningEffort ? ['--thinking', options.reasoningEffort] : []),
    ...(options.systemPromptFilePath ? ['--system-prompt', options.systemPromptFilePath] : []),
  ];
}

export function piLaunchEnvironment(
  env: NodeJS.ProcessEnv,
  machineEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  };
  // pi's provider credentials live in the machine-level agent dir
  // (`~/.pi/agent/auth.json`) or the service environment. Pin the paths which
  // locate that store to the machine environment rather than an agent's Launch env.
  for (const key of ['HOME', 'PI_CODING_AGENT_DIR']) {
    const value = machineEnv[key]?.trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  // Do not allow a per-agent API key to become per-agent identity authority.
  for (const key of Object.keys(next)) {
    if (!/_API_KEY$/.test(key)) continue;
    const value = machineEnv[key]?.trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  return next;
}

export class PiAgentRuntime extends ControllerAgentRuntime<PiRpcController> {
  readonly command: string;
  readonly env: Record<string, string> | undefined;
  readonly kind = PI_RUNTIME_KIND;
  private readonly config: PiAgentProviderConfig;
  private readonly providerArgs: readonly string[];

  constructor(
    config: PiAgentProviderConfig,
    command: string,
    providerArgs: readonly string[] = [],
  ) {
    super({ providerChildIdleTimeoutMs: config.providerChildIdleTimeoutMs });
    this.config = config;
    this.command = command;
    this.env = config.env;
    this.providerArgs = [...providerArgs];
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    return this.runTurnLifecycle(input, {
      label: 'pi',
      startedPayload: {
        command: this.command,
        transport: PI_TRANSPORT,
      },
      abort: async (signal) => {
        await this.slot.get()?.cancelActiveTurn();
        await this.slot.reset(signal);
      },
      turn: async () => {
        try {
          const controller = await this.ensureController(input);
          await input.effects.persistProviderSession({
            id: controller.sessionId,
            updatedAt: nowIso(),
          });
          const text = await controller.startTurn(input, input.prompt);
          if (input.signal?.aborted) {
            throw new Error(`pi turn cancelled: ${String(input.signal.reason ?? 'aborted')}`);
          }
          return text.trim() ? { text: text.trim() } : {};
        } catch (error) {
          const mapped = piSetupError(error, this.config.model);
          if (mapped !== error) await this.slot.reset();
          throw mapped;
        }
      },
    });
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    const controller = this.slot.get();
    if (!this.activeRun.accepts(input)) return { accepted: false };
    if (!controller || !(await controller.steer(input.prompt))) return { accepted: false };
    return { accepted: true, text: 'pi follow-up applied (steered into active turn)' };
  }

  private async ensureController(input: AgentRuntimeInput): Promise<PiRpcController> {
    const requestedSessionId = input.providerSession?.id;
    const existing = this.slot.get();
    if (existing && requestedSessionId && existing.sessionId !== requestedSessionId) {
      await this.slot.reset();
    }
    if (existing && !requestedSessionId) {
      await this.slot.reset();
    }

    const controller =
      this.slot.get()
      ?? await withProviderCliLaunchPermit(this.kind, input.signal, async () => {
        const current = this.slot.get();
        if (current) return current;
        const sessionId = requestedSessionId ?? randomUUID();
        const systemPromptFilePath = await writeSystemPromptFile(input);
        return this.spawnController(
          {
            args: piLaunchArgs(this.providerArgs, {
              model: this.config.model,
              reasoningEffort: this.config.reasoningEffort,
              sessionId,
              systemPromptFilePath,
            }),
            command: this.command,
            label: 'pi RPC runtime',
          },
          {
            ...input,
            env: piLaunchEnvironment(input.env),
          },
          (child) => new PiRpcController(child, input, sessionId, this.config.model),
        );
      });

    try {
      await controller.initialize(input);
      return controller;
    } catch (error) {
      await this.slot.reset();
      throw error;
    }
  }
}

interface PiTurn {
  error?: PiTurnError;
  input: AgentRuntimeInput;
  promptAccepted: Promise<boolean>;
  reject(error: unknown): void;
  resolve(value: string): void;
  segments: string[];
  text: string[];
}

interface PiTurnError {
  message: string;
  status?: number;
}

interface PendingRequest {
  reject(error: unknown): void;
  resolve(value: Record<string, unknown>): void;
  timer: NodeJS.Timeout;
}

class PiRpcController {
  private readonly activeToolIds = new Set<string>();
  private readonly lines = new LineBuffer();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly quiescentWaiters = new QuiescentWaiterSet();
  private readonly usageCaptureId = randomUUID();
  private usageSequence = 0;
  private contextWindow?: number;
  private currentTurn?: PiTurn;
  private initialized?: Promise<void>;
  private latestUsage?: Record<string, unknown>;
  private reportedModel?: string;
  private turnCompletion?: Promise<string>;
  readonly completion: Promise<{ stdout: string; stderr: string }>;
  sessionId: string;

  constructor(
    private readonly child: RunningChildProcess,
    private bootstrapInput: AgentRuntimeInput,
    sessionId: string,
    private readonly configuredModel: string | undefined,
  ) {
    this.sessionId = sessionId;
    this.completion = child.completion.then(
      (result) => {
        this.fail(new Error('pi RPC runtime exited'));
        return result;
      },
      (error) => {
        this.fail(error);
        throw error;
      },
    );
  }

  async initialize(input: AgentRuntimeInput): Promise<void> {
    this.bootstrapInput = input;
    if (!this.initialized) {
      this.initialized = this.initializeSession(input).catch((error) => {
        this.initialized = undefined;
        throw error;
      });
    }
    await this.initialized;
  }

  async startTurn(input: AgentRuntimeInput, prompt: string): Promise<string> {
    if (this.currentTurn) throw new Error('pi RPC runtime already has an active turn');
    this.latestUsage = undefined;
    let acceptPrompt!: (value: boolean) => void;
    const promptAccepted = new Promise<boolean>((resolve) => {
      acceptPrompt = resolve;
    });
    const result = new Promise<string>((resolve, reject) => {
      this.currentTurn = {
        input,
        promptAccepted,
        reject,
        resolve,
        segments: [],
        text: [],
      };
    });
    this.turnCompletion = result;
    await input.effects.recordEvent({
      eventType: 'pi.turn.started',
      runtimeKind: PI_RUNTIME_KIND,
      transport: PI_TRANSPORT,
      userInputLength: prompt.length,
    });
    void this.request({ message: prompt, type: 'prompt' }).then(
      () => acceptPrompt(true),
      (error) => {
        acceptPrompt(false);
        this.abortCurrentTurn(error);
      },
    );
    return result.finally(() => {
      if (this.turnCompletion === result) this.turnCompletion = undefined;
    });
  }

  async steer(prompt: string): Promise<boolean> {
    const turn = this.currentTurn;
    if (!turn) return false;
    const accepted = await Promise.race([
      turn.promptAccepted,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PI_STEER_TIMEOUT_MS)),
    ]);
    if (!accepted || this.currentTurn !== turn) return false;
    try {
      await this.request({ message: prompt, type: 'steer' });
    } catch (error) {
      await turn.input.effects.recordEvent({
        error: truncateForActivity(errorMessage(error)),
        eventType: 'pi.steer.rejected',
        runtimeKind: PI_RUNTIME_KIND,
        transport: PI_TRANSPORT,
      });
      return false;
    }
    await turn.input.effects.recordEvent({
      eventType: 'pi.steer.accepted',
      runtimeKind: PI_RUNTIME_KIND,
      transport: PI_TRANSPORT,
      userInputLength: prompt.length,
    });
    return true;
  }

  async cancelActiveTurn(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    void this.request({ type: 'abort' }).catch(() => undefined);
    const completion = this.turnCompletion;
    if (!completion) return;
    await Promise.race([
      completion.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  async acceptStdoutChunk(chunk: string): Promise<void> {
    for (const line of this.lines.accept(chunk)) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        await this.effects().recordOutput('stdout', line);
        continue;
      }
      if (!isRecord(parsed)) continue;
      if (parsed.type === 'response') {
        this.handleResponse(parsed);
        continue;
      }
      await this.handleEvent(parsed);
    }
  }

  async acceptStderrChunk(chunk: string): Promise<void> {
    if (/No project session found with id/i.test(chunk)) {
      // pi prints this for every `--session-id` it has not seen before, so it is
      // only a resume miss when Anima actually asked for a stored session.
      const input = this.bootstrapInput;
      if (!input.providerSession?.id) return;
      await input.effects.recordEvent({
        eventType: 'pi.session.resume_missing',
        providerSession: providerSessionPayload(input.providerSession, PI_RUNTIME_KIND),
        runtimeKind: PI_RUNTIME_KIND,
        transport: PI_TRANSPORT,
      });
      return;
    }
    await this.effects().recordOutput('stderr', chunk);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child.kill(signal);
  }

  snapshot() {
    return this.child.snapshot();
  }

  isQuiescent(): boolean {
    return this.activeToolIds.size === 0;
  }

  waitForQuiescent(signal?: AbortSignal): Promise<void> {
    return this.quiescentWaiters.waitUntilReady(() => this.activeToolIds.size === 0, signal);
  }

  private effects() {
    return (this.currentTurn ?? { input: this.bootstrapInput }).input.effects;
  }

  private async initializeSession(input: AgentRuntimeInput): Promise<void> {
    const state = await this.request({ type: 'get_state' });
    const reportedSessionId = stringField(state, 'sessionId');
    if (reportedSessionId) this.sessionId = reportedSessionId;
    // Without any credential pi still answers get_state, but with an
    // `unknown/unknown` placeholder model; treat that the same as no model.
    const reportedModel = isRecord(state.model) ? state.model : undefined;
    const model = reportedModel && piModelName(reportedModel) !== 'unknown/unknown' ? reportedModel : undefined;
    this.contextWindow = numberField(model, 'contextWindow');
    this.reportedModel = piModelName(model);
    await input.effects.recordEvent({
      eventType: 'pi.system.init',
      runtimeKind: PI_RUNTIME_KIND,
      transport: PI_TRANSPORT,
      ...(this.reportedModel ? { model: this.reportedModel } : {}),
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      ...(stringField(state, 'thinkingLevel') ? { thinkingLevel: stringField(state, 'thinkingLevel') } : {}),
      ...(stringField(state, 'sessionFile') ? { sessionFile: stringField(state, 'sessionFile') } : {}),
    });
    if (!model) {
      throw Object.assign(
        new Error(`pi has no usable model for ${this.configuredModel ?? 'the default provider'}.`),
        { reason: 'provider_auth_failed' },
      );
    }
  }

  private request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi RPC ${String(command.type)} timed out`));
      }, PI_RPC_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { reject, resolve, timer });
      try {
        this.child.writeStdin(`${JSON.stringify({ id, ...command })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = stringField(message, 'id');
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending || !id) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.success === false) {
      pending.reject(new Error(
        `pi RPC ${stringField(message, 'command') ?? 'command'} failed: ${stringField(message, 'error') ?? 'unknown error'}`,
      ));
      return;
    }
    pending.resolve(isRecord(message.data) ? message.data : {});
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = stringField(event, 'type');
    const turn = this.currentTurn;
    if (!type) return;

    if (type === 'message_update') {
      if (!turn) return;
      const delta = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
      const deltaType = stringField(delta, 'type');
      if (deltaType === 'text_delta') {
        const text = stringField(delta, 'delta');
        if (text) turn.text.push(text);
        return;
      }
      if (deltaType === 'thinking_delta') {
        const text = stringField(delta, 'delta');
        if (!text) return;
        await turn.input.effects.recordEvent({
          eventType: 'pi.thinking.delta',
          runtimeKind: PI_RUNTIME_KIND,
          text: truncateForActivity(text),
          transport: PI_TRANSPORT,
        });
        await turn.input.effects.recordEvent(exposedReasoningEvent({
          provider: 'pi',
          runtimeKind: PI_RUNTIME_KIND,
          sourceEventType: 'pi.thinking.delta',
          text,
          textKind: 'think',
        }));
      }
      return;
    }

    if (type === 'message_end') {
      if (!turn) return;
      const message = isRecord(event.message) ? event.message : undefined;
      if (stringField(message, 'role') !== 'assistant') return;
      await this.handleAssistantMessage(turn, message ?? {});
      return;
    }

    if (type === 'tool_execution_start') {
      if (!turn) return;
      await this.handleToolStart(turn.input, event);
      return;
    }

    if (type === 'tool_execution_end') {
      if (!turn) return;
      await this.handleToolEnd(turn.input, event);
      return;
    }

    if (type === 'auto_retry_start') {
      if (!turn) return;
      // pi retries the provider call itself; the previous error is not terminal.
      turn.error = undefined;
      await turn.input.effects.recordEvent({
        eventType: 'pi.auto_retry.started',
        runtimeKind: PI_RUNTIME_KIND,
        transport: PI_TRANSPORT,
        ...(numberField(event, 'attempt') !== undefined ? { attempt: numberField(event, 'attempt') } : {}),
        ...(numberField(event, 'maxAttempts') !== undefined ? { maxAttempts: numberField(event, 'maxAttempts') } : {}),
        ...(numberField(event, 'delayMs') !== undefined ? { delayMs: numberField(event, 'delayMs') } : {}),
        ...(stringField(event, 'errorMessage')
          ? { error: truncateForActivity(stringField(event, 'errorMessage') ?? '') }
          : {}),
      });
      return;
    }

    if (type === 'auto_retry_end') {
      if (!turn) return;
      await turn.input.effects.recordEvent({
        eventType: 'pi.auto_retry.completed',
        runtimeKind: PI_RUNTIME_KIND,
        transport: PI_TRANSPORT,
        ...(typeof event.success === 'boolean' ? { success: event.success } : {}),
        ...(numberField(event, 'attempt') !== undefined ? { attempt: numberField(event, 'attempt') } : {}),
      });
      return;
    }

    if (type === 'compaction_start' || type === 'compaction_end') {
      await this.effects().recordEvent({
        eventType: type === 'compaction_start' ? 'pi.compact.started' : 'pi.compact.completed',
        runtimeKind: PI_RUNTIME_KIND,
        transport: PI_TRANSPORT,
        ...(stringField(event, 'reason') ? { reason: stringField(event, 'reason') } : {}),
        ...(typeof event.aborted === 'boolean' ? { aborted: event.aborted } : {}),
      });
      return;
    }

    if (type === 'extension_error') {
      await this.effects().recordEvent({
        eventType: 'pi.extension.error',
        runtimeKind: PI_RUNTIME_KIND,
        transport: PI_TRANSPORT,
        error: truncateForActivity(errorMessage(event.error)),
        ...(stringField(event, 'extensionPath') ? { extensionPath: stringField(event, 'extensionPath') } : {}),
      });
      return;
    }

    if (type === 'agent_settled') {
      await this.finishCurrentTurn();
    }
  }

  private async handleAssistantMessage(turn: PiTurn, message: Record<string, unknown>): Promise<void> {
    const segment = turn.text.join('').trim();
    turn.text.length = 0;
    if (segment) turn.segments.push(segment);

    const stopReason = stringField(message, 'stopReason');
    const model = piModelName(message) ?? this.reportedModel ?? this.configuredModel;
    const usage = piUsagePayload(message);
    const stats: Record<string, unknown> = {
      ...usage,
      ...(model ? { model } : {}),
      ...(stopReason ? { terminalReason: stopReason } : {}),
    };
    const reportsTokens = numberField(usage, 'totalTokens') !== undefined && numberField(usage, 'totalTokens') !== 0;
    const sourceId = `${this.sessionId}:${this.usageCaptureId}:message:${++this.usageSequence}`;
    if (stopReason === 'error' && !reportsTokens) {
      // A failed provider call is still a run; its usage is unknown rather than zero.
      await turn.input.effects.recordUsage(providerUsageFromStats(sourceId, undefined, { model }));
    } else {
      this.latestUsage = stats;
      await turn.input.effects.recordUsage(providerUsageFromStats(sourceId, stats, { model }));
      await turn.input.effects.recordEvent({
        ...stats,
        eventType: 'pi.session.stats',
        runtimeKind: PI_RUNTIME_KIND,
        transport: PI_TRANSPORT,
      });
      const currentContextTokens = numberField(usage, 'totalTokens');
      if (currentContextTokens !== undefined) {
        await turn.input.effects.recordEvent({
          currentContextTokens,
          ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
          eventType: 'pi.context.stats',
          ...(model ? { model } : {}),
          runtimeKind: PI_RUNTIME_KIND,
        });
      }
    }

    if (stopReason === 'error' || stopReason === 'aborted') {
      const rawMessage = stringField(message, 'errorMessage') ?? `pi ${stopReason} the turn`;
      turn.error = {
        message: rawMessage,
        ...(piHttpStatus(rawMessage) !== undefined ? { status: piHttpStatus(rawMessage) } : {}),
      };
      await turn.input.effects.recordEvent({
        error: truncateForActivity(rawMessage),
        eventType: 'pi.message.error',
        runtimeKind: PI_RUNTIME_KIND,
        terminalReason: stopReason,
        transport: PI_TRANSPORT,
      });
    }
  }

  private async handleToolStart(input: AgentRuntimeInput, event: Record<string, unknown>): Promise<void> {
    const id = stringField(event, 'toolCallId');
    if (!id) return;
    const name = stringField(event, 'toolName') ?? 'tool';
    const args = isRecord(event.args) ? event.args : {};
    this.activeToolIds.add(id);
    const summary = summarizePiToolArgs(name, args);
    await input.effects.recordToolStarted({
      eventType: 'pi.tool.call',
      provider: PI_RUNTIME_KIND,
      providerToolId: id,
      providerToolName: name,
      ...(summary.command ? { command: summary.command } : {}),
      ...(summary.target ? { target: summary.target } : {}),
      runtimeKind: PI_RUNTIME_KIND,
      tool: `pi.${name}`,
      transport: PI_TRANSPORT,
    });
  }

  private async handleToolEnd(input: AgentRuntimeInput, event: Record<string, unknown>): Promise<void> {
    const id = stringField(event, 'toolCallId');
    if (!id) return;
    const name = stringField(event, 'toolName') ?? 'tool';
    const isError = event.isError === true;
    const output = piToolOutput(event.result);
    await input.effects.recordEvent({
      eventType: 'pi.tool_result',
      isError,
      ...(output ? { output: truncateForActivity(output) } : {}),
      providerToolId: id,
      runtimeKind: PI_RUNTIME_KIND,
      transport: PI_TRANSPORT,
    });
    if (isError) {
      await input.effects.recordToolFailed({
        error: output ? truncateForActivity(output) : 'pi tool failed',
        provider: PI_RUNTIME_KIND,
        providerToolId: id,
        runtimeKind: PI_RUNTIME_KIND,
        tool: `pi.${name}`,
      });
    }
    this.activeToolIds.delete(id);
    this.resolveQuiescentWaitersIfReady();
  }

  private abortCurrentTurn(error: unknown): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.clearCurrentTurn();
    turn.reject(error);
  }

  private clearCurrentTurn(): void {
    this.currentTurn = undefined;
    this.activeToolIds.clear();
    this.resolveQuiescentWaitersIfReady();
  }

  private async finishCurrentTurn(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    this.clearCurrentTurn();
    const trailing = turn.text.join('').trim();
    if (trailing) turn.segments.push(trailing);
    await turn.input.effects.recordEvent({
      eventType: 'pi.turn.completed',
      runtimeKind: PI_RUNTIME_KIND,
      transport: PI_TRANSPORT,
      ...(stringField(this.latestUsage, 'terminalReason')
        ? { terminalReason: stringField(this.latestUsage, 'terminalReason') }
        : {}),
    });
    if (turn.error) {
      const status = turn.error.status;
      turn.reject(Object.assign(new Error(turn.error.message), {
        reason: classifyProviderFailureReason({ message: turn.error.message, status }),
        ...(status !== undefined ? { status } : {}),
      }));
      return;
    }
    const text = turn.segments.join('\n\n').trim();
    if (text) {
      await turn.input.effects.recordAgentText(text, {
        eventType: 'pi.assistant',
        transport: PI_TRANSPORT,
      });
    }
    turn.resolve(text);
  }

  private resolveQuiescentWaitersIfReady(): void {
    this.quiescentWaiters.resolveIfReady(() => this.activeToolIds.size === 0);
  }

  private fail(error: unknown): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.quiescentWaiters.reject(error);
    this.abortCurrentTurn(error);
  }
}

function piSetupError(error: unknown, model: string | undefined): unknown {
  const reason = isRecord(error) ? error.reason : undefined;
  const message = errorMessage(error);
  if (
    reason !== 'provider_auth_failed'
    && !/(?:no usable model|no model|api.?key|credential|unauthori[sz]ed|authentication|not authenticated|\b401\b|\b403\b)/i.test(message)
  ) {
    return error;
  }
  return Object.assign(
    new Error(`pi could not use ${model ?? 'the selected model'}. ${PI_CREDENTIAL_HINT} ${message}`, { cause: error }),
    {
      reason: 'provider_auth_failed',
      ...(isRecord(error) && error.status !== undefined ? { status: error.status } : {}),
    },
  );
}

function piModelName(record: Record<string, unknown> | undefined): string | undefined {
  const id = stringField(record, 'id') ?? stringField(record, 'model');
  const provider = stringField(record, 'provider');
  if (!id) return undefined;
  return provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
}

function piHttpStatus(message: string): number | undefined {
  const match = message.match(/^\s*(\d{3})\b/);
  if (!match?.[1]) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status < 600 ? status : undefined;
}

function piUsagePayload(message: Record<string, unknown>): Record<string, unknown> {
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const output: Record<string, unknown> = {};
  if (!usage) return output;
  const copy = (from: string, to: string) => {
    const value = usage[from];
    if (typeof value === 'number' && Number.isFinite(value)) output[to] = value;
  };
  copy('input', 'inputTokens');
  copy('output', 'outputTokens');
  copy('cacheRead', 'cacheReadInputTokens');
  copy('cacheWrite', 'cacheCreationInputTokens');
  copy('reasoning', 'reasoningOutputTokens');
  copy('totalTokens', 'totalTokens');
  const cost = isRecord(usage.cost) ? usage.cost : undefined;
  const total = numberField(cost, 'total');
  if (total !== undefined) output.costUsd = total;
  return output;
}

function piToolOutput(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (!isRecord(result)) return undefined;
  if (typeof result.output === 'string') return result.output;
  if (!Array.isArray(result.content)) return undefined;
  const chunks: string[] = [];
  for (const block of result.content) {
    if (!isRecord(block)) continue;
    const text = stringField(block, 'text');
    if (text) chunks.push(text);
  }
  return chunks.join('\n') || undefined;
}

function summarizePiToolArgs(
  name: string,
  args: Record<string, unknown>,
): { command?: string; target?: string } {
  if (name === 'bash') {
    const command = stringField(args, 'command');
    return command ? { command: singleLineForActivity(command), target: singleLineForActivity(command) } : {};
  }
  const target = stringField(args, 'path')
    ?? stringField(args, 'file_path')
    ?? stringField(args, 'pattern')
    ?? stringField(args, 'query')
    ?? stringField(args, 'url');
  return target ? { target: singleLineForActivity(target) } : {};
}
