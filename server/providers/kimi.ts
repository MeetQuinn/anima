import { nowIso } from '../ids.js';
import { isRecord, numberField, singleLineForActivity, stringField } from '../json.js';
import { ActiveRuntimeRun } from './active-runtime.js';
import { runtimeErrorPayload, truncateForActivity } from '../activities/format.js';
import { startChildProcess, terminateChildProcess, type RunningChildProcess } from './child-process.js';
import { exposedReasoningEvent } from './reasoning-events.js';
import {
  providerSessionPayload,
  type AgentRuntimeCloseOptions,
  type AgentRuntime,
  type AgentRuntimeDrainInput,
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeHealth,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type KimiCliAgentProviderConfig,
} from './contract.js';

const KIMI_COMMAND = 'kimi';
const KIMI_RUNTIME_KIND = 'kimi-cli';

export class KimiCliAgentRuntime implements AgentRuntime {
  readonly env: Record<string, string> | undefined;
  readonly kind = KIMI_RUNTIME_KIND;
  private readonly config: KimiCliAgentProviderConfig;
  private controller?: KimiAcpController;
  private readonly activeRun = new ActiveRuntimeRun();

  constructor(config: KimiCliAgentProviderConfig) {
    this.config = config;
    this.env = config.env;
  }

  async close(options: AgentRuntimeCloseOptions = {}): Promise<void> {
    await this.resetController(options.signal, options);
  }

  health(): AgentRuntimeHealth {
    return {
      ...(this.controller ? { child: this.controller.snapshot() } : {}),
      childExpected: this.activeRun.isActive(),
    };
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    await input.effects.recordRuntime('runtime.started', {
      command: KIMI_COMMAND,
      providerSession: providerSessionPayload(input.providerSession, this.kind),
      transport: 'acp',
    });

    const finishRun = this.activeRun.start(input, 'Kimi', (signal) => void this.resetController(signal));
    try {
      const controller = await this.ensureController(input);
      await input.effects.persistProviderSession({
        id: controller.sessionId,
        updatedAt: nowIso(),
      });
      const text = await controller.startTurn(input, kimiPrimaryPrompt(input));
      await input.effects.recordRuntime('runtime.completed');
      return text.trim() ? { text: text.trim() } : {};
    } catch (error) {
      if (!input.suppressFailureRecord) {
        await input.effects.recordRuntime('runtime.failed', runtimeErrorPayload(error));
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
    if (!controller.appendPrompt(input.prompt)) return { accepted: false };
    return { accepted: true, text: 'queued for Kimi ACP session' };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    const controller = this.controller;
    if (!this.activeRun.accepts(input)) return;
    if (!controller) return;
    await controller.waitForQuiescent(input.signal);
  }

  private async ensureController(input: AgentRuntimeInput): Promise<KimiAcpController> {
    const requestedSessionId = input.providerSession?.id;
    if (this.controller && requestedSessionId && this.controller.sessionId !== requestedSessionId) {
      await this.resetController();
    }
    if (this.controller && !requestedSessionId && this.controller.sessionId) {
      await this.resetController();
    }
    if (!this.controller) {
      let controller!: KimiAcpController;
      controller = new KimiAcpController(
        startChildProcess({
          args: ['--yolo', 'acp'],
          bufferOutput: false,
          command: KIMI_COMMAND,
          cwd: input.cwd,
          env: input.env,
          label: 'Kimi ACP runtime',
          onStderrChunk: (chunk) => controller.acceptStderrChunk(chunk),
          onStdoutChunk: async (chunk) => {
            await controller.acceptStdoutChunk(chunk);
          },
        }),
      );
      this.controller = controller;
      controller.completion
        .catch(() => {})
        .finally(() => {
          if (this.controller === controller) this.controller = undefined;
        });
    }
    try {
      await this.controller.ensureSession(input, this.config.model);
      return this.controller;
    } catch (error) {
      await this.resetController();
      throw error;
    }
  }

  private async resetController(
    signal: NodeJS.Signals = 'SIGTERM',
    options: Pick<AgentRuntimeCloseOptions, 'forceAfterMs'> = {},
  ): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    this.controller = undefined;
    await terminateChildProcess(controller, {
      signal,
      ...(options.forceAfterMs === undefined ? {} : { forceAfterMs: options.forceAfterMs }),
    });
  }
}

interface PendingRpc {
  cleanup(): void;
  method: string;
  reject(error: unknown): void;
  resolve(value: Record<string, unknown> | undefined): void;
}

interface KimiTurn {
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

class KimiAcpController {
  private buffer = '';
  private initialized?: Promise<void>;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly pendingTools = new Map<string, PendingTool>();
  private currentTurn?: KimiTurn;
  private readonly activeToolIds = new Set<string>();
  private readonly quiescentWaiters = new Set<{
    cleanup(): void;
    reject(error: unknown): void;
    resolve(): void;
  }>();
  private latestUsage?: Record<string, unknown>;
  readonly completion: Promise<{ stdout: string; stderr: string }>;
  sessionId = '';

