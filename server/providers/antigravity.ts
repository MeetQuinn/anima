import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import { nowIso } from '../ids.js';
import { isRecord, numberField, singleLineForActivity, stringField } from '../json.js';
import { truncateForActivity } from '../activities/format.js';
import { raceWithTimeout } from '../race-timeout.js';
import { type RunningChildProcess } from './child-process.js';
import { providerUsageFromStats } from './provider-usage.js';
import { AcpJsonRpcError, AcpJsonRpcPeer } from './acp-json-rpc.js';
import { acpPermissionApprovalOptionId } from './acp-permissions.js';
import {
  copyNumberLike,
  extractAcpText,
  extractAcpToolCallText,
  extractSessionId,
  normalizeAcpUpdate,
  toolCallId,
  toolInput,
} from './acp-updates.js';
import {
  acpFollowupAppliedText,
  appendAcpFollowupPrompt,
  discardAcpPromptPartialText,
  drainAcpTurnQueue,
  rollbackCancelledAcpPromptText,
  withAcpPromptInFlight,
} from './acp-midturn-followup.js';
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
  type AntigravityCliAgentProviderConfig,
} from './contract.js';

const ANTIGRAVITY_RUNTIME_KIND = 'antigravity-cli';

/**
 * `agy acp` is Antigravity CLI's official ACP server — the same entry point Zed,
 * JetBrains and Xcode launch. Flags go after `acp`. An Anima agent has no one to
 * answer permission prompts, so tool calls are approved up front, as with the
 * other providers.
 */
export function antigravityAcpLaunchArgs(providerArgs: readonly string[] = []): string[] {
  return ['acp', ...providerArgs, '--dangerously-skip-permissions'];
}

/**
 * The sign-in lives in the OS keyring and `~/.gemini`, both machine-wide, so HOME
 * comes from the service environment rather than an agent's Launch env.
 */
export function antigravityLaunchEnvironment(
  env: NodeJS.ProcessEnv,
  machineEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const home = machineEnv.HOME?.trim();
  if (home) next.HOME = home;
  return next;
}

/**
 * The Antigravity desktop app installs its own `agy` (an IDE launcher script inside
 * Antigravity.app). Launching that with `acp` would open an editor window instead of
 * an ACP server, so refuse it with a pointer to the CLI.
 */
export function antigravityCommandProblem(
  command: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const resolved = resolveExecutable(command, env);
  if (!resolved) return undefined;
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    return undefined;
  }
  if (!/\.app[/\\]Contents[/\\]/.test(real) && !/\.wrapper\.sh$/.test(real)) return undefined;
  return (
    `${resolved} is the Antigravity app's editor launcher, not Antigravity CLI. `
    + 'Install Antigravity CLI (it lives in ~/.local/bin/agy) and put it first on PATH, '
    + 'or set the Antigravity command to its full path in Settings → Providers.'
  );
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = command.includes('/') || isAbsolute(command)
    ? [command]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // try the next PATH entry
    }
  }
  return undefined;
}

export class AntigravityCliAgentRuntime extends ControllerAgentRuntime<AntigravityAcpController> {
  readonly command: string;
  readonly env: Record<string, string> | undefined;
  readonly kind = ANTIGRAVITY_RUNTIME_KIND;
  private readonly config: AntigravityCliAgentProviderConfig;
  private readonly providerArgs: readonly string[];

