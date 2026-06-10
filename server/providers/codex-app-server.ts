import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asRecord, stringField } from '../json.js';
import { type RunningChildProcess } from './child-process.js';
import {
  codexContextStatsFromTokenUsage,
  codexReasoningEventFromNotification,
  codexSubagentSpawnPairsFromSessionJsonl,
  codexSubagentSpawnCallFromRawResponseItem,
  codexSubagentSpawnOutputFromRawResponseItem,
  codexRuntimeEventFromNotification,
  codexSubagentLinkageFromRecord,
  codexSessionStatsFromTurn,
  providerToolCallsFromAppServerItem,
  providerToolFailuresFromAppServerItem,
  recordParam,
  runtimeEventFromAppServerItem,
  stringParam,
  type JsonRpcMessage,
} from './codex-events.js';
import type { AgentRuntimeInput } from './contract.js';
import { truncateForActivity } from '../activities/format.js';
import type { ProviderChildHealthSnapshot } from '../../shared/snapshot.js';
import { LineBuffer } from './line-buffer.js';
import { QuiescentWaiterSet } from './quiescent-waiters.js';

interface CodexThread {
  id: string;
}

interface ActiveCodexTurn {
  completed: Deferred<void>;
  input: AgentRuntimeInput;
  ready: Deferred<string>;
  turnId?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

interface LinkedAgentText {
  payload: Record<string, unknown>;
  text: string;
}

interface PendingCodexSubagentSpawn {
  parentToolCallId: string;
  role?: string;
}

export class CodexAppServerController {
  private activeInput?: AgentRuntimeInput;
  private readonly stdoutLines = new LineBuffer();
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, { reject(error: unknown): void; resolve(value: unknown): void }>();
  private readonly completedTurns = new Set<string>();
  private readonly linkedTextByItem = new Map<string, LinkedAgentText>();
  private readonly textByTurn = new Map<string, string>();
  private readonly activeProviderToolIds = new Set<string>();
  private readonly pendingSubagentSpawns = new Map<string, PendingCodexSubagentSpawn>();
  private readonly recordedSubagentChildren = new Set<string>();
  private readonly recordedSubagentParents = new Set<string>();
  private readonly providerToolsById = new Map<string, Record<string, unknown>>();
  private readonly quiescentWaiters = new QuiescentWaiterSet();
  private currentTurn?: ActiveCodexTurn;
  private sessionFilePath?: string;
  threadId = '';
  readonly completion: Promise<{ stdout: string; stderr: string }>;

  constructor(
    private readonly child: RunningChildProcess,
    private readonly runtimeKind: string,
  ) {
    this.completion = child.completion.then(
      (result) => {
        this.rejectQuiescentWaiters(new Error('Codex app-server runtime exited before drain reached a quiescent point'));
        this.rejectOpenWaiters(new Error('Codex app-server runtime exited before completing active requests'));
        return result;
      },
      (error) => {
        this.rejectQuiescentWaiters(error);
        this.rejectOpenWaiters(error);
        throw error;
      },
    );
  }

  async ensureThread(input: AgentRuntimeInput, params: Record<string, unknown>): Promise<CodexThread> {
    await this.initialize();
    if (this.threadId) return { id: this.threadId };
    const thread = input.providerSession
      ? await this.resumeThread(input.providerSession.id, params)
      : await this.startThread(params);
    this.threadId = thread.id;
    return thread;
  }

  attachRun(input: AgentRuntimeInput): void {
    this.activeInput = input;
  }

