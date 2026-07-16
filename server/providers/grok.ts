import { nowIso } from '../ids.js';
import { isRecord, numberField, singleLineForActivity, stringField } from '../json.js';
import { truncateForActivity } from '../activities/format.js';
import { type RunningChildProcess } from './child-process.js';
import { exposedReasoningEvent } from './reasoning-events.js';
import { LineBuffer } from './line-buffer.js';
import { ControllerAgentRuntime } from './provider-runtime.js';
import { QuiescentWaiterSet } from './quiescent-waiters.js';
import { withProviderCliLaunchPermit } from '../provider-cli/launch-gate.js';
import {
  providerSessionPayload,
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type GrokCliAgentProviderConfig,
} from './contract.js';

const GROK_COMMAND = 'grok';
const GROK_RUNTIME_KIND = 'grok-cli';

class GrokJsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly error: Record<string, unknown>,
  ) {
    super(jsonRpcErrorMessage(method, error));
    this.name = 'GrokJsonRpcError';
  }
}

export class GrokCliAgentRuntime extends ControllerAgentRuntime<GrokAcpController> {
  readonly env: Record<string, string> | undefined;
  readonly kind = GROK_RUNTIME_KIND;
  private readonly config: GrokCliAgentProviderConfig;
  // Keep accepted prompts outside the child controller so same-item crash retry can replay them.
  private retainedFollowups?: { itemId: string; prompts: string[] };

  constructor(config: GrokCliAgentProviderConfig) {
    super({ providerChildIdleTimeoutMs: config.providerChildIdleTimeoutMs });
    this.config = config;
    this.env = config.env;
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    return this.runTurnLifecycle(input, {
      label: 'Grok',
      startedPayload: {
        command: GROK_COMMAND,
        transport: 'acp',
      },
      abort: async (signal) => {
        await this.slot.get()?.cancelActiveTurn();
        await this.slot.reset(signal);
      },
      turn: async () => {
        const controller = await this.ensureController(input);
        await input.effects.persistProviderSession({
          id: controller.sessionId,
          updatedAt: nowIso(),
        });
        const text = await controller.startTurn(
          input,
          grokPrimaryPrompt(input),
          this.followupsForItem(input.itemId),
        );
        if (input.signal?.aborted) {
          throw new Error(`Grok turn cancelled: ${String(input.signal.reason ?? 'aborted')}`);
        }
        return text.trim() ? { text: text.trim() } : {};
      },
    });
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    const controller = this.slot.get();
    if (!this.activeRun.accepts(input)) return { accepted: false };
    if (!controller) return { accepted: false };
    if (!controller.appendPrompt(input.prompt)) return { accepted: false };
    return { accepted: true, text: 'queued for Grok ACP session' };
  }

  private followupsForItem(itemId: string): string[] {
    if (this.retainedFollowups?.itemId !== itemId) {
      this.retainedFollowups = { itemId, prompts: [] };
    }
    return this.retainedFollowups.prompts;
  }

  private async ensureController(input: AgentRuntimeInput): Promise<GrokAcpController> {
    const requestedSessionId = input.providerSession?.id;
    const existing = this.slot.get();
    if (existing && requestedSessionId && existing.sessionId !== requestedSessionId) {
      await this.slot.reset();
    }
    if (existing && !requestedSessionId && existing.sessionId) {
      await this.slot.reset();
    }
    const controller =
      this.slot.get() ??
      (await withProviderCliLaunchPermit(
        this.kind,
        input.signal,
        () =>
          this.slot.get() ??
          this.spawnController(
            {
              args: [
                '--no-auto-update',
                'agent',
                '--no-leader',
                '--always-approve',
                ...(this.config.model ? ['-m', this.config.model] : []),
                'stdio',
              ],
              command: GROK_COMMAND,
              label: 'Grok ACP runtime',
            },
            input,
            (child) => new GrokAcpController(child),
          ),
      ));
    try {
      await controller.ensureSession(input);
      return controller;
    } catch (error) {
      await this.slot.reset();
      throw error;
    }
  }
}

interface PendingRpc {
  cleanup(): void;
  method: string;
  reject(error: unknown): void;
  resolve(value: Record<string, unknown> | undefined): void;
}

interface GrokTurn {
  acceptingFollowups: boolean;
  followups: string[];
  input: AgentRuntimeInput;
  reject(error: unknown): void;
  resolve(value: string): void;
  text: string[];
}

interface PendingTool {
  argsText?: string;
  emitted: boolean;
  input?: Record<string, unknown>;
  name: string;
}