  constructor(
    config: AntigravityCliAgentProviderConfig,
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
      label: 'Antigravity',
      startedPayload: {
        command: this.command,
        transport: 'acp',
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
          const text = await controller.startTurn(input, controller.primaryPrompt(input));
          if (input.signal?.aborted) {
            throw new Error(`Antigravity turn cancelled: ${String(input.signal.reason ?? 'aborted')}`);
          }
          return text.trim() ? { text: text.trim() } : {};
        } catch (error) {
          const mapped = antigravitySetupError(error);
          if (mapped !== error) await this.slot.reset();
          throw mapped;
        }
      },
    });
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    const controller = this.slot.get();
    if (!this.activeRun.accepts(input)) return { accepted: false };
    if (!controller?.appendPrompt(input.prompt)) return { accepted: false };
    return { accepted: true, text: acpFollowupAppliedText('Antigravity') };
  }

  private async ensureController(input: AgentRuntimeInput): Promise<AntigravityAcpController> {
    const requestedSessionId = input.providerSession?.id;
    const existing = this.slot.get();
    if (existing && requestedSessionId && existing.sessionId !== requestedSessionId) {
      await this.slot.reset();
    }
    if (existing && !requestedSessionId && existing.sessionId) {
      await this.slot.reset();
    }

    const controller =
      this.slot.get()
      ?? await withProviderCliLaunchPermit(this.kind, input.signal, async () => {
        const current = this.slot.get();
        if (current) return current;
        const env = antigravityLaunchEnvironment(input.env);
        const problem = antigravityCommandProblem(this.command, env);
        if (problem) throw new Error(problem);
        return this.spawnController(
          {
            args: antigravityAcpLaunchArgs(this.providerArgs),
            command: this.command,
            label: 'Antigravity ACP runtime',
          },
          { ...input, env },
          (child) => new AntigravityAcpController(child),
        );
      });

    try {
      await controller.ensureSession(input, this.config.model, this.config.reasoningEffort);
      return controller;
    } catch (error) {
      await this.slot.reset();
      throw error;
    }
  }
}

interface AntigravityTurn {
  acceptingFollowups: boolean;
  followups: string[];
  input: AgentRuntimeInput;
  reject(error: unknown): void;
  resolve(value: string): void;
  text: string[];
}

interface PendingTool {
  input?: Record<string, unknown>;
  name: string;
}

/** One ACP `select` session config option, flattened (groups merged). */
export interface AcpSelectOption {
  category?: string;
  currentValue?: string;
  id: string;
  values: Array<{ name?: string; value: string }>;
}

class AntigravityAcpController {
  private readonly activeToolIds = new Set<string>();
  private configOptions: AcpSelectOption[] = [];
  private currentTurn?: AntigravityTurn;
  private initialized?: Promise<void>;
  private latestUsage?: Record<string, unknown>;
  private readonly usageCaptureId = randomUUID();
  private usageSequence = 0;
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly quiescentWaiters = new QuiescentWaiterSet();
  private readonly rpc: AcpJsonRpcPeer;
  private turnCompletion?: Promise<string>;
  /** True while a session/prompt RPC is outstanding. */
  private promptInFlight = false;
  /** Whether `agy acp` takes an appended system prompt on session/new. */
  private supportsSystemPromptAppend = false;
  /** Whether this session already carries Anima's system prompt. */
  private sessionHasSystemPrompt = false;
  readonly completion: Promise<{ stdout: string; stderr: string }>;
  sessionId = '';

  constructor(private readonly child: RunningChildProcess) {
    this.rpc = new AcpJsonRpcPeer(child, {
      label: 'Antigravity',
      onNotification: (message) => this.handleNotification(message),
      onRequest: (message) => this.handleAgentRequest(message),
      onUnstructuredOutput: async (text) => {
        const turn = this.currentTurn;
        if (turn) await turn.input.effects.recordOutput('stdout', text);
      },
    });
    this.completion = child.completion.then(
      (result) => {
        this.fail(
          new Error('Antigravity ACP runtime exited'),
          new Error('Antigravity ACP runtime exited before completing active turn'),
        );
        return result;
      },
      (error) => {
        this.fail(error);
        throw error;
      },
    );
  }

  /**
   * The system prompt goes into the session itself when `agy acp` supports it
   * (`_meta.antigravity.systemPrompt.append` on session/new); a resumed session
   * already has it. Only an older CLI without that capability gets it prepended.
   */
  primaryPrompt(input: AgentRuntimeInput): string {
    const systemPrompt = input.systemPrompt?.trim();
    if (!systemPrompt || this.sessionHasSystemPrompt) return input.prompt;
    return `${systemPrompt}\n\n---\n\n${input.prompt}`;
  }