  detachRun(input: AgentRuntimeInput): void {
    if (this.activeInput === input) this.activeInput = undefined;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: { name: 'anima', title: 'Anima', version: '0.1.0' },
    });
    this.notify('initialized');
    this.initialized = true;
  }

  async startThread(params: Record<string, unknown>): Promise<CodexThread> {
    const result = await this.request('thread/start', params);
    return threadFromResponse(result);
  }

  async resumeThread(threadId: string, params: Record<string, unknown>): Promise<CodexThread> {
    const result = await this.request('thread/resume', { ...params, threadId });
    return threadFromResponse(result);
  }

  async startTurn(
    params: Record<string, unknown>,
    input: AgentRuntimeInput,
    onText: (text: string) => Promise<void>,
  ): Promise<string> {
    if (this.currentTurn) throw new Error(`Codex runtime already has an active turn ${this.currentTurn.turnId ?? ''}`.trim());
    const turn: ActiveCodexTurn = {
      completed: deferred<void>(),
      input,
      ready: deferred<string>(),
    };
    this.currentTurn = turn;
    let turnId: string | undefined;
    try {
      const result = await this.request('turn/start', params);
      turnId = turnIdFromResponse(result);
      turn.turnId = turnId;
      turn.ready.resolve(turnId);
      if (!this.completedTurns.has(turnId)) {
        await turn.completed.promise;
      }
      const text = this.textByTurn.get(turnId) ?? '';
      if (text.trim()) await onText(text.trim());
      return text;
    } catch (error) {
      turn.ready.reject(error);
      throw error;
    } finally {
      if (this.currentTurn === turn) this.currentTurn = undefined;
      if (turnId) {
        this.completedTurns.delete(turnId);
        this.textByTurn.delete(turnId);
      }
      this.linkedTextByItem.clear();
      this.pendingSubagentSpawns.clear();
      this.activeProviderToolIds.clear();
      this.resolveQuiescentWaitersIfReady();
    }
  }

  async waitForActiveTurnId(): Promise<string> {
    const turn = this.currentTurn;
    if (!turn) throw new Error('Codex runtime has no active turn');
    return turn.ready.promise;
  }

  waitForQuiescent(signal?: AbortSignal): Promise<void> {
    return this.quiescentWaiters.waitUntilReady(() => this.activeProviderToolIds.size === 0, signal);
  }

  request(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    this.child.writeStdin(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
  }

  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  snapshot(): ProviderChildHealthSnapshot {
    return this.child.snapshot();
  }

  private notify(method: string): void {
    this.child.writeStdin(`${JSON.stringify({ method })}\n`);
  }

  private rejectOpenWaiters(error: unknown): void {
    this.currentTurn?.ready.reject(error);
    this.currentTurn?.completed.reject(error);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  async acceptStdoutChunk(chunk: string): Promise<void> {
    this.activeInput?.onActivity?.();
    for (const line of this.stdoutLines.accept(chunk)) await this.acceptLine(line);
  }

  async acceptStderrChunk(chunk: string): Promise<void> {
    const input = this.activeInput;
    if (!input) return;
    input.onActivity?.();
    await input.effects.recordOutput('stderr', chunk);
  }

  private async acceptLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      const input = this.currentTurn?.input ?? this.activeInput;
      await input?.effects.recordEvent({
        error: error instanceof Error ? error.message : String(error),
        eventType: 'codex.protocol.invalid_json',
        preview: truncateForActivity(line),
        runtimeKind: this.runtimeKind,
      });
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    await this.acceptNotification(message);
  }

  private async acceptNotification(message: JsonRpcMessage): Promise<void> {
    if (message.method === 'item/agentMessage/delta') {
      this.acceptAgentMessageDelta(message.params);
      return;
    }
    if (message.method === 'rawResponseItem/completed') {
      if (await this.acceptRawResponseItem(message.params)) return;
    }
    const runtimeEvent = codexRuntimeEventFromNotification(message, this.runtimeKind);
    const reasoningEvent = codexReasoningEventFromNotification(message, this.runtimeKind);
    if (runtimeEvent) {
      const input = this.currentTurn?.input ?? this.activeInput;
      if (input) await input.effects.recordEvent(runtimeEvent);
      if (reasoningEvent) await input?.effects.recordEvent(reasoningEvent);
      return;
    }
    if (message.method === 'item/started') {
      const turn = this.currentTurn;
      if (!turn) return;
      const item = recordParam(message.params, 'item');
      const runtimeEvent = runtimeEventFromAppServerItem(message.method, item, this.runtimeKind);
      if (runtimeEvent) {
        await turn.input.effects.recordEvent(runtimeEvent);
        return;
      }
      for (const tool of providerToolCallsFromAppServerItem(item)) {
        const providerToolId = stringField(tool, 'providerToolId');
        if (providerToolId) {
          this.providerToolsById.set(providerToolId, tool);
          this.activeProviderToolIds.add(providerToolId);
        }
        await turn.input.effects.recordToolStarted(tool);
      }
      return;
    }
    if (message.method === 'item/completed') {
      const turn = this.currentTurn;
      if (!turn) return;
      const item = recordParam(message.params, 'item');
      const runtimeEvent = runtimeEventFromAppServerItem(message.method, item, this.runtimeKind);
      if (runtimeEvent) {
        await turn.input.effects.recordEvent(runtimeEvent);
        return;
      }
      for (const failure of providerToolFailuresFromAppServerItem(
        item,
        this.providerToolsById,
        this.runtimeKind,
      )) {
        await turn.input.effects.recordToolFailed(failure);
      }
      const providerToolId = item ? stringField(item, 'id') : undefined;
      if (providerToolId) {
        this.providerToolsById.delete(providerToolId);
        this.activeProviderToolIds.delete(providerToolId);
        this.resolveQuiescentWaitersIfReady();
      }
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const input = this.currentTurn?.input ?? this.activeInput;
      if (!input) return;
      const stats = codexContextStatsFromTokenUsage(recordParam(message.params, 'tokenUsage'), this.runtimeKind);
      if (stats) await input.effects.recordEvent(stats);
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = recordParam(message.params, 'turn');
      const turnId = stringParam(turn, 'id');
      if (!turnId) return;
      const stats = codexSessionStatsFromTurn(turn, this.runtimeKind);
      const input = this.currentTurn?.input ?? this.activeInput;
      if (input) await this.flushLinkedAgentText(input);
      if (input) void this.recordSessionFileSubagentSpawns(input, turnId).catch(() => undefined);
      if (stats && input) await input.effects.recordEvent(stats);
      this.completedTurns.add(turnId);
      if (this.currentTurn?.turnId === turnId) this.currentTurn.completed.resolve();
    }
  }

  private resolveQuiescentWaitersIfReady(): void {
    this.quiescentWaiters.resolveIfReady(() => this.activeProviderToolIds.size === 0);
  }

  private rejectQuiescentWaiters(error: unknown): void {
    this.quiescentWaiters.reject(error);
  }

  private acceptAgentMessageDelta(params: Record<string, unknown> | undefined): void {
    const turnId = stringParam(params, 'turnId');
    const delta = stringParam(params, 'delta');
    if (!delta) return;
    const subagentLinkage = codexSubagentLinkageFromRecord(params);
    if (Object.keys(subagentLinkage).length === 0) {
      if (turnId) this.textByTurn.set(turnId, `${this.textByTurn.get(turnId) ?? ''}${delta}`);
      return;
    }
    const itemId =
      stringParam(params, 'itemId') ??
      stringParam(params, 'subRunId') ??
      stringParam(params, 'sub_run_id') ??
      stringParam(params, 'threadId') ??
      'subagent';
    const current = this.linkedTextByItem.get(itemId);
    this.linkedTextByItem.set(itemId, {
      payload: {
        eventType: 'codex.agent.message',
        ...subagentLinkage,
      },
      text: `${current?.text ?? ''}${delta}`,
    });
  }

  private async flushLinkedAgentText(input: AgentRuntimeInput): Promise<void> {
    for (const entry of this.linkedTextByItem.values()) {
      if (entry.text.trim()) await input.effects.recordAgentText(entry.text.trim(), entry.payload);
    }
    this.linkedTextByItem.clear();
  }

  private async acceptRawResponseItem(params: Record<string, unknown> | undefined): Promise<boolean> {
    const input = this.currentTurn?.input ?? this.activeInput;
    if (!input) return false;
    const item = recordParam(params, 'item');
    const spawnCall = codexSubagentSpawnCallFromRawResponseItem(item);
    if (spawnCall) {
      this.pendingSubagentSpawns.set(spawnCall.parentToolCallId, spawnCall);
      await this.recordSubagentParentTool(input, spawnCall);
      return true;
    }

    const spawnOutput = codexSubagentSpawnOutputFromRawResponseItem(item);
    if (!spawnOutput) return false;
    const spawn = this.pendingSubagentSpawns.get(spawnOutput.callId);
    if (!spawn) return false;
    this.pendingSubagentSpawns.delete(spawnOutput.callId);
    void this.recordSpawnedSubagent(input, spawn, spawnOutput).catch(() => undefined);
    return true;
  }

  private async recordSessionFileSubagentSpawns(input: AgentRuntimeInput, turnId: string): Promise<void> {
    if (!this.threadId) return;
    const session = await readCodexSessionFile(this.threadId, input.env, this.sessionFilePath).catch(() => undefined);
    if (!session) return;
    this.sessionFilePath = session.path;
    for (const pair of codexSubagentSpawnPairsFromSessionJsonl(session.contents, turnId)) {
      await this.recordSubagentParentTool(input, pair.spawn);
      await this.recordSpawnedSubagent(input, pair.spawn, pair.output);
    }
  }

  private async recordSubagentParentTool(
    input: AgentRuntimeInput,
    spawn: PendingCodexSubagentSpawn,
  ): Promise<void> {
    if (this.recordedSubagentParents.has(spawn.parentToolCallId)) return;
    this.recordedSubagentParents.add(spawn.parentToolCallId);
    await input.effects.recordToolStarted({
      provider: 'codex-cli',
      providerToolId: spawn.parentToolCallId,
      providerToolName: 'Agent',
      tool: 'codex.agent',
    });
  }

  private async recordSpawnedSubagent(
    input: AgentRuntimeInput,
    spawn: PendingCodexSubagentSpawn,
    spawnOutput: { name?: string; subRunId: string },
  ): Promise<void> {
    const childKey = `${spawn.parentToolCallId}:${spawnOutput.subRunId}`;
    if (this.recordedSubagentChildren.has(childKey)) return;
    this.recordedSubagentChildren.add(childKey);
    const childMetadata = await this.readSubagentThreadMetadata(spawnOutput.subRunId).catch(() => ({}));
    const name = stringField(childMetadata, 'name') ?? spawnOutput.name;
    const role = stringField(childMetadata, 'role') ?? spawn.role;
    const model = stringField(childMetadata, 'model');
    await input.effects.recordAgentText(
      name ? `Started subagent ${name}` : 'Started subagent',
      {
        eventType: 'codex.subagent.delegated',
        depth: 1,
        parentToolCallId: spawn.parentToolCallId,
        subRunId: spawnOutput.subRunId,
        ...(name ? { name } : {}),
        ...(role ? { role } : {}),
        ...(model ? { model } : {}),
      },
    );
  }

  private async readSubagentThreadMetadata(threadId: string): Promise<Record<string, unknown>> {
    const result = asRecord(await this.request('thread/resume', { threadId }));
    try {
      await this.request('thread/unsubscribe', { threadId });
    } catch {
      // Best-effort only: the metadata lookup has already completed, and old
      // app-server builds may not expose unsubscribe for resumed threads.
    }
    return codexThreadMetadataFromResumeResponse(result);
  }
}

