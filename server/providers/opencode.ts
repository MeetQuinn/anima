import { randomUUID } from 'node:crypto';

import { nowIso } from '../ids.js';
import { isRecord, numberField, singleLineForActivity, stringField } from '../json.js';
import { truncateForActivity } from '../activities/format.js';
import { type RunningChildProcess } from './child-process.js';
import { providerUsageFromStats } from './provider-usage.js';
import { AcpJsonRpcError, AcpJsonRpcPeer } from './acp-json-rpc.js';
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
  type OpenCodeCliAgentProviderConfig,
} from './contract.js';

const OPENCODE_RUNTIME_KIND = 'opencode-cli';

export function openCodeAcpLaunchArgs(
  providerArgs: readonly string[] = [],
): string[] {
  // `--pure` disables external OpenCode plugins. Anima supplies the orchestration
  // boundary, while OpenCode's built-in tools and first-party providers remain.
  return [...providerArgs, 'acp', '--pure'];
}

export function openCodeLaunchEnvironment(
  env: NodeJS.ProcessEnv,
  machineEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
  // DeepSeek auth is machine-global in OpenCode's auth store. Pin the paths
  // which locate that store and the global OpenCode configuration to the
  // service environment rather than an agent's Launch env.
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR']) {
    const value = machineEnv[key]?.trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  // Do not allow an inline credential or config blob to become per-agent
  // identity authority. Operators can use OpenCode's machine-level files.
  delete next.DEEPSEEK_API_KEY;
  delete next.OPENCODE_AUTH_CONTENT;
  delete next.OPENCODE_CONFIG_CONTENT;
  return next;
}

export class OpenCodeCliAgentRuntime extends ControllerAgentRuntime<OpenCodeAcpController> {
  readonly command: string;
  readonly env: Record<string, string> | undefined;
  readonly kind = OPENCODE_RUNTIME_KIND;
  private readonly config: OpenCodeCliAgentProviderConfig;
  private readonly providerArgs: readonly string[];

  constructor(
    config: OpenCodeCliAgentProviderConfig,
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
      label: 'OpenCode',
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
          const text = await controller.startTurn(input, openCodePrimaryPrompt(input));
          if (input.signal?.aborted) {
            throw new Error(`OpenCode turn cancelled: ${String(input.signal.reason ?? 'aborted')}`);
          }
          return text.trim() ? { text: text.trim() } : {};
        } catch (error) {
          const mapped = openCodeSetupError(error, this.config.model);
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
    return { accepted: true, text: acpFollowupAppliedText('OpenCode') };
  }