  async ensureSession(
    input: AgentRuntimeInput,
    model: string | undefined,
    reasoningEffort: string | undefined,
  ): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initializeSession(input, model?.trim() || undefined, reasoningEffort?.trim() || undefined)
        .catch((error) => {
          this.initialized = undefined;
          throw error;
        });
    }
    await this.initialized;
  }

  async startTurn(input: AgentRuntimeInput, prompt: string): Promise<string> {
    if (this.currentTurn) throw new Error('Antigravity ACP runtime already has an active turn');
    this.latestUsage = undefined;
    const result = new Promise<string>((resolve, reject) => {
      this.currentTurn = {
        acceptingFollowups: true,
        followups: [],
        input,
        reject,
        resolve,
        text: [],
      };
    });
    this.turnCompletion = result;
    void this.runTurnQueue(prompt).catch((error) => this.abortCurrentTurn(error));
    return result.finally(() => {
      if (this.turnCompletion === result) this.turnCompletion = undefined;
    });
  }

  async cancelActiveTurn(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn || !this.sessionId) return;
    turn.acceptingFollowups = false;
    turn.followups.length = 0;
    this.rpc.notify('session/cancel', { sessionId: this.sessionId });
    const completion = this.turnCompletion;
    if (!completion) return;
    await raceWithTimeout(completion.catch(() => undefined), 2_000, undefined);
  }

  appendPrompt(prompt: string): boolean {
    return appendAcpFollowupPrompt({
      cancelSession: (sessionId) => this.rpc.notify('session/cancel', { sessionId }),
      prompt,
      promptInFlight: this.promptInFlight,
      sessionId: this.sessionId || undefined,
      turn: this.currentTurn,
    });
  }

  acceptStdoutChunk(chunk: string): Promise<void> {
    return this.rpc.acceptStdoutChunk(chunk);
  }

  async acceptStderrChunk(chunk: string): Promise<void> {
    const turn = this.currentTurn;
    if (turn) await turn.input.effects.recordOutput('stderr', chunk);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child.kill(signal);
  }

  snapshot() {
    return this.child.snapshot();
  }

  waitForQuiescent(signal?: AbortSignal): Promise<void> {
    return this.quiescentWaiters.waitUntilReady(() => this.activeToolIds.size === 0, signal);
  }

  private async initializeSession(
    input: AgentRuntimeInput,
    model: string | undefined,
    reasoningEffort: string | undefined,
  ): Promise<void> {
    const initResult = await this.rpc.request('initialize', {
      clientCapabilities: {},
      clientInfo: { name: 'anima', version: '0.1.0' },
      protocolVersion: 1,
    });
    const initEvent = antigravityInitializeEvent(initResult);
    const version = initEvent?.serverVersion;
    if (typeof version === 'string') this.child.setVersion(version);
    if (initEvent) await input.effects.recordEvent(initEvent);
    this.supportsSystemPromptAppend = antigravitySupportsSystemPromptAppend(initResult);

    const requestedSessionId = input.providerSession?.id;
    if (requestedSessionId) {
      try {
        const result = await this.rpc.request('session/resume', {
          cwd: input.cwd,
          mcpServers: [],
          sessionId: requestedSessionId,
        });
        this.sessionId = extractSessionId(result) ?? requestedSessionId;
        this.captureConfigOptions(result);
        this.sessionHasSystemPrompt = this.supportsSystemPromptAppend;
      } catch (error) {
        if (!isAntigravitySessionNotFoundError(error)) throw error;
        await input.effects.recordEvent({
          eventType: 'antigravity.session.resume_missing',
          providerSession: providerSessionPayload(input.providerSession, ANTIGRAVITY_RUNTIME_KIND),
          runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
          transport: 'acp',
        });
        this.sessionId = await this.createSession(input);
      }
    } else {
      this.sessionId = await this.createSession(input);
    }

    if (model) await this.selectModel(model);
    if (reasoningEffort) await this.selectEffort(input, reasoningEffort);
    const currentModel = this.option('model')?.currentValue;
    const currentEffort = this.option('thought_level')?.currentValue;
    await input.effects.recordEvent({
      checkedAt: nowIso(),
      eventType: 'antigravity.model.selected',
      ...(currentModel ? { model: currentModel } : {}),
      ...(currentEffort ? { reasoningEffort: currentEffort } : {}),
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      transport: 'acp',
    });
  }

  private async createSession(input: AgentRuntimeInput): Promise<string> {
    const systemPrompt = input.systemPrompt?.trim();
    const appendSystemPrompt = Boolean(systemPrompt && this.supportsSystemPromptAppend);
    const result = await this.rpc.request('session/new', {
      cwd: input.cwd,
      mcpServers: [],
      ...(appendSystemPrompt
        ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } }
        : {}),
    });
    const sessionId = extractSessionId(result);
    if (!sessionId) throw new Error('Antigravity ACP session/new returned no sessionId');
    this.captureConfigOptions(result);
    this.sessionHasSystemPrompt = appendSystemPrompt;
    return sessionId;
  }

  /**
   * Pin the configured model. Fails the turn when the signed-in account does not
   * offer it: running a different model than the one configured would be silent
   * and wrong (models differ by plan, e.g. Gemini 4 Argon needs a paid plan).
   */
  private async selectModel(model: string): Promise<void> {
    const option = this.option('model');
    if (!option) {
      throw new Error(`Antigravity did not offer a model choice, so ${model} could not be selected.`);
    }
    if (option.currentValue === model) return;
    if (!option.values.some((entry) => entry.value === model)) {
      const available = option.values.map((entry) => entry.value).join(', ') || 'none';
      throw new Error(
        `Antigravity does not offer ${model} to the signed-in account (available: ${available}). `
          + 'Some models need a paid Google AI plan; pick an available model or change the account with `agy`.',
      );
    }
    const result = await this.rpc.request('session/set_config_option', {
      configId: option.id,
      sessionId: this.sessionId,
      value: model,
    });
    this.captureConfigOptions(result);
  }

  /**
   * Thinking levels are model-scoped. An effort the session's model does not
   * offer is skipped (and recorded) rather than failing the turn.
   */
  private async selectEffort(input: AgentRuntimeInput, effort: string): Promise<void> {
    const option = this.option('thought_level');
    if (option?.currentValue === effort) return;
    if (!option || !option.values.some((entry) => entry.value === effort)) {
      await input.effects.recordEvent({
        available: option?.values.map((entry) => entry.value) ?? [],
        eventType: 'antigravity.effort.unavailable',
        reasoningEffort: effort,
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
        transport: 'acp',
      });
      return;
    }
    const result = await this.rpc.request('session/set_config_option', {
      configId: option.id,
      sessionId: this.sessionId,
      value: effort,
    });
    this.captureConfigOptions(result);
  }

  private option(category: 'model' | 'thought_level'): AcpSelectOption | undefined {
    return findAcpSelectOption(this.configOptions, category);
  }

  private captureConfigOptions(result: Record<string, unknown> | undefined): void {
    const options = parseAcpSelectOptions(result?.['configOptions']);
    if (options) this.configOptions = options;
  }

  private async runTurnQueue(firstPrompt: string): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    await drainAcpTurnQueue({
      firstPrompt,
      runOnePrompt: (prompt) => this.runOnePrompt(turn, prompt),
      turn,
    });
    await this.finishCurrentTurn();
  }

  private async runOnePrompt(turn: AntigravityTurn, prompt: string): Promise<void> {
    this.latestUsage = undefined;
    await turn.input.effects.recordEvent({
      eventType: 'antigravity.turn.started',
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      transport: 'acp',
      userInputLength: prompt.length,
    });
    const sourceId = `${this.sessionId}:${this.usageCaptureId}:prompt:${++this.usageSequence}`;
    const model = this.option('model')?.currentValue;
    // Assistant chunks stream into turn.text; if this prompt is cancelled for a
    // mid-turn follow-up, discard only the chunks produced by this prompt.
    const textCheckpoint = turn.text.length;
    let result: Record<string, unknown> | undefined;
    try {
      result = await withAcpPromptInFlight(
        (value) => {
          this.promptInFlight = value;
        },
        () => this.rpc.request('session/prompt', {
          prompt: [{ text: prompt, type: 'text' }],
          sessionId: this.sessionId,
        }),
      );
    } catch (error) {
      discardAcpPromptPartialText(turn, textCheckpoint);
      this.activeToolIds.clear();
      this.pendingTools.clear();
      await turn.input.effects.recordUsage(providerUsageFromStats(sourceId, this.latestUsage, { model }));
      throw error;
    }
    const stopReason = stringField(result, 'stopReason');
    if (rollbackCancelledAcpPromptText(turn, textCheckpoint, stopReason)) {
      this.activeToolIds.clear();
      this.pendingTools.clear();
    }
    const usage = acpUsagePayload(result);
    if (usage) {
      this.latestUsage = { ...(this.latestUsage ?? {}), ...usage };
      await turn.input.effects.recordEvent({
        ...usage,
        eventType: 'antigravity.context.stats',
        ...(model ? { model } : {}),
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
        terminalReason: stopReason,
      });
    }
    await turn.input.effects.recordUsage(providerUsageFromStats(sourceId, usage ?? this.latestUsage, { model }));
    await turn.input.effects.recordEvent({
      eventType: 'antigravity.turn.completed',
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      terminalReason: stopReason,
      transport: 'acp',
    });
  }

  private handleAgentRequest(message: Record<string, unknown>): void {
    const method = stringField(message, 'method');
    if (method === 'session/request_permission') {
      const optionId = acpPermissionApprovalOptionId(message);
      if (!optionId) {
        this.rpc.respondError(message.id, -32602, 'Antigravity provided no allow permission option');
        return;
      }
      this.rpc.respond(message.id, { outcome: { optionId, outcome: 'selected' } });
      return;
    }
    this.rpc.respondError(message.id, -32601, `method not found: ${method ?? 'unknown'}`);
  }

  private async handleNotification(message: Record<string, unknown>): Promise<void> {
    const method = stringField(message, 'method');
    if (method !== 'session/update' && method !== 'session/notification') return;
    const params = isRecord(message.params) ? message.params : undefined;
    const notifiedSessionId = stringField(params, 'sessionId') ?? stringField(params, 'session_id');
    if (notifiedSessionId && notifiedSessionId !== this.sessionId) return;
    const update = params?.update;
    if (!update) return;
    const { data, type } = normalizeAcpUpdate(update);
    if (type === 'config_option_update') {
      this.captureConfigOptions(data);
      return;
    }
    const turn = this.currentTurn;
    if (!turn) return;

    if (type === 'agent_message_chunk') {
      const text = extractAcpText(data);
      if (text) turn.text.push(text);
      return;
    }
    if (type === 'agent_thought_chunk') {
      const text = extractAcpText(data);
      if (!text) return;
      await turn.input.effects.recordEvent({
        eventType: 'antigravity.thinking.delta',
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
        text: truncateForActivity(text),
        transport: 'acp',
      });
      await turn.input.effects.recordEvent(exposedReasoningEvent({
        provider: 'antigravity',
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
        sourceEventType: 'antigravity.thinking.delta',
        text,
        textKind: 'think',
      }));
      return;
    }
    if (type === 'tool_call') {
      await this.handleToolCall(turn.input, data);
      return;
    }
    if (type === 'tool_call_update') {
      await this.handleToolCall(turn.input, data);
      return;
    }
    if (type === 'usage_update') {
      const usage = acpUsagePayload(data);
      if (!usage) return;
      this.latestUsage = { ...(this.latestUsage ?? {}), ...usage };
      await turn.input.effects.recordEvent({
        ...usage,
        eventType: 'antigravity.context.stats',
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      });
    }
  }

  /** Handles both `tool_call` and `tool_call_update`: start once, finish on a terminal status. */
  private async handleToolCall(input: AgentRuntimeInput, data: Record<string, unknown>): Promise<void> {
    const id = toolCallId(data);
    if (!id) return;
    const status = stringField(data, 'status');
    const terminal = status === 'completed' || status === 'failed';
    const pending = this.pendingTools.get(id);
    const rawInput = toolInput(data) ?? pending?.input;
    if (!pending) {
      const name = antigravityToolName(data);
      this.activeToolIds.add(id);
      this.pendingTools.set(id, { ...(rawInput ? { input: rawInput } : {}), name });
      const summary = summarizeAntigravityToolCall(name, rawInput ?? {}, data);
      await input.effects.recordToolStarted({
        eventType: 'antigravity.tool.call',
        provider: ANTIGRAVITY_RUNTIME_KIND,
        providerToolId: id,
        providerToolName: name,
        ...(summary.command ? { command: summary.command } : {}),
        ...(summary.target ? { target: summary.target } : {}),
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
        tool: `antigravity.${name}`,
        transport: 'acp',
      });
    } else if (rawInput) {
      pending.input = rawInput;
    }
    if (!terminal) return;

    const name = this.pendingTools.get(id)?.name ?? 'Tool';
    const output = antigravityToolOutput(data);
    await input.effects.recordEvent({
      eventType: 'antigravity.tool_result',
      isError: status === 'failed',
      output: output ? truncateForActivity(output) : undefined,
      providerToolId: id,
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      transport: 'acp',
    });
    if (status === 'failed') {
      await input.effects.recordToolFailed({
        error: output ? truncateForActivity(output) : 'Antigravity tool failed',
        provider: ANTIGRAVITY_RUNTIME_KIND,
        providerToolId: id,
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
        tool: `antigravity.${name}`,
      });
    }
    this.pendingTools.delete(id);
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
    this.pendingTools.clear();
    this.resolveQuiescentWaitersIfReady();
  }

  private async finishCurrentTurn(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    this.clearCurrentTurn();
    if (this.latestUsage) {
      await turn.input.effects.recordEvent({
        ...this.latestUsage,
        eventType: 'antigravity.context.stats',
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      });
    }
    const text = turn.text.join('').trim();
    if (text) {
      await turn.input.effects.recordAgentText(text, {
        eventType: 'antigravity.assistant',
        transport: 'acp',
      });
    }
    turn.resolve(text);
  }

  private resolveQuiescentWaitersIfReady(): void {
    this.quiescentWaiters.resolveIfReady(() => this.activeToolIds.size === 0);
  }

  /** `turnError` settles the active turn before the rejected requests' handlers run, so it decides how the turn is retried. */
  private fail(error: unknown, turnError: unknown = error): void {
    this.rpc.rejectAll(error);
    this.quiescentWaiters.reject(error);
    this.abortCurrentTurn(turnError);
  }
}