class GrokAcpController {
  private readonly stdoutLines = new LineBuffer();
  private initialized?: Promise<void>;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly pendingTools = new Map<string, PendingTool>();
  private currentTurn?: GrokTurn;
  private readonly activeToolIds = new Set<string>();
  private readonly quiescentWaiters = new QuiescentWaiterSet();
  private latestUsage?: Record<string, unknown>;
  private turnCompletion?: Promise<string>;
  private actualModel?: string;
  private contextWindow?: number;
  readonly completion: Promise<{ stdout: string; stderr: string }>;
  sessionId = '';

  constructor(private readonly child: RunningChildProcess) {
    this.completion = child.completion.then(
      (result) => {
        this.rejectAllPending(new Error('Grok ACP runtime exited'));
        this.rejectQuiescentWaiters(new Error('Grok ACP runtime exited before drain reached a quiescent point'));
        this.abortCurrentTurn(new Error('Grok ACP runtime exited before completing active turn'));
        return result;
      },
      (error) => {
        this.rejectAllPending(error);
        this.rejectQuiescentWaiters(error);
        this.abortCurrentTurn(error);
        throw error;
      },
    );
  }

  async ensureSession(input: AgentRuntimeInput): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initializeSession(input).catch((error) => {
        this.initialized = undefined;
        throw error;
      });
    }
    await this.initialized;
  }

  async startTurn(input: AgentRuntimeInput, prompt: string, followups: string[]): Promise<string> {
    if (this.currentTurn) throw new Error('Grok ACP runtime already has an active turn');
    const result = new Promise<string>((resolve, reject) => {
      this.currentTurn = {
        acceptingFollowups: true,
        followups,
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
    this.notify('session/cancel', { sessionId: this.sessionId });
    const completion = this.turnCompletion;
    if (!completion) return;
    await Promise.race([completion.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }

  appendPrompt(prompt: string): boolean {
    const turn = this.currentTurn;
    if (!turn) return false;
    if (!turn.acceptingFollowups) return false;
    turn.followups.push(prompt);
    return true;
  }

  async acceptStdoutChunk(chunk: string): Promise<void> {
    for (const line of this.stdoutLines.accept(chunk)) {
      await this.acceptLine(line);
    }
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

  private async initializeSession(input: AgentRuntimeInput): Promise<void> {
    const initResult = await this.request('initialize', {
      clientCapabilities: {},
      clientInfo: { name: 'anima', version: '0.1.0' },
      protocolVersion: 1,
    });
    const initEvent = grokAcpInitializeEvent(initResult);
    const version = initEvent?.['serverVersion'];
    if (typeof version === 'string') this.child.setVersion(version);
    if (initEvent) await input.effects.recordEvent(initEvent);
    this.captureModelAuthority(initResult);

    const requestedSessionId = input.providerSession?.id;
    if (requestedSessionId) {
      try {
        const result = await this.request('session/load', {
          cwd: input.cwd,
          mcpServers: [],
          sessionId: requestedSessionId,
        });
        this.sessionId = extractSessionId(result) ?? requestedSessionId;
        this.captureModelAuthority(result);
      } catch (error) {
        if (!isGrokSessionNotFoundError(error)) throw error;
        await input.effects.recordEvent({
          eventType: 'grok.session.load_missing',
          providerSession: providerSessionPayload(input.providerSession, GROK_RUNTIME_KIND),
          runtimeKind: GROK_RUNTIME_KIND,
          transport: 'acp',
        });
        this.sessionId = await this.createSession(input);
      }
    } else {
      this.sessionId = await this.createSession(input);
    }

    await input.effects.recordEvent({
      checkedAt: nowIso(),
      ...(this.actualModel ? { model: this.actualModel } : {}),
      ...(this.contextWindow ? { contextWindow: this.contextWindow } : {}),
      eventType: 'grok.model.catalog',
      runtimeKind: GROK_RUNTIME_KIND,
      transport: 'acp',
    });
  }

  private async createSession(input: AgentRuntimeInput): Promise<string> {
    const result = await this.request('session/new', {
      cwd: input.cwd,
      mcpServers: [],
    });
    const sessionId = extractSessionId(result);
    if (!sessionId) throw new Error('Grok ACP session/new returned no sessionId');
    this.captureModelAuthority(result);
    return sessionId;
  }

  private async runTurnQueue(firstPrompt: string): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    await this.runOnePrompt(turn, firstPrompt);
    while (!turn.input.signal?.aborted && turn.followups.length > 0) {
      await this.runOnePrompt(turn, turn.followups[0]!);
      turn.followups.shift();
    }
    turn.acceptingFollowups = false;
    await this.finishCurrentTurn();
  }

  private async runOnePrompt(turn: GrokTurn, prompt: string): Promise<void> {
    await turn.input.effects.recordEvent({
      eventType: 'grok.turn.started',
      runtimeKind: GROK_RUNTIME_KIND,
      transport: 'acp',
      userInputLength: prompt.length,
    });
    const result = await this.request('session/prompt', {
      prompt: [{ text: prompt, type: 'text' }],
      sessionId: this.sessionId,
    });
    this.captureModelAuthority(result);
    const usage = acpUsagePayload(result);
    if (usage) {
      const model = grokResultModel(result) ?? this.actualModel;
      if (model) this.actualModel = model;
      const enriched = {
        ...usage,
        ...(this.contextWindow ? { contextWindow: this.contextWindow } : {}),
        ...(model ? { model } : {}),
        ...(numberField(usage, 'totalTokens') !== undefined
          ? { currentContextTokens: numberField(usage, 'totalTokens') }
          : {}),
      };
      this.latestUsage = enriched;
      await turn.input.effects.recordEvent({
        ...enriched,
        checkedAt: nowIso(),
        eventType: 'grok.context.stats',
        ...(model ? { model } : {}),
        runtimeKind: GROK_RUNTIME_KIND,
        terminalReason: stringField(result, 'stopReason'),
      });
    }
    await turn.input.effects.recordEvent({
      eventType: 'grok.turn.completed',
      runtimeKind: GROK_RUNTIME_KIND,
      terminalReason: stringField(result, 'stopReason'),
      transport: 'acp',
    });
  }

  private async acceptLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      await this.currentTurn?.input.effects.recordOutput('stdout', trimmed);
      return;
    }
    if (!isRecord(parsed)) return;
    if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
      this.handleResponse(parsed);
      return;
    }
    if ('id' in parsed && typeof parsed['method'] === 'string') {
      this.handleAgentRequest(parsed);
      return;
    }
    if (
      stringField(parsed, 'method') === 'session/update' ||
      stringField(parsed, 'method') === 'session/notification'
    ) {
      await this.handleNotification(parsed);
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = rpcIdKey(message['id']);
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.cleanup();
    this.pending.delete(id);
    const error = isRecord(message['error']) ? message['error'] : undefined;
    if (error) {
      pending.reject(new GrokJsonRpcError(pending.method, error));
      return;
    }
    pending.resolve(isRecord(message['result']) ? message['result'] : undefined);
  }

  private handleAgentRequest(message: Record<string, unknown>): void {
    const id = message['id'];
    const method = stringField(message, 'method');
    if (id === undefined || !method) return;
    if (method === 'session/request_permission') {
      this.writeJson({
        id,
        jsonrpc: '2.0',
        result: {
          outcome: {
            optionId: grokPermissionApprovalOptionId(message) ?? 'approve_for_session',
            outcome: 'selected',
          },
        },
      });
      return;
    }
    this.writeJson({
      error: {
        code: -32601,
        message: `method not found: ${method}`,
      },
      id,
      jsonrpc: '2.0',
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.writeJson({ jsonrpc: '2.0', method, params });
  }

  private captureModelAuthority(result: Record<string, unknown> | undefined): void {
    const meta = isRecord(result?.['_meta']) ? result['_meta'] : undefined;
    const modelState = firstRecord(result?.['models'], result?.['modelState'], meta?.['modelState']);
    const currentModel = stringField(modelState, 'currentModelId') ?? grokResultModel(result);
    if (currentModel) this.actualModel = currentModel;
    const models = Array.isArray(modelState?.['availableModels']) ? modelState['availableModels'].filter(isRecord) : [];
    const selected = models.find((model) => stringField(model, 'modelId') === currentModel);
    const selectedMeta = isRecord(selected?.['_meta']) ? selected['_meta'] : undefined;
    const contextWindow = numberField(selectedMeta, 'totalContextTokens') ?? numberField(meta, 'totalContextTokens');
    if (contextWindow !== undefined) this.contextWindow = contextWindow;
  }

  private async handleNotification(message: Record<string, unknown>): Promise<void> {
    const params = isRecord(message['params']) ? message['params'] : undefined;
    const update = params?.['update'];
    if (!update) return;
    const { data, type } = normalizeAcpUpdate(update);
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
        eventType: 'grok.thinking.delta',
        runtimeKind: GROK_RUNTIME_KIND,
        text: truncateForActivity(text),
        transport: 'acp',
      });
      await turn.input.effects.recordEvent(
        exposedReasoningEvent({
          provider: 'grok',
          runtimeKind: GROK_RUNTIME_KIND,
          sourceEventType: 'grok.thinking.delta',
          text,
          textKind: 'think',
        }),
      );
      return;
    }
    if (type === 'tool_call') {
      await this.handleToolCallStart(turn.input, data);
      return;
    }
    if (type === 'tool_call_update') {
      await this.handleToolCallUpdate(turn.input, data);
      return;
    }
    if (type === 'usage_update') {
      const usage = acpUsagePayload(data);
      if (!usage) return;
      this.latestUsage = usage;
      await turn.input.effects.recordEvent({
        ...usage,
        eventType: 'grok.context.stats',
        runtimeKind: GROK_RUNTIME_KIND,
      });
    }
  }

  private async handleToolCallStart(input: AgentRuntimeInput, data: Record<string, unknown>): Promise<void> {
    const id = toolCallId(data);
    if (!id) return;
    const rawInput = toolInput(data);
    const name = grokToolName(data);
    this.activeToolIds.add(id);
    if (rawInput) {
      // Emit immediately when we can show a useful target/command; otherwise wait
      // for tool_call_update which often carries target_file / locations / title.
      const summary = summarizeGrokToolInput(name, rawInput, data);
      if (summary.target || summary.command || summary.diff) {
        this.pendingTools.set(id, { emitted: true, input: rawInput, name });
        await this.emitToolStarted(input, id, name, rawInput, data);
        return;
      }
      this.pendingTools.set(id, { emitted: false, input: rawInput, name });
      return;
    }
    this.pendingTools.set(id, {
      argsText: extractAcpToolCallText(data['content']),
      emitted: false,
      name,
    });
  }

  private async handleToolCallUpdate(input: AgentRuntimeInput, data: Record<string, unknown>): Promise<void> {
    const id = toolCallId(data);
    if (!id) return;
    const status = stringField(data, 'status');
    const pending = this.pendingTools.get(id);
    const contentText = extractAcpToolCallText(data['content']);
    const rawInput = toolInput(data);
    const rawOutput = stringField(data, 'rawOutput') ?? stringField(data, 'output');
    const terminal = status === 'completed' || status === 'failed';
    if (pending && !pending.emitted) {
      if (rawInput) pending.input = rawInput;
      else if (contentText && (!terminal || !rawOutput)) {
        pending.argsText = contentText;
      }
    }
    if (!terminal) {
      return;
    }

    await this.emitDeferredToolStarted(input, id, pending, data, rawInput ?? pending?.input);
    const output = rawOutput ?? extractAcpToolCallText(data['content']);
    await input.effects.recordEvent({
      eventType: 'grok.tool_result',
      isError: status === 'failed',
      output: output ? truncateForActivity(output) : undefined,
      providerToolId: id,
      runtimeKind: GROK_RUNTIME_KIND,
      transport: 'acp',
    });
    if (status === 'failed') {
      await input.effects.recordToolFailed({
        error: output ? truncateForActivity(output) : 'Grok tool failed',
        provider: GROK_RUNTIME_KIND,
        providerToolId: id,
        runtimeKind: GROK_RUNTIME_KIND,
        tool: pending?.name ? `grok.${pending.name}` : 'grok.tool',
      });
    }
    this.pendingTools.delete(id);
    this.activeToolIds.delete(id);
    this.resolveQuiescentWaitersIfReady();
  }

  private async emitDeferredToolStarted(
    input: AgentRuntimeInput,
    id: string,
    pending: PendingTool | undefined,
    data: Record<string, unknown>,
    rawInput: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (pending?.emitted) return;
    // Prefer the latest ACP frame only when it actually supplies identity
    // (meta/title often enrich on update); otherwise keep the start-frame name.
    const name = grokToolIdentity(data) ?? pending?.name ?? 'Tool';
    const parsedInput = rawInput ?? parseToolArguments(pending?.argsText ?? extractAcpToolCallText(data['content']));
    await this.emitToolStarted(
      input,
      id,
      name,
      isRecord(parsedInput) ? parsedInput : { text: parsedInput },
      data,
    );
  }

  private async emitToolStarted(
    input: AgentRuntimeInput,
    id: string,
    name: string,
    rawInput: Record<string, unknown>,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const summary = summarizeGrokToolInput(name, rawInput, data);
    await input.effects.recordToolStarted({
      eventType: 'grok.tool.call',
      provider: GROK_RUNTIME_KIND,
      providerToolId: id,
      providerToolName: name,
      ...(summary.command ? { command: summary.command } : {}),
      ...(summary.target ? { target: summary.target } : {}),
      ...(summary.diff ? { diff: summary.diff } : {}),
      runtimeKind: GROK_RUNTIME_KIND,
      tool: `grok.${name}`,
      transport: 'acp',
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const id = this.nextRequestId++;
    const idKey = String(id);
    return new Promise((resolve, reject) => {
      const pending: PendingRpc = {
        cleanup: () => {
          this.pending.delete(idKey);
        },
        method,
        reject,
        resolve,
      };
      this.pending.set(idKey, pending);
      try {
        this.writeJson({ id, jsonrpc: '2.0', method, params });
      } catch (error) {
        pending.cleanup();
        reject(error);
      }
    });
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
    this.currentTurn = undefined;
    this.activeToolIds.clear();
    this.pendingTools.clear();
    this.resolveQuiescentWaitersIfReady();
    if (this.latestUsage) {
      await turn.input.effects.recordEvent({
        ...this.latestUsage,
        eventType: 'grok.context.stats',
        runtimeKind: GROK_RUNTIME_KIND,
      });
    }
    const text = turn.text.join('').trim();
    if (text)
      await turn.input.effects.recordAgentText(text, {
        eventType: 'grok.assistant',
        transport: 'acp',
      });
    turn.resolve(text);
  }

  private resolveQuiescentWaitersIfReady(): void {
    this.quiescentWaiters.resolveIfReady(() => this.activeToolIds.size === 0);
  }

  private rejectQuiescentWaiters(error: unknown): void {
    this.quiescentWaiters.reject(error);
  }

  private rejectAllPending(error: unknown): void {
    for (const pending of [...this.pending.values()]) {
      pending.cleanup();
      pending.reject(error);
    }
  }

  private writeJson(payload: Record<string, unknown>): void {
    this.child.writeStdin(`${JSON.stringify(payload)}\n`);
  }
}

function grokPrimaryPrompt(input: AgentRuntimeInput): string {
  const systemPrompt = input.systemPrompt?.trim();
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${input.prompt}` : input.prompt;
}

function isGrokSessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof GrokJsonRpcError)) return false;
  if (error.method !== 'session/load') return false;
  return /(?:unknown|missing|not\s+found|no\s+such).{0,40}session|session.{0,40}(?:unknown|missing|not\s+found|no\s+such)|fs_not_found/i.test(
    error.message,
  );
}

function grokPermissionApprovalOptionId(message: Record<string, unknown>): string | undefined {
  const params = isRecord(message['params']) ? message['params'] : undefined;
  const options = Array.isArray(params?.['options']) ? params['options'].filter(isRecord) : [];
  return (
    findGrokPermissionOptionId(options, isAlwaysAllowGrokPermissionOption) ??
    findGrokPermissionOptionId(options, isAllowGrokPermissionOption)
  );
}

function findGrokPermissionOptionId(
  options: Record<string, unknown>[],
  predicate: (option: Record<string, unknown>) => boolean,
): string | undefined {
  for (const option of options) {
    const optionId = grokPermissionOptionId(option);
    if (!optionId) continue;
    if (predicate(option)) return optionId;
  }
  return undefined;
}

function grokPermissionOptionId(option: Record<string, unknown>): string | undefined {
  return stringField(option, 'optionId') ?? stringField(option, 'option_id') ?? stringField(option, 'id');
}

function isAlwaysAllowGrokPermissionOption(option: Record<string, unknown>): boolean {
  const key = grokPermissionOptionKey(option);
  return /\b(allow|approve)[_-]?(always|session)\b/.test(key) || /\b(always|session)[_-]?(allow|approve)\b/.test(key);
}

function isAllowGrokPermissionOption(option: Record<string, unknown>): boolean {
  const key = grokPermissionOptionKey(option);
  if (/\b(reject|deny|decline|cancel|disallow)\b/.test(key)) return false;
  return /\b(allow|approve|accept|permit)\b/.test(key);
}

function grokPermissionOptionKey(option: Record<string, unknown>): string {
  return [
    grokPermissionOptionId(option),
    stringField(option, 'kind'),
    stringField(option, 'type'),
    stringField(option, 'name'),
    stringField(option, 'label'),
    stringField(option, 'title'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ' ');
}

function grokAcpInitializeEvent(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const event: Record<string, unknown> = {
    eventType: 'grok.system.init',
    runtimeKind: GROK_RUNTIME_KIND,
    transport: 'acp',
  };
  const protocolVersion = numberField(result, 'protocolVersion') ?? stringField(result, 'protocolVersion');
  if (protocolVersion !== undefined) event['protocolVersion'] = protocolVersion;
  const agentCapabilities = isRecord(result['agentCapabilities']) ? result['agentCapabilities'] : undefined;
  const capabilities = isRecord(result['capabilities']) ? result['capabilities'] : agentCapabilities;
  if (capabilities) event['capabilityCount'] = Object.keys(capabilities).length;
  const meta = isRecord(result['_meta']) ? result['_meta'] : undefined;
  const server = isRecord(result['server'])
    ? result['server']
    : isRecord(result['serverInfo'])
      ? result['serverInfo']
      : undefined;
  const clientInfo = isRecord(result['clientInfo']) ? result['clientInfo'] : undefined;
  const info = server ?? clientInfo;
  if (info) {
    const name = stringField(info, 'name');
    const version = stringField(info, 'version');
    if (name) event['serverName'] = name;
    if (version) event['serverVersion'] = version;
  }
  const agentVersion = stringField(meta, 'agentVersion');
  if (agentVersion) event['serverVersion'] = agentVersion;
  return event;
}

function extractSessionId(result: Record<string, unknown> | undefined): string | undefined {
  return stringField(result, 'sessionId') ?? stringField(result, 'session_id');
}

function acpUsagePayload(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const meta = isRecord(record?.['_meta']) ? record['_meta'] : undefined;
  const usage = firstRecord(record?.['usage'], meta?.['usage'], meta?.['tokenUsage'], meta, record);
  if (!usage) return undefined;
  const output: Record<string, unknown> = {};
  copyNumberLike(usage, output, ['inputTokens', 'input_tokens'], 'inputTokens');
  copyNumberLike(usage, output, ['outputTokens', 'output_tokens'], 'outputTokens');
  copyNumberLike(usage, output, ['totalTokens', 'total_tokens'], 'totalTokens');
  copyNumberLike(
    usage,
    output,
    ['cachedTokens', 'cachedReadTokens', 'cacheReadInputTokens', 'cached_read_tokens'],
    'cacheReadInputTokens',
  );
  copyNumberLike(usage, output, ['reasoningTokens', 'reasoning_tokens'], 'reasoningTokens');
  copyNumberLike(usage, output, ['contextTokens', 'context_tokens', 'currentContextTokens'], 'currentContextTokens');
  copyNumberLike(usage, output, ['contextWindow', 'maxContextTokens', 'max_context_tokens'], 'contextWindow');
  return Object.keys(output).length > 0 ? output : undefined;
}

function grokResultModel(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const meta = isRecord(record['_meta']) ? record['_meta'] : undefined;
  return (
    stringField(record, 'modelId') ??
    stringField(record, 'model') ??
    stringField(meta, 'modelId') ??
    stringField(meta, 'resolvedModelId') ??
    stringField(meta, 'model')
  );
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord) as Record<string, unknown> | undefined;
}

function copyNumberLike(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  from: string[],
  to: string,
): void {
  for (const key of from) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      target[to] = value;
      return;
    }
  }
}

function normalizeAcpUpdate(value: unknown): {
  data: Record<string, unknown>;
  type: string;
} {
  if (isRecord(value)) {
    const sessionUpdate = stringField(value, 'sessionUpdate') ?? stringField(value, 'type');
    if (sessionUpdate) return { data: value, type: normalizeAcpUpdateType(sessionUpdate) };
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [key, data] = entries[0] ?? [];
      return {
        data: isRecord(data) ? data : {},
        type: normalizeAcpUpdateType(key ?? ''),
      };
    }
    return { data: value, type: '' };
  }
  return { data: {}, type: '' };
}

function normalizeAcpUpdateType(type: string): string {
  const key = type.trim().toLowerCase().replace(/[_-]/g, '');
  switch (key) {
    case 'agentmessagechunk':
      return 'agent_message_chunk';
    case 'agentthoughtchunk':
      return 'agent_thought_chunk';
    case 'toolcall':
      return 'tool_call';
    case 'toolcallupdate':
      return 'tool_call_update';
    case 'usageupdate':
      return 'usage_update';
    case 'turnend':
    case 'endturn':
      return 'turn_end';
    default:
      return '';
  }
}

function extractAcpText(data: Record<string, unknown>): string | undefined {
  if (typeof data['text'] === 'string') return data['text'];
  if (typeof data['delta'] === 'string') return data['delta'];
  const content = data['content'];
  if (typeof content === 'string') return content;
  if (isRecord(content)) {
    return stringField(content, 'text') ?? stringField(content, 'delta');
  }
  return undefined;
}

function toolCallId(data: Record<string, unknown>): string | undefined {
  return stringField(data, 'toolCallId') ?? stringField(data, 'tool_call_id') ?? stringField(data, 'id');
}

function toolInput(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const rawInput = data['rawInput'] ?? data['input'] ?? data['parameters'];
  return isRecord(rawInput) ? rawInput : undefined;
}

function extractAcpToolCallText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'content') {
      const inner = block['content'];
      if (typeof inner === 'string') {
        parts.push(inner);
        continue;
      }
      if (isRecord(inner) && stringField(inner, 'type') === 'text') {
        const text = stringField(inner, 'text');
        if (text) parts.push(text);
      }
      continue;
    }
    if (block['type'] === 'diff') {
      const path = stringField(block, 'path');
      if (!path) continue;
      const oldText = typeof block['oldText'] === 'string' ? block['oldText'] : '';
      const newText = typeof block['newText'] === 'string' ? block['newText'] : '';
      parts.push(
        `--- ${path}\n+++ ${path}\n${oldText ? `(edited: ${oldText.length} -> ${newText.length} bytes)` : `(new file, ${newText.length} bytes)`}`,
      );
    }
  }
  return parts.join('\n');
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw.trim() ? { text: truncateForActivity(raw) } : {};
  }
}

/**
 * Resolve Grok ACP tool identity for Activity. Prefer canonical
 * `_meta['x.ai/tool'].name` (e.g. list_dir), then title/kind patterns.
 * Live ListDir shape: title `List \`path\``, kind Other, meta name list_dir.
 */
export function grokToolName(data: Record<string, unknown>): string {
  return grokToolIdentity(data) ?? 'Tool';
}

/**
 * Tool identity from a single ACP frame, or undefined when the frame supplies no
 * identity signal (no meta name / title / kind / name). Distinguishing "identity
 * absent" from the intentional `Tool` fallback lets a terminal update without
 * identity keep the start frame's already-resolved name instead of clobbering it.
 */
export function grokToolIdentity(data: Record<string, unknown>): string | undefined {
  const meta = isRecord(data['_meta']) ? data['_meta'] : undefined;
  const xaiTool = isRecord(meta?.['x.ai/tool']) ? meta['x.ai/tool'] : undefined;
  const metaName =
    stringField(xaiTool, 'name') ??
    stringField(xaiTool, 'id') ??
    stringField(data, 'name');
  if (metaName) {
    const fromMeta = grokCanonicalToolName(metaName);
    if (fromMeta) return fromMeta;
  }

  const title = stringField(data, 'title') ?? '';
  const kind = stringField(data, 'kind') ?? '';
  // No identity fields in this frame — let the caller keep any prior identity.
  const candidateSource = title || kind || metaName || '';
  if (!candidateSource) return undefined;
  const candidate = candidateSource.trim();
  const normalized = candidate.toLowerCase();
  if (/(run command|shell|bash|terminal)/.test(normalized)) return 'Shell';
  if (/(read file|\bread\b)/.test(normalized)) return 'ReadFile';
  if (/(write file|\bwrite\b)/.test(normalized)) return 'WriteFile';
  if (/(edit|patch|replace)/.test(normalized)) return 'StrReplaceFile';
  if (/web search/.test(normalized)) return 'WebSearch';
  if (/(fetch|web fetch)/.test(normalized)) return 'Fetch';
  // List `server/providers` — must not fall through to ListServerProviders.
  if (/^list\b/.test(normalized) || /\blist[_ ]?dir\b/.test(normalized)) return 'ListDir';
  if (/search/.test(normalized)) return 'Search';
  if (/glob/.test(normalized)) return 'Glob';
  if (/todo/.test(normalized)) return 'TodoWrite';
  const base = candidate.split(':')[0]?.trim() || 'Tool';
  return base
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char: string) => char.toUpperCase())
    .replace(/^[a-z]/, (char) => char.toUpperCase());
}

function grokCanonicalToolName(raw: string): string | undefined {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (key) {
    case 'list_dir':
    case 'listdir':
    case 'list_directory':
      return 'ListDir';
    case 'read_file':
    case 'readfile':
      return 'ReadFile';
    case 'write_file':
    case 'writefile':
      return 'WriteFile';
    case 'str_replace_file':
    case 'strreplacefile':
    case 'str_replace':
      return 'StrReplaceFile';
    case 'run_command':
    case 'shell':
    case 'bash':
      return 'Shell';
    case 'web_search':
    case 'websearch':
      return 'WebSearch';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    default:
      return undefined;
  }
}

/** Exported for unit tests — keep Activity targets aligned with live Grok ACP. */
export function summarizeGrokToolInput(
  name: string,
  input: Record<string, unknown>,
  data?: Record<string, unknown>,
): { command?: string; diff?: string; target?: string } {
  const normalized = name.toLowerCase();
  if (normalized === 'shell' || normalized === 'bash') {
    const command = stringField(input, 'command') ?? stringField(input, 'cmd');
    const description = stringField(input, 'description');
    return {
      ...(command ? { command: singleLineForActivity(command) } : {}),
      ...(description
        ? { target: singleLineForActivity(description) }
        : command
          ? { target: singleLineForActivity(command) }
          : {}),
    };
  }
  const target = grokToolTarget(input, data);
  return {
    ...(target ? { target: singleLineForActivity(target) } : {}),
    ...(normalized === 'strreplacefile' ? { diff: grokReplacementDiff(input) } : {}),
  };
}

/**
 * Grok Build ACP uses `target_file` / `target_directory` (not Claude's file_path).
 * Later tool_call_update frames also carry locations[] and titled paths in backticks.
 */
function grokToolTarget(input: Record<string, unknown>, data?: Record<string, unknown>): string | undefined {
  const fromInput =
    stringField(input, 'target_file') ??
    stringField(input, 'targetFile') ??
    stringField(input, 'target_directory') ??
    stringField(input, 'targetDirectory') ??
    stringField(input, 'file_path') ??
    stringField(input, 'path') ??
    stringField(input, 'filePath') ??
    stringField(input, 'absolute_path') ??
    stringField(input, 'absolutePath') ??
    stringField(input, 'pattern') ??
    stringField(input, 'query') ??
    stringField(input, 'glob') ??
    stringField(input, 'url');
  if (fromInput) return fromInput;

  const locations = Array.isArray(data?.['locations']) ? data['locations'] : [];
  for (const location of locations) {
    if (!isRecord(location)) continue;
    const path = stringField(location, 'path');
    if (path) return path;
  }

  const meta = isRecord(data?.['_meta']) ? data['_meta'] : undefined;
  const xaiTool = isRecord(meta?.['x.ai/tool']) ? meta['x.ai/tool'] : undefined;
  const metaInput = isRecord(xaiTool?.['input']) ? xaiTool['input'] : undefined;
  const metaPath =
    stringField(metaInput, 'path') ??
    stringField(metaInput, 'target_file') ??
    stringField(metaInput, 'target_directory');
  if (metaPath) return metaPath;

  // e.g. title: Read `PROBE.txt`
  const title = stringField(data, 'title') ?? '';
  const tick = title.match(/`([^`]+)`/);
  if (tick?.[1]?.trim()) return tick[1].trim();

  return undefined;
}

function grokReplacementDiff(input: Record<string, unknown>): string | undefined {
  const edit = isRecord(input['edit']) ? input['edit'] : undefined;
  const before =
    stringField(input, 'old_str') ??
    stringField(input, 'oldString') ??
    stringField(input, 'old_string') ??
    stringField(input, 'old') ??
    stringField(edit, 'old');
  const after =
    stringField(input, 'new_str') ??
    stringField(input, 'newString') ??
    stringField(input, 'new_string') ??
    stringField(input, 'new') ??
    stringField(edit, 'new');
  if (!before && !after) return undefined;
  return truncateForActivity(`--- old\n${before ?? ''}\n+++ new\n${after ?? ''}`);
}

function rpcIdKey(id: unknown): string | undefined {
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

function jsonRpcErrorMessage(method: string, error: Record<string, unknown>): string {
  const message = stringField(error, 'message') ?? 'Unknown JSON-RPC error';
  const code = numberField(error, 'code');
  const data = error['data'];
  const renderedData = typeof data === 'string' ? data : data === undefined ? undefined : JSON.stringify(data);
  return [
    `${method}: ${message}`,
    code === undefined ? undefined : `code=${code}`,
    renderedData ? `data=${renderedData}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}