  private async ensureController(input: AgentRuntimeInput): Promise<OpenCodeAcpController> {
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
        return this.spawnController(
          {
            args: openCodeAcpLaunchArgs(this.providerArgs),
            command: this.command,
            label: 'OpenCode ACP runtime',
          },
          {
            ...input,
            env: openCodeLaunchEnvironment(input.env),
          },
          (child) => new OpenCodeAcpController(child),
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

interface OpenCodeTurn {
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

class OpenCodeAcpController {
  private readonly activeToolIds = new Set<string>();
  private currentTurn?: OpenCodeTurn;
  private initialized?: Promise<void>;
  private latestUsage?: Record<string, unknown>;
  private configuredModel?: string;
  private readonly usageCaptureId = randomUUID();
  private usageSequence = 0;
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly quiescentWaiters = new QuiescentWaiterSet();
  private readonly rpc: AcpJsonRpcPeer;
  private turnCompletion?: Promise<string>;
  /** True while a session/prompt RPC is outstanding. */
  private promptInFlight = false;
  readonly completion: Promise<{ stdout: string; stderr: string }>;
  sessionId = '';

  constructor(private readonly child: RunningChildProcess) {
    this.rpc = new AcpJsonRpcPeer(child, {
      label: 'OpenCode',
      onNotification: (message) => this.handleNotification(message),
      onRequest: (message) => this.handleAgentRequest(message),
      onUnstructuredOutput: async (text) => {
        const turn = this.currentTurn;
        if (turn) await turn.input.effects.recordOutput('stdout', text);
      },
    });
    this.completion = child.completion.then(
      (result) => {
        this.fail(new Error('OpenCode ACP runtime exited'));
        return result;
      },
      (error) => {
        this.fail(error);
        throw error;
      },
    );
  }

  async ensureSession(
    input: AgentRuntimeInput,
    model: string | undefined,
    reasoningEffort: string | undefined,
  ): Promise<void> {
    this.configuredModel = model;
    if (!this.initialized) {
      this.initialized = this.initializeSession(input, model, reasoningEffort).catch((error) => {
        this.initialized = undefined;
        throw error;
      });
    }
    await this.initialized;
  }

  async startTurn(input: AgentRuntimeInput, prompt: string): Promise<string> {
    if (this.currentTurn) throw new Error('OpenCode ACP runtime already has an active turn');
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
    await Promise.race([
      completion.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
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
    const initEvent = openCodeInitializeEvent(initResult);
    const version = initEvent?.serverVersion;
    if (typeof version === 'string') this.child.setVersion(version);
    if (initEvent) await input.effects.recordEvent(initEvent);

    const requestedSessionId = input.providerSession?.id;
    if (requestedSessionId) {
      try {
        await this.rpc.request('session/resume', {
          cwd: input.cwd,
          mcpServers: [],
          sessionId: requestedSessionId,
        });
        this.sessionId = requestedSessionId;
      } catch (error) {
        if (!isOpenCodeSessionNotFoundError(error)) throw error;
        await input.effects.recordEvent({
          eventType: 'opencode.session.resume_missing',
          providerSession: providerSessionPayload(input.providerSession, OPENCODE_RUNTIME_KIND),
          runtimeKind: OPENCODE_RUNTIME_KIND,
          transport: 'acp',
        });
        this.sessionId = await this.createSession(input);
      }
    } else {
      this.sessionId = await this.createSession(input);
    }

    if (model) await this.selectModel(model);
    if (reasoningEffort) await this.selectEffort(reasoningEffort);
  }

  private async createSession(input: AgentRuntimeInput): Promise<string> {
    const result = await this.rpc.request('session/new', {
      cwd: input.cwd,
      mcpServers: [],
    });
    const sessionId = stringField(result, 'sessionId') ?? stringField(result, 'session_id');
    if (!sessionId) throw new Error('OpenCode ACP session/new returned no sessionId');
    return sessionId;
  }

  private async selectModel(model: string): Promise<void> {
    try {
      await this.rpc.request('session/set_config_option', {
        configId: 'model',
        sessionId: this.sessionId,
        value: model,
      });
    } catch (error) {
      if (!(error instanceof AcpJsonRpcError)) throw error;
      throw new Error(
        `OpenCode could not select ${model}. Configure DeepSeek with \`opencode auth login --provider deepseek\`. ${error.message}`,
      );
    }
  }

  private async selectEffort(reasoningEffort: string): Promise<void> {
    await this.rpc.request('session/set_config_option', {
      configId: 'effort',
      sessionId: this.sessionId,
      value: reasoningEffort,
    });
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

  private async runOnePrompt(turn: OpenCodeTurn, prompt: string): Promise<void> {
    this.latestUsage = undefined;
    await turn.input.effects.recordEvent({
      eventType: 'opencode.turn.started',
      runtimeKind: OPENCODE_RUNTIME_KIND,
      transport: 'acp',
      userInputLength: prompt.length,
    });
    const sourceId = `${this.sessionId}:${this.usageCaptureId}:prompt:${++this.usageSequence}`;
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
      await turn.input.effects.recordUsage(providerUsageFromStats(
        sourceId,
        this.latestUsage,
        { model: this.configuredModel },
      ));
      throw error;
    }
    const stopReason = stringField(result, 'stopReason');
    if (rollbackCancelledAcpPromptText(turn, textCheckpoint, stopReason)) {
      this.activeToolIds.clear();
      this.pendingTools.clear();
    }
    const usage = acpUsagePayload(result);
    if (usage) {
      this.latestUsage = usage;
      await turn.input.effects.recordEvent({
        ...usage,
        eventType: 'opencode.context.stats',
        runtimeKind: OPENCODE_RUNTIME_KIND,
        terminalReason: stopReason,
      });
    }
    await turn.input.effects.recordUsage(providerUsageFromStats(
      sourceId,
      usage ?? this.latestUsage,
      { model: stringField(result, 'model') ?? stringField(result, 'modelId') ?? this.configuredModel },
    ));
    await turn.input.effects.recordEvent({
      eventType: 'opencode.turn.completed',
      runtimeKind: OPENCODE_RUNTIME_KIND,
      terminalReason: stopReason,
      transport: 'acp',
    });
  }

  private async handleAgentRequest(message: Record<string, unknown>): Promise<void> {
    const method = stringField(message, 'method');
    if (method === 'session/request_permission') {
      const optionId = permissionApprovalOptionId(message);
      if (!optionId) {
        this.rpc.respondError(message.id, -32602, 'OpenCode provided no allow permission option');
        return;
      }
      this.rpc.respond(message.id, {
        outcome: {
          optionId,
          outcome: 'selected',
        },
      });
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
        eventType: 'opencode.thinking.delta',
        runtimeKind: OPENCODE_RUNTIME_KIND,
        text: truncateForActivity(text),
        transport: 'acp',
      });
      await turn.input.effects.recordEvent(exposedReasoningEvent({
        provider: 'opencode',
        runtimeKind: OPENCODE_RUNTIME_KIND,
        sourceEventType: 'opencode.thinking.delta',
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
      this.latestUsage = { ...this.latestUsage, ...usage };
      await turn.input.effects.recordEvent({
        ...usage,
        eventType: 'opencode.context.stats',
        runtimeKind: OPENCODE_RUNTIME_KIND,
      });
    }
  }

  private async handleToolCallStart(input: AgentRuntimeInput, data: Record<string, unknown>): Promise<void> {
    const id = toolCallId(data);
    if (!id) return;
    const rawInput = toolInput(data);
    const name = openCodeToolName(
      stringField(data, 'title') ?? stringField(data, 'name') ?? stringField(data, 'kind') ?? '',
      stringField(data, 'kind'),
    );
    this.activeToolIds.add(id);
    this.pendingTools.set(id, {
      ...(rawInput ? { input: rawInput } : {}),
      name,
    });
    await this.emitToolStarted(input, id, name, rawInput ?? {});
  }

  private async handleToolCallUpdate(input: AgentRuntimeInput, data: Record<string, unknown>): Promise<void> {
    const id = toolCallId(data);
    if (!id) return;
    const status = stringField(data, 'status');
    const terminal = status === 'completed' || status === 'failed';
    const pending = this.pendingTools.get(id);
    const rawInput = toolInput(data) ?? pending?.input;
    const name = pending?.name ?? openCodeToolName(
      stringField(data, 'title') ?? stringField(data, 'name') ?? stringField(data, 'kind') ?? '',
      stringField(data, 'kind'),
    );

    if (!pending) {
      this.activeToolIds.add(id);
      this.pendingTools.set(id, {
        ...(rawInput ? { input: rawInput } : {}),
        name,
      });
      await this.emitToolStarted(input, id, name, rawInput ?? {});
    } else if (rawInput) {
      pending.input = rawInput;
    }
    if (!terminal) return;

    const output = toolOutput(data);
    await input.effects.recordEvent({
      eventType: 'opencode.tool_result',
      isError: status === 'failed',
      output: output ? truncateForActivity(output) : undefined,
      providerToolId: id,
      runtimeKind: OPENCODE_RUNTIME_KIND,
      transport: 'acp',
    });
    if (status === 'failed') {
      await input.effects.recordToolFailed({
        error: output ? truncateForActivity(output) : 'OpenCode tool failed',
        provider: OPENCODE_RUNTIME_KIND,
        providerToolId: id,
        runtimeKind: OPENCODE_RUNTIME_KIND,
        tool: `opencode.${name}`,
      });
    }
    this.pendingTools.delete(id);
    this.activeToolIds.delete(id);
    this.resolveQuiescentWaitersIfReady();
  }

  private async emitToolStarted(
    input: AgentRuntimeInput,
    id: string,
    name: string,
    rawInput: Record<string, unknown>,
  ): Promise<void> {
    const summary = summarizeToolInput(name, rawInput);
    await input.effects.recordToolStarted({
      eventType: 'opencode.tool.call',
      provider: OPENCODE_RUNTIME_KIND,
      providerToolId: id,
      providerToolName: name,
      ...(summary.command ? { command: summary.command } : {}),
      ...(summary.target ? { target: summary.target } : {}),
      runtimeKind: OPENCODE_RUNTIME_KIND,
      tool: `opencode.${name}`,
      transport: 'acp',
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
    this.clearCurrentTurn();
    if (this.latestUsage) {
      await turn.input.effects.recordEvent({
        ...this.latestUsage,
        eventType: 'opencode.context.stats',
        runtimeKind: OPENCODE_RUNTIME_KIND,
      });
    }
    const text = turn.text.join('').trim();
    if (text) {
      await turn.input.effects.recordAgentText(text, {
        eventType: 'opencode.assistant',
        transport: 'acp',
      });
    }
    turn.resolve(text);
  }

  private resolveQuiescentWaitersIfReady(): void {
    this.quiescentWaiters.resolveIfReady(() => this.activeToolIds.size === 0);
  }

  private fail(error: unknown): void {
    this.rpc.rejectAll(error);
    this.quiescentWaiters.reject(error);
    this.abortCurrentTurn(error);
  }
}

function openCodePrimaryPrompt(input: AgentRuntimeInput): string {
  const systemPrompt = input.systemPrompt?.trim();
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${input.prompt}` : input.prompt;
}

function openCodeInitializeEvent(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const event: Record<string, unknown> = {
    eventType: 'opencode.system.init',
    runtimeKind: OPENCODE_RUNTIME_KIND,
    transport: 'acp',
  };
  const protocolVersion = numberField(result, 'protocolVersion') ?? stringField(result, 'protocolVersion');
  if (protocolVersion !== undefined) event.protocolVersion = protocolVersion;
  const capabilities = isRecord(result.agentCapabilities)
    ? result.agentCapabilities
    : isRecord(result.capabilities)
      ? result.capabilities
      : undefined;
  if (capabilities) event.capabilityCount = Object.keys(capabilities).length;
  const info = isRecord(result.agentInfo)
    ? result.agentInfo
    : isRecord(result.serverInfo)
      ? result.serverInfo
      : isRecord(result.server)
        ? result.server
        : undefined;
  const name = stringField(info, 'name');
  const version = stringField(info, 'version');
  if (name) event.serverName = name;
  if (version) event.serverVersion = version;
  return event;
}

function isOpenCodeSessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof AcpJsonRpcError)) return false;
  if (error.method !== 'session/resume') return false;
  return /session.{0,40}(?:not\s+found|missing|unknown)|(?:not\s+found|missing|unknown).{0,40}session/i.test(
    error.message,
  );
}

function openCodeSetupError(error: unknown, model: string | undefined): unknown {
  if (!(error instanceof AcpJsonRpcError)) return error;
  if (!/(?:auth|credential|api.?key|provider.{0,40}(?:not\s+found|missing|unknown)|deepseek)/i.test(error.message)) {
    return error;
  }
  return new Error(
    `OpenCode could not use ${model ?? 'the selected DeepSeek model'}. `
      + 'Configure the machine-level credential with `opencode auth login --provider deepseek`. '
      + error.message,
    { cause: error },
  );
}

function permissionApprovalOptionId(message: Record<string, unknown>): string | undefined {
  const params = isRecord(message.params) ? message.params : undefined;
  const options = Array.isArray(params?.options) ? params.options.filter(isRecord) : [];
  const candidates = options.map((option) => ({
    id: stringField(option, 'optionId') ?? stringField(option, 'option_id') ?? stringField(option, 'id'),
    key: [
      stringField(option, 'optionId'),
      stringField(option, 'option_id'),
      stringField(option, 'kind'),
      stringField(option, 'name'),
      stringField(option, 'label'),
    ].filter(Boolean).join(' ').toLowerCase(),
  }));
  return candidates.find((candidate) =>
    candidate.id && /\b(always|session)\b/.test(candidate.key) && /\b(allow|approve)\b/.test(candidate.key),
  )?.id
    ?? candidates.find((candidate) =>
      candidate.id && !/\b(reject|deny|cancel)\b/.test(candidate.key) && /\b(allow|approve)\b/.test(candidate.key),
    )?.id;
}

function normalizeAcpUpdate(value: unknown): { data: Record<string, unknown>; type: string } {
  if (!isRecord(value)) return { data: {}, type: '' };
  const direct = stringField(value, 'sessionUpdate') ?? stringField(value, 'type');
  if (direct) return { data: value, type: normalizeAcpUpdateType(direct) };
  const entries = Object.entries(value);
  if (entries.length !== 1) return { data: value, type: '' };
  const [key, data] = entries[0] ?? [];
  return { data: isRecord(data) ? data : {}, type: normalizeAcpUpdateType(key ?? '') };
}

function normalizeAcpUpdateType(type: string): string {
  const key = type.trim().toLowerCase().replace(/[_-]/g, '');
  if (key === 'agentmessagechunk') return 'agent_message_chunk';
  if (key === 'agentthoughtchunk') return 'agent_thought_chunk';
  if (key === 'toolcall') return 'tool_call';
  if (key === 'toolcallupdate') return 'tool_call_update';
  if (key === 'usageupdate') return 'usage_update';
  return '';
}

function extractAcpText(data: Record<string, unknown>): string | undefined {
  if (typeof data.text === 'string') return data.text;
  if (typeof data.delta === 'string') return data.delta;
  if (typeof data.content === 'string') return data.content;
  return isRecord(data.content)
    ? stringField(data.content, 'text') ?? stringField(data.content, 'delta')
    : undefined;
}

function toolCallId(data: Record<string, unknown>): string | undefined {
  return stringField(data, 'toolCallId') ?? stringField(data, 'tool_call_id') ?? stringField(data, 'id');
}

function toolInput(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = data.rawInput ?? data.input ?? data.parameters;
  return isRecord(raw) ? raw : undefined;
}

function toolOutput(data: Record<string, unknown>): string | undefined {
  if (typeof data.rawOutput === 'string') return data.rawOutput;
  if (typeof data.output === 'string') return data.output;
  const raw = isRecord(data.rawOutput) ? data.rawOutput : undefined;
  const output = stringField(raw, 'output') ?? stringField(raw, 'error');
  if (output) return output;
  if (!Array.isArray(data.content)) return undefined;
  const chunks: string[] = [];
  for (const block of data.content) {
    if (!isRecord(block)) continue;
    const content = block.type === 'content' ? block.content : block;
    if (typeof content === 'string') chunks.push(content);
    else if (isRecord(content)) {
      const text = stringField(content, 'text');
      if (text) chunks.push(text);
    }
  }
  return chunks.join('\n') || undefined;
}

function openCodeToolName(title: string, kind?: string): string {
  const candidate = `${title || kind || 'tool'}`.trim();
  const normalized = candidate.toLowerCase();
  if (/(run command|shell|bash|terminal|execute)/.test(normalized)) return 'Shell';
  if (/(read file|\bread\b)/.test(normalized)) return 'ReadFile';
  if (/(write file|\bwrite\b)/.test(normalized)) return 'WriteFile';
  if (/(edit|patch|replace)/.test(normalized)) return 'EditFile';
  if (/web search/.test(normalized)) return 'WebSearch';
  if (/(fetch|web fetch)/.test(normalized)) return 'Fetch';
  if (/search/.test(normalized)) return 'Search';
  if (/glob/.test(normalized)) return 'Glob';
  const base = candidate.split(':')[0]?.trim() || 'Tool';
  return base
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char: string) => char.toUpperCase())
    .replace(/^[a-z]/, (char) => char.toUpperCase());
}

function summarizeToolInput(
  name: string,
  input: Record<string, unknown>,
): { command?: string; target?: string } {
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
  const target = stringField(input, 'file_path')
    ?? stringField(input, 'path')
    ?? stringField(input, 'filePath')
    ?? stringField(input, 'pattern')
    ?? stringField(input, 'query')
    ?? stringField(input, 'url');
  return target ? { target: singleLineForActivity(target) } : {};
}

function acpUsagePayload(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const usage = isRecord(value?.usage) ? value.usage : value;
  if (!usage) return undefined;
  const output: Record<string, unknown> = {};
  copyNumberLike(usage, output, ['inputTokens', 'input_tokens'], 'inputTokens');
  copyNumberLike(usage, output, ['outputTokens', 'output_tokens'], 'outputTokens');
  copyNumberLike(usage, output, ['totalTokens', 'total_tokens'], 'totalTokens');
  copyNumberLike(
    usage,
    output,
    ['cachedReadTokens', 'cacheReadInputTokens', 'cached_read_tokens'],
    'cacheReadInputTokens',
  );
  copyNumberLike(
    usage,
    output,
    ['cachedWriteTokens', 'cacheWriteInputTokens', 'cached_write_tokens'],
    'cacheWriteInputTokens',
  );
  copyNumberLike(usage, output, ['thoughtTokens', 'reasoningTokens'], 'reasoningTokens');
  copyNumberLike(usage, output, ['used', 'contextTokens', 'currentContextTokens'], 'currentContextTokens');
  copyNumberLike(usage, output, ['size', 'contextWindow', 'maxContextTokens'], 'contextWindow');
  const cost = isRecord(usage.cost) ? usage.cost : undefined;
  copyNumberLike(cost ?? usage, output, ['amount', 'cost'], 'costUsd');
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
