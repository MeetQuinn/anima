import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { nowIso } from '../ids.js';
import { isRecord, singleLineForActivity, stringField } from '../json.js';
import { ActiveRuntimeRun } from './active-runtime.js';
import { runtimeErrorPayload, truncateForActivity } from '../activities/format.js';
import { startChildProcess, type RunningChildProcess } from './child-process.js';
import { kimiInitializeEvent, recordKimiWireEvent } from './kimi-events.js';
import {
  providerSessionPayload,
  type AgentRuntime,
  type AgentRuntimeDrainInput,
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type KimiCliAgentProviderConfig,
} from './contract.js';

const KIMI_COMMAND = 'kimi';
const KIMI_WIRE_PROTOCOL_VERSION = '1.7';

export class KimiCliAgentRuntime implements AgentRuntime {
  readonly env: Record<string, string> | undefined;
  readonly kind = 'kimi-cli';
  private readonly config: KimiCliAgentProviderConfig;
  private controller?: KimiWireController;
  private readonly activeRun = new ActiveRuntimeRun();

  constructor(config: KimiCliAgentProviderConfig) {
    this.config = config;
    this.env = config.env;
  }

  async close(): Promise<void> {
    await this.resetController();
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    await input.effects.recordRuntime('runtime.started', {
      command: KIMI_COMMAND,
      providerSession: providerSessionPayload(input.providerSession, this.kind),
      transport: 'wire',
    });

    const finishRun = this.activeRun.start(input, 'Kimi', (signal) => void this.resetController(signal));
    try {
      if (!input.providerSession && this.controller?.sessionId) {
        await this.resetController();
      }
      const controller = await this.ensureController(input);
      await input.effects.persistProviderSession({
        id: controller.sessionId,
        updatedAt: nowIso(),
      });
      const text = await controller.startTurn(input, 'prompt', input.prompt);
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
    controller.writeUserMessage('steer', input.prompt);
    return { accepted: true, text: 'appended to Kimi wire stdin' };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    const controller = this.controller;
    if (!this.activeRun.accepts(input)) return;
    if (!controller) return;
    await controller.waitForQuiescent(input.signal);
  }

  private async ensureController(input: AgentRuntimeInput): Promise<KimiWireController> {
    if (this.controller) return this.controller;
    const sessionId = input.providerSession?.id ?? randomUUID();
    const agentFilePath = await writeKimiAgentFile(input);
    let controller!: KimiWireController;
    controller = new KimiWireController(
      startChildProcess({
        args: this.kimiArgs(sessionId, agentFilePath),
        bufferOutput: false,
        command: KIMI_COMMAND,
        cwd: input.cwd,
        env: input.env,
        label: 'Kimi wire runtime',
        onStderrChunk: (chunk) => controller.acceptStderrChunk(chunk),
        onStdoutChunk: async (chunk) => {
          await controller.acceptStdoutChunk(chunk);
        },
      }),
      sessionId,
    );
    this.controller = controller;
    controller.completion
      .catch(() => {})
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
      });
    controller.initialize();
    return controller;
  }

  private kimiArgs(sessionId: string, agentFilePath: string): string[] {
    const args = [
      '--wire',
      '--yolo',
      '--thinking',
      '--agent-file',
      agentFilePath,
      '--session',
      sessionId,
    ];
    if (this.config.model) args.push('--model', this.config.model);
    return args;
  }

  private async resetController(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    this.controller = undefined;
    controller.kill(signal);
    await controller.completion.catch(() => {});
  }
}

class KimiWireController {
  private buffer = '';
  private currentTurn?: {
    input: AgentRuntimeInput;
    reject(error: unknown): void;
    resolve(value: string): void;
    text: string[];
  };
  private latestPendingToolCallId?: string;
  private readonly activeToolIds = new Set<string>();
  private readonly pendingToolCalls = new Map<string, {
    args: string[];
    id: string;
    name: string;
  }>();
  private pendingInitializeEvent?: Record<string, unknown>;
  private readonly quiescentWaiters = new Set<{
    cleanup(): void;
    reject(error: unknown): void;
    resolve(): void;
  }>();
  readonly completion: Promise<{ stdout: string; stderr: string }>;