/**
 * Parse ACP session `configOptions` into flattened select options. Returns
 * undefined when the value is not an options array (keep the previous state).
 */
export function parseAcpSelectOptions(value: unknown): AcpSelectOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: AcpSelectOption[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = stringField(raw, 'id');
    if (!id || (raw.type !== undefined && raw.type !== 'select')) continue;
    const values: AcpSelectOption['values'] = [];
    const push = (entry: unknown) => {
      if (!isRecord(entry)) return;
      const optionValue = stringField(entry, 'value');
      if (!optionValue || values.some((existing) => existing.value === optionValue)) return;
      const name = stringField(entry, 'name');
      values.push({ ...(name ? { name } : {}), value: optionValue });
    };
    for (const entry of Array.isArray(raw.options) ? raw.options : []) {
      if (isRecord(entry) && Array.isArray(entry.options)) entry.options.forEach(push);
      else push(entry);
    }
    const category = stringField(raw, 'category');
    const currentValue = stringField(raw, 'currentValue');
    options.push({
      ...(category ? { category } : {}),
      ...(currentValue ? { currentValue } : {}),
      id,
      values,
    });
  }
  return options;
}

export function findAcpSelectOption(
  options: readonly AcpSelectOption[],
  category: 'model' | 'thought_level',
): AcpSelectOption | undefined {
  return options.find((option) => option.category === category)
    ?? options.find((option) => option.id === category);
}