async function readCodexSessionFile(
  threadId: string,
  env: NodeJS.ProcessEnv,
  cachedPath: string | undefined,
): Promise<{ contents: string; path: string } | undefined> {
  if (cachedPath) {
    return { contents: await readFile(cachedPath, 'utf8'), path: cachedPath };
  }
  const path = await findCodexSessionFile(codexSessionsRoot(env), threadId);
  return path ? { contents: await readFile(path, 'utf8'), path } : undefined;
}

async function findCodexSessionFile(root: string, threadId: string): Promise<string | undefined> {
  const stack: Array<{ depth: number; path: string }> = [{ depth: 0, path: root }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await readdir(current.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return path;
      }
      if (entry.isDirectory() && current.depth < 4) stack.push({ depth: current.depth + 1, path });
    }
  }
  return undefined;
}

function codexSessionsRoot(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(codexHome, 'sessions');
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function threadFromResponse(value: unknown): CodexThread {
  const record = asRecord(asRecord(value)?.['thread']);
  if (!record) throw new Error('Codex app-server response missing thread');
  const id = typeof record['id'] === 'string' ? record['id'] : undefined;
  if (!id) throw new Error('Codex app-server thread response missing id');
  return { id };
}

function turnIdFromResponse(value: unknown): string {
  const turn = asRecord(asRecord(value)?.['turn']);
  if (!turn) throw new Error('Codex app-server response missing turn');
  const id = turn['id'];
  if (typeof id !== 'string' || !id) throw new Error('Codex app-server turn response missing id');
  return id;
}

function codexThreadMetadataFromResumeResponse(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const thread = asRecord(value?.['thread']);
  const name = stringField(thread, 'agentNickname') ?? stringField(thread, 'agent_nickname');
  const role = stringField(thread, 'agentRole') ?? stringField(thread, 'agent_role');
  const model = stringField(value, 'model');
  return {
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
  };
}