  constructor(
    private readonly child: RunningChildProcess,
    readonly sessionId: string,
  ) {
    this.completion = child.completion.then(
      (result) => {
        this.rejectQuiescentWaiters(new Error('Kimi wire runtime exited before drain reached a quiescent point'));
        this.abortCurrentTurn(new Error('Kimi wire runtime exited before completing active turn'));
        return result;
      },
      (error) => {
        this.rejectQuiescentWaiters(error);
        this.abortCurrentTurn(error);
        throw error;
      },
    );
  }

  initialize(): void {
    this.writeJson({
      id: randomUUID(),
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {
          supports_plan_mode: false,
          supports_question: false,
        },
        client: { name: 'anima', version: '0.1.0' },
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
      },
    });
  }

  async startTurn(input: AgentRuntimeInput, method: 'prompt' | 'steer', text: string): Promise<string> {
    if (this.currentTurn) throw new Error('Kimi wire runtime already has an active turn');
    const result = new Promise<string>((resolve, reject) => {
      this.currentTurn = { input, reject, resolve, text: [] };
    });
    if (this.pendingInitializeEvent) {
      await input.effects.recordEvent(this.pendingInitializeEvent);
      this.pendingInitializeEvent = undefined;
    }
    try {
      this.writeUserMessage(method, text);
    } catch (error) {
      this.abortCurrentTurn(error);
      throw error;
    }
    return result;
  }

  writeUserMessage(method: 'prompt' | 'steer', text: string): void {
    this.writeJson({
      id: randomUUID(),
      jsonrpc: '2.0',
      method,
      params: {
        user_input: text,
      },
    });
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
    const turn = this.currentTurn;
    if (isRecord(parsed['error'])) {
      this.abortCurrentTurn(new Error(stringField(parsed['error'], 'message') ?? 'Unknown Kimi wire error'));
      return;
    }
    const result = isRecord(parsed['result']) ? parsed['result'] : undefined;
    const initializeEvent = result ? kimiInitializeEvent(result) : undefined;
    if (initializeEvent) {
      if (turn) await turn.input.effects.recordEvent(initializeEvent);
      else this.pendingInitializeEvent = initializeEvent;
      return;
    }
    if (stringField(parsed, 'method') !== 'event') return;
    const params = isRecord(parsed['params']) ? parsed['params'] : undefined;
    if (!params) return;
    const eventType = stringField(params, 'type');
    const payload = isRecord(params?.['payload']) ? params['payload'] : {};
    if (!turn) return;
    await recordKimiWireEvent(turn.input, eventType, payload);
    if (eventType === 'CompactionBegin') {
      return;
    }
    if (eventType === 'CompactionEnd') {
      return;
    }
    if (eventType === 'ToolCallPart') {
      await this.recordToolCallPart(turn.input, payload);
      return;
    }
    if (eventType === 'ToolCall') {
      const fn = isRecord(payload['function']) ? payload['function'] : {};
      const name = stringField(fn, 'name') ?? 'unknown_tool';
      await this.recordToolCall(turn.input, payload, fn, name);
      return;
    }
    if (eventType === 'ToolResult') {
      await this.flushPendingToolCall(turn.input, stringField(payload, 'tool_call_id'));
      const id = stringField(payload, 'tool_call_id');
      if (id) {
        this.activeToolIds.delete(id);
        this.resolveQuiescentWaitersIfReady();
      }
      return;
    }
    if (eventType === 'ContentPart') {
      if (stringField(payload, 'type') === 'text' && typeof payload['text'] === 'string') {
        turn.text.push(payload['text']);
      }
      return;
    }
    if (eventType === 'StepInterrupted') {
      await turn.input.effects.recordEvent({ eventType: 'kimi.step.interrupted', runtimeKind: 'kimi-cli' });
      await this.finishCurrentTurn();
      return;
    }
    if (eventType === 'TurnEnd') {
      await this.finishCurrentTurn();
    }
  }

  private async recordToolCallPart(input: AgentRuntimeInput, payload: Record<string, unknown>): Promise<void> {
    const part =
      stringField(payload, 'arguments') ??
      stringField(payload, 'arguments_part') ??
      stringField(payload, 'argumentsPart');
    if (!part) return;
    const key =
      stringField(payload, 'tool_call_id') ??
      stringField(payload, 'toolCallId') ??
      stringField(payload, 'id') ??
      stringField(payload, 'index') ??
      this.latestPendingToolCallId;
    if (!key) return;
    const pending = this.pendingToolCalls.get(key);
    if (!pending) return;
    pending.args.push(part);
    await this.flushPendingToolCallIfComplete(input, pending.id);
  }

  private async recordToolCall(
    input: AgentRuntimeInput,
    payload: Record<string, unknown>,
    fn: Record<string, unknown>,
    name: string,
  ): Promise<void> {
    const id = stringField(payload, 'id') ?? stringField(payload, 'tool_call_id') ?? randomUUID();
    const direct = fn['arguments'] ?? payload['arguments'];
    if (typeof direct === 'string' && direct.trim()) {
      await this.emitToolStarted(input, id, name, direct);
      return;
    }
    if (isRecord(direct)) {
      await this.emitToolStarted(input, id, name, direct);
      return;
    }
    this.pendingToolCalls.set(id, { args: [], id, name });
    this.latestPendingToolCallId = id;
  }

  private async flushPendingToolCallIfComplete(input: AgentRuntimeInput, id: string): Promise<void> {
    const pending = this.pendingToolCalls.get(id);
    if (!pending) return;
    const raw = pending.args.join('');
    const parsed = parseToolArguments(raw);
    if (!isRecord(parsed)) return;
    await this.emitToolStarted(input, pending.id, pending.name, parsed);
    this.pendingToolCalls.delete(id);
    if (this.latestPendingToolCallId === id) this.latestPendingToolCallId = undefined;
  }

  private async flushPendingToolCall(input: AgentRuntimeInput, id: string | undefined): Promise<void> {
    if (!id) return;
    const pending = this.pendingToolCalls.get(id);
    if (!pending) return;
    await this.emitToolStarted(input, pending.id, pending.name, pending.args.join(''));
    this.pendingToolCalls.delete(id);
    if (this.latestPendingToolCallId === id) this.latestPendingToolCallId = undefined;
  }

  private async emitToolStarted(
    input: AgentRuntimeInput,
    id: string,
    name: string,
    rawInput: unknown,
  ): Promise<void> {
    const toolInput = parseToolArguments(rawInput);
    const summary = summarizeKimiToolInput(name, isRecord(toolInput) ? toolInput : {});
    await input.effects.recordToolStarted({
      eventType: 'kimi.tool.call',
      provider: 'kimi-cli',
      providerToolName: name,
      providerToolId: id,
      ...(summary.command ? { command: summary.command } : {}),
      ...(summary.target ? { target: summary.target } : {}),
      ...(summary.diff ? { diff: summary.diff } : {}),
      runtimeKind: 'kimi-cli',
      tool: `kimi.${name}`,
    });
    this.activeToolIds.add(id);
  }

  private abortCurrentTurn(error: unknown): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = undefined;
    this.activeToolIds.clear();
    this.resolveQuiescentWaitersIfReady();
    turn.reject(error);
  }

  private async finishCurrentTurn(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = undefined;
    this.activeToolIds.clear();
    this.resolveQuiescentWaitersIfReady();
    const text = turn.text.join('').trim();
    if (text) await turn.input.effects.recordAgentText(text, { eventType: 'kimi.assistant' });
    turn.resolve(text);
  }

  private resolveQuiescentWaitersIfReady(): void {
    if (this.activeToolIds.size > 0) return;
    for (const waiter of [...this.quiescentWaiters]) waiter.resolve();
  }

  private rejectQuiescentWaiters(error: unknown): void {
    for (const waiter of [...this.quiescentWaiters]) waiter.reject(error);
  }

  private writeJson(payload: Record<string, unknown>): void {
    this.child.writeStdin(`${JSON.stringify(payload)}\n`);
  }
}

async function writeKimiAgentFile(input: AgentRuntimeInput): Promise<string> {
  const systemPromptFilePath = input.systemPromptFilePath ?? join(input.cwd, '.anima-kimi-system.md');
  const agentFilePath = join(dirname(systemPromptFilePath), 'kimi-agent.yaml');
  await mkdir(dirname(systemPromptFilePath), { recursive: true });
  await writeFile(systemPromptFilePath, input.systemPrompt ?? '', 'utf8');
  await writeFile(
    agentFilePath,
    [
      'version: 1',
      'agent:',
      '  extend: default',
      `  system_prompt_path: ${JSON.stringify(systemPromptFilePath)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  return agentFilePath;
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return truncateForActivity(raw);
  }
}

function summarizeKimiToolInput(
  name: string,
  input: Record<string, unknown>,
): { command?: string; diff?: string; target?: string } {
  const normalized = name.toLowerCase();
  if (normalized === 'shell' || normalized === 'bash') {
    const command = stringField(input, 'command');
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