  constructor(private readonly child: RunningChildProcess) {
    this.completion = child.completion.then(
      (result) => {
        this.rejectAllPending(new Error('Kimi ACP runtime exited'));
        this.rejectQuiescentWaiters(new Error('Kimi ACP runtime exited before drain reached a quiescent point'));
        this.abortCurrentTurn(new Error('Kimi ACP runtime exited before completing active turn'));
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

  async ensureSession(input: AgentRuntimeInput, model: string | undefined): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initializeSession(input, model).catch((error) => {
        this.initialized = undefined;
        throw error;
      });
    }
    await this.initialized;
  }

  async startTurn(input: AgentRuntimeInput, prompt: string): Promise<string> {
    if (this.currentTurn) throw new Error('Kimi ACP runtime already has an active turn');
    const result = new Promise<string>((resolve, reject) => {
      this.currentTurn = { acceptingFollowups: true, followups: [], input, reject, resolve, text: [] };
    });
    void this.runTurnQueue(prompt).catch((error) => this.abortCurrentTurn(error));
    return result;
  }

  appendPrompt(prompt: string): boolean {
    const turn = this.currentTurn;
    if (!turn) return false;
    if (!turn.acceptingFollowups) return false;
    turn.followups.push(prompt);
    return true;
  }

  async acceptStdoutChunk(chunk: string): Promise<void> {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
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
    if (this.activeToolIds.size === 0) return Promise.resolve();
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

  private async initializeSession(input: AgentRuntimeInput, model: string | undefined): Promise<void> {
    const initResult = await this.request('initialize', {
      clientCapabilities: {},
      clientInfo: { name: 'anima', version: '0.1.0' },
      protocolVersion: 1,
    });
    const initEvent = kimiAcpInitializeEvent(initResult);
    if (initEvent) await input.effects.recordEvent(initEvent);

    const requestedSessionId = input.providerSession?.id;
    if (requestedSessionId) {
      const result = await this.request('session/resume', {
        cwd: input.cwd,
        mcpServers: [],
        sessionId: requestedSessionId,
      });
      this.sessionId = extractSessionId(result) ?? requestedSessionId;
    } else {
      const result = await this.request('session/new', {
        cwd: input.cwd,
        mcpServers: [],
      });
      const sessionId = extractSessionId(result);
      if (!sessionId) throw new Error('Kimi ACP session/new returned no sessionId');
      this.sessionId = sessionId;
    }

    if (model) {
      await this.request('session/set_model', {
        modelId: model,
        sessionId: this.sessionId,
      });
    }
  }

  private async runTurnQueue(firstPrompt: string): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    let prompt: string | undefined = firstPrompt;
    while (prompt !== undefined) {
      await this.runOnePrompt(turn, prompt);
      prompt = turn.followups.shift();
    }
    turn.acceptingFollowups = false;
    await this.finishCurrentTurn();
  }

  private async runOnePrompt(turn: KimiTurn, prompt: string): Promise<void> {
    await turn.input.effects.recordEvent({
      eventType: 'kimi.turn.started',
      runtimeKind: KIMI_RUNTIME_KIND,
      transport: 'acp',
      userInputLength: prompt.length,
    });
    const result = await this.request('session/prompt', {
      prompt: [{ text: prompt, type: 'text' }],
      sessionId: this.sessionId,
    });
    const usage = acpUsagePayload(result);
    if (usage) {
      this.latestUsage = usage;
      await turn.input.effects.recordEvent({
        ...usage,
        eventType: 'kimi.context.stats',
        model: stringField(result, 'model') ?? stringField(result, 'modelId'),
        runtimeKind: KIMI_RUNTIME_KIND,
        terminalReason: stringField(result, 'stopReason'),
      });
    }
    await turn.input.effects.recordEvent({
      eventType: 'kimi.turn.completed',
      runtimeKind: KIMI_RUNTIME_KIND,
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
    if (stringField(parsed, 'method') === 'session/update' || stringField(parsed, 'method') === 'session/notification') {
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
      pending.reject(new Error(jsonRpcErrorMessage(pending.method, error)));
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
            optionId: kimiPermissionApprovalOptionId(message) ?? 'approve_for_session',
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
        eventType: 'kimi.thinking.delta',
        runtimeKind: KIMI_RUNTIME_KIND,
        text: truncateForActivity(text),
        transport: 'acp',
      });
      await turn.input.effects.recordEvent(exposedReasoningEvent({
        provider: 'kimi',
        runtimeKind: KIMI_RUNTIME_KIND,
        sourceEventType: 'kimi.thinking.delta',
        text,
        textKind: 'think',
      }));
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
        eventType: 'kimi.context.stats',
        runtimeKind: KIMI_RUNTIME_KIND,
      });
    }
  }