function antigravitySupportsSystemPromptAppend(result: Record<string, unknown> | undefined): boolean {
  const capabilities = isRecord(result?.agentCapabilities) ? result.agentCapabilities : undefined;
  const meta = isRecord(capabilities?._meta) ? capabilities._meta : undefined;
  const antigravity = isRecord(meta?.antigravity) ? meta.antigravity : undefined;
  const systemPrompt = isRecord(antigravity?.systemPrompt) ? antigravity.systemPrompt : undefined;
  return systemPrompt?.append === true;
}

function antigravityInitializeEvent(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const event: Record<string, unknown> = {
    eventType: 'antigravity.system.init',
    runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
    transport: 'acp',
  };
  const protocolVersion = numberField(result, 'protocolVersion') ?? stringField(result, 'protocolVersion');
  if (protocolVersion !== undefined) event.protocolVersion = protocolVersion;
  const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : undefined;
  if (capabilities) event.capabilityCount = Object.keys(capabilities).length;
  const info = isRecord(result.agentInfo) ? result.agentInfo : undefined;
  const name = stringField(info, 'name');
  const version = stringField(info, 'version');
  if (name) event.serverName = name;
  if (version) event.serverVersion = version;
  return event;
}

/**
 * `agy acp` 1.5 answers a resume of an unknown or unreadable session with
 * `-32603 Failed to read session <id>; retry, or load it with session/load`.
 */
function isAntigravitySessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof AcpJsonRpcError)) return false;
  if (error.method !== 'session/resume') return false;
  return /failed\s+to\s+(?:read|load|find)\s+session|session.{0,40}(?:not\s+found|missing|unknown|does\s+not\s+exist)|(?:not\s+found|missing|unknown|no\s+such).{0,40}(?:session|conversation)/i.test(
    error.message,
  );
}

/** ACP `Authentication required` (-32000): the CLI on this machine is not signed in. */
export function antigravitySetupError(error: unknown): unknown {
  if (!(error instanceof AcpJsonRpcError)) return error;
  const code = numberField(error.error, 'code');
  if (code !== -32000 && !/authentication required/i.test(error.message)) return error;
  return new Error(
    'Antigravity CLI is not signed in on this machine. Run `agy` in a terminal once and sign in '
      + `(or \`agy acp --login\`), then retry. ${error.message}`,
    { cause: error },
  );
}

const ANTIGRAVITY_TOOL_KIND_NAMES: Record<string, string> = {
  delete: 'DeleteFile',
  edit: 'EditFile',
  execute: 'Shell',
  fetch: 'Fetch',
  move: 'MoveFile',
  read: 'ReadFile',
  search: 'Search',
  think: 'Think',
};

/** Anima tool name from the ACP tool kind, falling back to the title. */
export function antigravityToolName(data: Record<string, unknown>): string {
  const kind = stringField(data, 'kind')?.toLowerCase();
  const mapped = kind ? ANTIGRAVITY_TOOL_KIND_NAMES[kind] : undefined;
  if (mapped) return mapped;
  const title = stringField(data, 'title') ?? stringField(data, 'name') ?? 'Tool';
  const base = title.split(/[:(]/)[0]?.trim() || 'Tool';
  return base
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char: string) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '')
    .replace(/^[a-z]/, (char) => char.toUpperCase()) || 'Tool';
}

export function summarizeAntigravityToolCall(
  name: string,
  input: Record<string, unknown>,
  data: Record<string, unknown>,
): { command?: string; target?: string } {
  const command = name === 'Shell'
    ? stringField(input, 'command') ?? stringField(input, 'CommandLine') ?? stringField(input, 'cmd')
    : undefined;
  const location = Array.isArray(data.locations) && isRecord(data.locations[0])
    ? stringField(data.locations[0], 'path')
    : undefined;
  const target = location
    ?? stringField(input, 'file_path')
    ?? stringField(input, 'path')
    ?? stringField(input, 'AbsolutePath')
    ?? stringField(input, 'TargetFile')
    ?? stringField(input, 'pattern')
    ?? stringField(input, 'query')
    ?? stringField(input, 'Query')
    ?? stringField(input, 'url')
    ?? stringField(input, 'Url')
    ?? command
    ?? stringField(data, 'title');
  return {
    ...(command ? { command: singleLineForActivity(command) } : {}),
    ...(target ? { target: singleLineForActivity(target) } : {}),
  };
}

function antigravityToolOutput(data: Record<string, unknown>): string | undefined {
  if (typeof data.rawOutput === 'string') return data.rawOutput;
  const raw = isRecord(data.rawOutput) ? data.rawOutput : undefined;
  const output = stringField(raw, 'output') ?? stringField(raw, 'error');
  if (output) return output;
  return extractAcpToolCallText(data.content) || undefined;
}

function acpUsagePayload(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const usage = isRecord(value?.usage) ? value.usage : value;
  if (!usage) return undefined;
  const output: Record<string, unknown> = {};
  copyNumberLike(usage, output, ['inputTokens', 'input_tokens'], 'inputTokens');
  copyNumberLike(usage, output, ['outputTokens', 'output_tokens'], 'outputTokens');
  copyNumberLike(usage, output, ['totalTokens', 'total_tokens'], 'totalTokens');
  copyNumberLike(usage, output, ['cachedReadTokens', 'cacheReadInputTokens', 'cached_read_tokens'], 'cacheReadInputTokens');
  copyNumberLike(usage, output, ['cachedWriteTokens', 'cacheWriteInputTokens', 'cached_write_tokens'], 'cacheWriteInputTokens');
  copyNumberLike(usage, output, ['thoughtTokens', 'reasoningTokens'], 'reasoningTokens');
  copyNumberLike(usage, output, ['used', 'contextTokens', 'currentContextTokens'], 'currentContextTokens');
  copyNumberLike(usage, output, ['size', 'contextWindow', 'maxContextTokens'], 'contextWindow');
  return Object.keys(output).length > 0 ? output : undefined;
}