  private async handleToolCallStart(input: AgentRuntimeInput, data: Record<string, unknown>): Promise<void> {
    const id = toolCallId(data);
    if (!id) return;
    const rawInput = toolInput(data);
    const name = kimiToolNameFromTitle(
      stringField(data, 'title') ?? stringField(data, 'name') ?? stringField(data, 'kind') ?? '',
      stringField(data, 'kind'),
    );
    this.activeToolIds.add(id);
    if (rawInput) {
      this.pendingTools.set(id, { emitted: true, input: rawInput, name });
      await this.emitToolStarted(input, id, name, rawInput);
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
      eventType: 'kimi.tool_result',
      isError: status === 'failed',
      output: output ? truncateForActivity(output) : undefined,
      providerToolId: id,
      runtimeKind: KIMI_RUNTIME_KIND,
      transport: 'acp',
    });
    if (status === 'failed') {
      await input.effects.recordToolFailed({
        error: output ? truncateForActivity(output) : 'Kimi tool failed',
        provider: KIMI_RUNTIME_KIND,
        providerToolId: id,
        runtimeKind: KIMI_RUNTIME_KIND,
        tool: pending?.name ? `kimi.${pending.name}` : 'kimi.tool',
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
    const name =
      pending?.name ??
      kimiToolNameFromTitle(stringField(data, 'title') ?? stringField(data, 'name') ?? stringField(data, 'kind') ?? '', stringField(data, 'kind'));
    const parsedInput = rawInput ?? parseToolArguments(pending?.argsText ?? extractAcpToolCallText(data['content']));
    await this.emitToolStarted(input, id, name, isRecord(parsedInput) ? parsedInput : { text: parsedInput });
  }

  private async emitToolStarted(
    input: AgentRuntimeInput,
    id: string,
    name: string,
    rawInput: Record<string, unknown>,
  ): Promise<void> {
    const summary = summarizeKimiToolInput(name, rawInput);
    await input.effects.recordToolStarted({
      eventType: 'kimi.tool.call',
      provider: KIMI_RUNTIME_KIND,
      providerToolId: id,
      providerToolName: name,
      ...(summary.command ? { command: summary.command } : {}),
      ...(summary.target ? { target: summary.target } : {}),
      ...(summary.diff ? { diff: summary.diff } : {}),
      runtimeKind: KIMI_RUNTIME_KIND,
      tool: `kimi.${name}`,
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
        eventType: 'kimi.context.stats',
        runtimeKind: KIMI_RUNTIME_KIND,
      });
    }
    const text = turn.text.join('').trim();
    if (text) await turn.input.effects.recordAgentText(text, { eventType: 'kimi.assistant', transport: 'acp' });
    turn.resolve(text);
  }

  private resolveQuiescentWaitersIfReady(): void {
    if (this.activeToolIds.size > 0) return;
    for (const waiter of [...this.quiescentWaiters]) waiter.resolve();
  }

  private rejectQuiescentWaiters(error: unknown): void {
    for (const waiter of [...this.quiescentWaiters]) waiter.reject(error);
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

function kimiPrimaryPrompt(input: AgentRuntimeInput): string {
  const systemPrompt = input.systemPrompt?.trim();
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${input.prompt}` : input.prompt;
}

function kimiPermissionApprovalOptionId(message: Record<string, unknown>): string | undefined {
  const params = isRecord(message['params']) ? message['params'] : undefined;
  const options = Array.isArray(params?.['options']) ? params['options'].filter(isRecord) : [];
  return (
    findKimiPermissionOptionId(options, isAlwaysAllowKimiPermissionOption) ??
    findKimiPermissionOptionId(options, isAllowKimiPermissionOption)
  );
}

function findKimiPermissionOptionId(
  options: Record<string, unknown>[],
  predicate: (option: Record<string, unknown>) => boolean,
): string | undefined {
  for (const option of options) {
    const optionId = kimiPermissionOptionId(option);
    if (!optionId) continue;
    if (predicate(option)) return optionId;
  }
  return undefined;
}

function kimiPermissionOptionId(option: Record<string, unknown>): string | undefined {
  return stringField(option, 'optionId') ?? stringField(option, 'option_id') ?? stringField(option, 'id');
}

function isAlwaysAllowKimiPermissionOption(option: Record<string, unknown>): boolean {
  const key = kimiPermissionOptionKey(option);
  return /\b(allow|approve)[_-]?(always|session)\b/.test(key) || /\b(always|session)[_-]?(allow|approve)\b/.test(key);
}

function isAllowKimiPermissionOption(option: Record<string, unknown>): boolean {
  const key = kimiPermissionOptionKey(option);
  if (/\b(reject|deny|decline|cancel|disallow)\b/.test(key)) return false;
  return /\b(allow|approve|accept|permit)\b/.test(key);
}

function kimiPermissionOptionKey(option: Record<string, unknown>): string {
  return [
    kimiPermissionOptionId(option),
    stringField(option, 'kind'),
    stringField(option, 'type'),
    stringField(option, 'name'),
    stringField(option, 'label'),
    stringField(option, 'title'),
  ].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9_-]+/g, ' ');
}

function kimiAcpInitializeEvent(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const event: Record<string, unknown> = {
    eventType: 'kimi.system.init',
    runtimeKind: KIMI_RUNTIME_KIND,
    transport: 'acp',
  };
  const protocolVersion = numberField(result, 'protocolVersion') ?? stringField(result, 'protocolVersion');
  if (protocolVersion !== undefined) event['protocolVersion'] = protocolVersion;
  const agentCapabilities = isRecord(result['agentCapabilities']) ? result['agentCapabilities'] : undefined;
  const capabilities = isRecord(result['capabilities']) ? result['capabilities'] : agentCapabilities;
  if (capabilities) event['capabilityCount'] = Object.keys(capabilities).length;
  const server = isRecord(result['server']) ? result['server'] : isRecord(result['serverInfo']) ? result['serverInfo'] : undefined;
  const clientInfo = isRecord(result['clientInfo']) ? result['clientInfo'] : undefined;
  const info = server ?? clientInfo;
  if (info) {
    const name = stringField(info, 'name');
    const version = stringField(info, 'version');
    if (name) event['serverName'] = name;
    if (version) event['serverVersion'] = version;
  }
  return event;
}

function extractSessionId(result: Record<string, unknown> | undefined): string | undefined {
  return stringField(result, 'sessionId') ?? stringField(result, 'session_id');
}

function acpUsagePayload(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const usage = isRecord(record?.['usage']) ? record['usage'] : record;
  if (!usage) return undefined;
  const output: Record<string, unknown> = {};
  copyNumberLike(usage, output, ['inputTokens', 'input_tokens'], 'inputTokens');
  copyNumberLike(usage, output, ['outputTokens', 'output_tokens'], 'outputTokens');
  copyNumberLike(usage, output, ['totalTokens', 'total_tokens'], 'totalTokens');
  copyNumberLike(usage, output, ['cachedReadTokens', 'cacheReadInputTokens', 'cached_read_tokens'], 'cacheReadInputTokens');
  copyNumberLike(usage, output, ['contextTokens', 'context_tokens', 'currentContextTokens'], 'currentContextTokens');
  copyNumberLike(usage, output, ['contextWindow', 'maxContextTokens', 'max_context_tokens'], 'contextWindow');
  return Object.keys(output).length > 0 ? output : undefined;
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

function normalizeAcpUpdate(value: unknown): { data: Record<string, unknown>; type: string } {
  if (isRecord(value)) {
    const sessionUpdate = stringField(value, 'sessionUpdate') ?? stringField(value, 'type');
    if (sessionUpdate) return { data: value, type: normalizeAcpUpdateType(sessionUpdate) };
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [key, data] = entries[0] ?? [];
      return { data: isRecord(data) ? data : {}, type: normalizeAcpUpdateType(key ?? '') };
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
      parts.push(`--- ${path}\n+++ ${path}\n${oldText ? `(edited: ${oldText.length} -> ${newText.length} bytes)` : `(new file, ${newText.length} bytes)`}`);
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

function kimiToolNameFromTitle(title: string, kind?: string): string {
  const candidate = `${title || kind || 'tool'}`.trim();
  const normalized = candidate.toLowerCase();
  if (/(run command|shell|bash|terminal)/.test(normalized)) return 'Shell';
  if (/(read file|\bread\b)/.test(normalized)) return 'ReadFile';
  if (/(write file|\bwrite\b)/.test(normalized)) return 'WriteFile';
  if (/(edit|patch|replace)/.test(normalized)) return 'StrReplaceFile';
  if (/web search/.test(normalized)) return 'WebSearch';
  if (/(fetch|web fetch)/.test(normalized)) return 'Fetch';
  if (/search/.test(normalized)) return 'Search';
  if (/glob/.test(normalized)) return 'Glob';
  if (/todo/.test(normalized)) return 'TodoWrite';
  const base = candidate.split(':')[0]?.trim() || 'Tool';
  return base
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char: string) => char.toUpperCase())
    .replace(/^[a-z]/, (char) => char.toUpperCase());
}

function summarizeKimiToolInput(
  name: string,
  input: Record<string, unknown>,
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
  const target =
    stringField(input, 'file_path') ??
    stringField(input, 'path') ??
    stringField(input, 'filePath') ??
    stringField(input, 'pattern') ??
    stringField(input, 'query') ??
    stringField(input, 'glob') ??
    stringField(input, 'url');
  return {
    ...(target ? { target: singleLineForActivity(target) } : {}),
    ...(normalized === 'strreplacefile' ? { diff: kimiReplacementDiff(input) } : {}),
  };
}

function kimiReplacementDiff(input: Record<string, unknown>): string | undefined {
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
  ].filter(Boolean).join(' ');
}
