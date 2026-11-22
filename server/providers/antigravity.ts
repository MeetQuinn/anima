import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProviderWorkSnapshot } from '../../shared/snapshot.js';

import { errorMessage, nowIso } from '../ids.js';
import { isRecord, numberField, singleLineForActivity, stringField } from '../json.js';
import { truncateForActivity } from '../activities/format.js';
import { raceWithTimeout } from '../race-timeout.js';
import { type RunningChildProcess } from './child-process.js';
import { providerUsageFromStats } from './provider-usage.js';
import { AcpJsonRpcError, AcpJsonRpcPeer } from './acp-json-rpc.js';
import { ClassifiedProviderError, providerFailureReasonFromError } from './provider-failure.js';
import { classifyProviderRetry, providerRateLimitResumeAt } from './provider-retry.js';
import { acpPermissionApprovalOptionId } from './acp-permissions.js';
import { antigravityInputTag } from './antigravity-input-tag.js';
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

/** The custom agent Anima writes for `agy acp --agent`. */
const ANTIGRAVITY_AGENT_NAME = 'anima-runtime';

/**
 * The Antigravity tools an Anima agent keeps. A custom agent that excludes the
 * default components starts with none of them (agy always adds manage_task,
 * which manages commands that went to the background). Questions and reminders
 * go through Anima, so ask_question and schedule stay out, and so do swarm and
 * run_workflow. Subagents run in the background and report in a turn agy starts
 * on its own; the controller attaches that turn to the item that started them.
 */
const ANTIGRAVITY_AGENT_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'run_command',
  'search_web',
  'define_subagent',
  'invoke_subagent',
  'manage_subagents',
  'send_message',
];

/** The tool name of agy's `invoke_subagent` call (titled `Run invoke_subagent`); see antigravityToolName. */
const ANTIGRAVITY_INVOKE_SUBAGENT_TOOL = 'RunInvokeSubagent';

/** Names the file the Stop hook appends to; one file per `agy acp` process. */
const ANTIGRAVITY_HOOK_EVENTS_ENV = 'ANIMA_ANTIGRAVITY_HOOK_EVENTS';
const ANTIGRAVITY_HOOK_KEY_ENV = 'ANIMA_ANTIGRAVITY_HOOK_KEY';

/**
 * `agy acp` is Antigravity CLI's official ACP server — the same entry point Zed,
 * JetBrains and Xcode launch. Flags go after `acp`. An Anima agent has no one to
 * answer permission prompts, so tool calls are approved up front, as with the
 * other providers. With `agentDir`, the session runs Anima's custom agent from
 * that directory (see antigravityAgentDefinition).
 */
export function antigravityAcpLaunchArgs(providerArgs: readonly string[] = [], agentDir?: string): string[] {
  return [
    'acp',
    ...providerArgs,
    '--dangerously-skip-permissions',
    ...(agentDir ? ['--add-dir', agentDir, '--agent', ANTIGRAVITY_AGENT_NAME] : []),
  ];
}

/**
 * `agy acp` can only append to its own system prompt, which describes Antigravity
 * and a dozen tools Anima does not use. A custom agent with
 * `excludeDefaultComponents: true` replaces it: the body becomes the whole system
 * prompt and `tools` the whole tool set. Without the default prompt the model is
 * not told its working directory, so the definition says it.
 */
export function antigravityAgentDefinition(systemPrompt: string, cwd: string): string {
  return [
    '---',
    `name: ${ANTIGRAVITY_AGENT_NAME}`,
    'description: Anima agent runtime',
    'excludeDefaultComponents: true',
    `tools: [${ANTIGRAVITY_AGENT_TOOLS.join(', ')}]`,
    '---',
    systemPrompt.trim(),
    '',
    `Your working directory is ${cwd}.`,
    '',
  ].join('\n');
}

/**
 * agy reads lifecycle hooks from `.agents/hooks.json` in the same directory as the
 * custom agent. The Stop hook runs each time an execution loop ends, and its
 * `fullyIdle` says whether background work (subagents, commands that went to the
 * background) is still running. agy runs hooks synchronously, so an event is on
 * disk before agy sends its next message.
 */
export function antigravityHooksDefinition(nodePath: string, scriptPath: string): string {
  const command = `${shellQuote(nodePath)} ${shellQuote(scriptPath)}`;
  return `${JSON.stringify({ anima: { Stop: [{ command, timeout: 10, type: 'command' }] } }, null, 2)}\n`;
}

function antigravityStopHookScript(): string {
  return fileURLToPath(new URL('./antigravity-stop-hook.js', import.meta.url));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
}

/**
 * agy reads custom agents from `<workspace>/.agents/agents/<name>.md`, and `--add-dir`
 * adds a workspace directory without changing the session's cwd. The directory sits
 * beside the agent's other provider files in Anima's run directory.
 */
function antigravityAgentDir(systemPromptFilePath: string): string {
  return join(dirname(systemPromptFilePath), 'antigravity-cli-agent');
}

/**
 * Writes Anima's custom agent and its Stop hook, and checks that this `agy` finds
 * the agent. agy runs an unknown `--agent` as its default agent without saying so,
 * which would drop the system prompt entirely, so the session uses the agent only
 * when `agy agents` lists it; otherwise the prompt is appended as before.
 * `hookEvents` is the file this launch's Stop hook appends to, and `hookKey` the
 * key of the input digests it writes. Undefined when there is no system prompt to carry.
 */
async function prepareAntigravityAgent(
  command: string,
  input: AgentRuntimeInput,
  env: NodeJS.ProcessEnv,
  check: AntigravityAgentCheckOptions,
): Promise<{ dir: string; hookEvents: string; hookKey: string } | { problem: string } | undefined> {
  const systemPrompt = input.systemPrompt?.trim();
  if (!systemPrompt) return undefined;
  if (!input.systemPromptFilePath) return { problem: 'no runtime directory' };
  const dir = antigravityAgentDir(input.systemPromptFilePath);
  try {
    await writeFileAtomic(
      join(dir, '.agents', 'agents', `${ANTIGRAVITY_AGENT_NAME}.md`),
      antigravityAgentDefinition(systemPrompt, input.cwd),
    );
    await writeFileAtomic(
      join(dir, '.agents', 'hooks.json'),
      antigravityHooksDefinition(process.execPath, antigravityStopHookScript()),
    );
    await mkdir(join(dir, 'events'), { recursive: true });
    const stdout = await listAntigravityAgents(command, dir, { cwd: input.cwd, env, signal: input.signal }, check);
    const listed = stdout.split(/\r?\n/).some((line) => line.trim() === ANTIGRAVITY_AGENT_NAME);
    return listed
      ? { dir, hookEvents: join(dir, 'events', `${randomUUID()}.jsonl`), hookKey: randomBytes(32).toString('hex') }
      : { problem: '`agy agents` did not list the agent' };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { problem: truncateForActivity(errorMessage(error)) };
  }
}

export interface AntigravityAgentCheckOptions {
  killGraceMs?: number;
  timeoutMs?: number;
}

/**
 * Runs `agy --add-dir <dir> agents` and returns what it prints. The check runs
 * while the provider launch permit is held, so it is bounded. It starts in a
 * process group of its own, so a wrapper script and the CLI it starts are
 * stopped together: on timeout or abort the group gets SIGTERM, then SIGKILL
 * after a grace period, and the check waits for the group to be gone.
 */
async function listAntigravityAgents(
  command: string,
  dir: string,
  input: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined },
  options: AntigravityAgentCheckOptions,
): Promise<string> {
  input.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const child = spawn(command, ['--add-dir', dir, 'agents'], {
    cwd: input.cwd,
    detached: true,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length < 1024 * 1024) stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let stopped = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
        reject(new Error(`\`agy agents\` exited with ${signal ?? `code ${String(code)}`}${detail}`));
      });
      timer = setTimeout(() => {
        stopped = true;
        reject(new Error(`\`agy agents\` did not finish within ${timeoutMs} ms`));
      }, timeoutMs);
      onAbort = () => {
        stopped = true;
        reject(input.signal?.reason);
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener('abort', onAbort);
    // A wrapper can exit on SIGTERM and leave the CLI behind, so the whole group is
    // stopped even when the direct child is already gone.
    if (stopped || (child.exitCode === null && child.signalCode === null)) {
      await stopProcessGroup(child.pid, killGraceMs);
    }
  }
}

/** SIGTERM to the process group led by `pid`, SIGKILL after `killGraceMs`, then wait (bounded) for it to be gone. */
async function stopProcessGroup(pid: number | undefined, killGraceMs: number): Promise<void> {
  // pid 0 or below would signal Anima's own process group.
  if (pid === undefined || pid <= 0) return;
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  const goneWithin = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!signalGroup(0)) return true;
    }
    return false;
  };
  if (!signalGroup('SIGTERM')) return;
  if (await goneWithin(killGraceMs)) return;
  signalGroup('SIGKILL');
  await goneWithin(1_000);
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

/**
 * Timing for turns agy starts on its own; tests shorten it. While such a turn or
 * background work is open, the hook file is checked every `pollMs`. A Stop is
 * applied by the poll once it is `settleMs` old, and a self-started turn that
 * stays silent for `quietMs` is over.
 */
export interface AntigravityWakeTiming {
  /** How long a prompt waits for agy's answer to ANTIGRAVITY_BARRIER_METHOD before it goes out anyway. */
  barrierWaitMs?: number;
  pollMs?: number;
  quietMs?: number;
  settleMs?: number;
  /** How long agy stays silent after its last subagent stopped before its background work counts as done. */
  subagentsDoneMs?: number;
}

export class AntigravityCliAgentRuntime extends ControllerAgentRuntime<AntigravityAcpController> {
  readonly command: string;
  readonly env: Record<string, string> | undefined;
  readonly kind = ANTIGRAVITY_RUNTIME_KIND;
  private readonly agentCheck: AntigravityAgentCheckOptions;
  private readonly config: AntigravityCliAgentProviderConfig;
  private readonly providerArgs: readonly string[];
  private readonly wakeTiming: AntigravityWakeTiming;

  constructor(
    config: AntigravityCliAgentProviderConfig,
    command: string,
    providerArgs: readonly string[] = [],
    options: { agentCheck?: AntigravityAgentCheckOptions; wake?: AntigravityWakeTiming } = {},
  ) {
    super({ providerChildIdleTimeoutMs: config.providerChildIdleTimeoutMs });
    this.agentCheck = options.agentCheck ?? {};
    this.wakeTiming = options.wake ?? {};
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
        const controller = this.slot.get();
        // agy is stopped only when it is working on this run; a turn it started on
        // its own for an earlier item keeps going.
        if (controller && !(await controller.cancelActiveTurn())) return;
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
          const mapped = antigravityRpcError(error);
          if (mapped instanceof ClassifiedProviderError && mapped.reason === 'provider_auth_failed') {
            await this.slot.reset();
          }
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
        const agent = await prepareAntigravityAgent(this.command, input, env, this.agentCheck);
        if (agent && 'problem' in agent) {
          await input.effects.recordEvent({
            eventType: 'antigravity.agent.unavailable',
            problem: agent.problem,
            runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
            transport: 'acp',
          });
        }
        const agentDir = agent && 'dir' in agent ? agent.dir : undefined;
        const hooks = agent && 'dir' in agent ? { events: agent.hookEvents, key: agent.hookKey } : undefined;
        // A Stop that landed during the awaits above must not start agy or a session.
        input.signal?.throwIfAborted();
        return this.spawnController(
          {
            args: antigravityAcpLaunchArgs(this.providerArgs, agentDir),
            command: this.command,
            label: 'Antigravity ACP runtime',
          },
          {
            ...input,
            env: hooks ? { ...env, [ANTIGRAVITY_HOOK_EVENTS_ENV]: hooks.events, [ANTIGRAVITY_HOOK_KEY_ENV]: hooks.key } : env,
          },
          (child) => new AntigravityAcpController(child, {
            ...(hooks ? { hookEvents: hooks.events, hookKey: hooks.key } : {}),
            usesCustomAgent: agentDir !== undefined,
            wakeTiming: this.wakeTiming,
          }),
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

/** An `invoke_subagent` call, and when Anima read it. */
interface AntigravityInvoke {
  /**
   * The last prompt Anima had written when it handled the call (see promptGeneration).
   * Anima writes a prompt only once it has handled all it has read, so this is the
   * prompt whose loop made the call, or for a loop agy started on its own the prompt
   * before it: the prompt that loop's Stop carries.
   */
  generation: number;
  /** When the chunk holding the call was read from agy. */
  readAt: number;
}

interface AntigravitySubagentRuns {
  /** When `stopped` came to cover every call. */
  doneAt?: number;
  /** `invoke_subagent` calls that have not failed, by tool call id. */
  invoked: Map<string, AntigravityInvoke>;
  stopped: Set<string>;
  /** Whether a subagent's Stop came after the session's last one. */
  subagentStoppedLast?: boolean;
}

function newSubagentRuns(invoked: Map<string, AntigravityInvoke> = new Map()): AntigravitySubagentRuns {
  return { invoked, stopped: new Set() };
}

/** How many prompt digests Anima keeps to tell which prompt a Stop's loop ran for. */
const ANTIGRAVITY_PROMPT_TAGS_KEPT = 64;

/**
 * A request agy does not know. agy writes its answer to a request after everything
 * it wrote before reading it, and answers a method it does not know with an error
 * (-32601 on agy 1.5.14, within a millisecond, also mid-prompt), so reading that
 * answer means having read all agy wrote before it. The leading underscore marks
 * an ACP extension method.
 */
const ANTIGRAVITY_BARRIER_METHOD = '_anima/barrier';

/** A prompt Anima has written to agy and whose answer it has not read yet. */
interface AntigravityPromptOnWire {
  /** This prompt's place in promptGeneration. */
  generation: number;
  /** The digest the Stop hook writes for this prompt's text; see antigravityInputTag. */
  inputTag?: string;
  /**
   * The prompt before had the same text, so the Stop of a loop from before this
   * prompt carries this prompt's digest too.
   */
  repeatsPrevious?: boolean;
  sentAt: number;
  turn: AntigravityTurn;
}

/** A turn agy started on its own, such as a subagent's report. */
interface AntigravityWake {
  lastUpdateAt: number;
  /** The input of the item the turn's output is attached to. */
  sink: AgentRuntimeInput;
  text: string[];
}

interface AntigravityStopEvent {
  at: number;
  conversationId?: string;
  fullyIdle?: boolean;
  hookEventName?: string;
  /** Digest of the loop's last user input; see antigravityInputTag. */
  input?: string;
}

/**
 * Reads the events the Stop hook appends to its file. Events are returned in the
 * order they were written; `take` returns only the leading ones that are ready.
 */
class AntigravityHookEvents {
  private offset = 0;
  private partial = Buffer.alloc(0);
  private readonly queued: AntigravityStopEvent[] = [];

  constructor(readonly path: string) {}

  /** Events read but not yet taken, oldest first. */
  pending(): readonly AntigravityStopEvent[] {
    this.readAppended();
    return [...this.queued];
  }

  take(ready: (event: AntigravityStopEvent) => boolean): AntigravityStopEvent[] {
    this.readAppended();
    const notReady = this.queued.findIndex((event) => !ready(event));
    return this.queued.splice(0, notReady === -1 ? this.queued.length : notReady);
  }

  private readAppended(): void {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return;
      const chunk = Buffer.alloc(size - this.offset);
      const read = readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += read;
      const data = Buffer.concat([this.partial, chunk.subarray(0, read)]);
      const end = data.lastIndexOf(0x0a);
      this.partial = Buffer.from(data.subarray(end + 1));
      if (end < 0) return;
      for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
        const event = parseAntigravityStopEvent(line);
        if (event) this.queued.push(event);
      }
    } catch {
      // A missed event only delays quiescence until the next one.
    } finally {
      closeSync(fd);
    }
  }
}

function parseAntigravityStopEvent(line: string): AntigravityStopEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const at = numberField(value, 'at');
  if (at === undefined) return undefined;
  const conversationId = stringField(value, 'conversationId');
  const hookEventName = stringField(value, 'hookEventName');
  const input = stringField(value, 'input');
  return {
    at,
    ...(conversationId ? { conversationId } : {}),
    ...(typeof value['fullyIdle'] === 'boolean' ? { fullyIdle: value['fullyIdle'] } : {}),
    ...(hookEventName ? { hookEventName } : {}),
    ...(input ? { input } : {}),
  };
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
  /** The last Stop of the session's own conversation said background work is still running. */
  private backgroundPending = false;
  private exited = false;
  private readonly hookEvents?: AntigravityHookEvents;
  private readonly hookKey?: string;
  /** The input of the last turn, for a self-started turn when no background work was announced. */
  private lastTurnInput?: AgentRuntimeInput;
  /** The input of the turn that left background work; turns agy starts on its own report here. */
  private observer?: AgentRuntimeInput;
  /**
   * Subagents since the session's own conversation was last fully idle: its
   * `invoke_subagent` calls, which subagent conversations have stopped since, and
   * the Stop that made those cover every call, unless the session said more work was
   * running after it. See subagentsDone.
   */
  private subagents: AntigravitySubagentRuns = newSubagentRuns();
  /** How many prompts Anima has written to agy. */
  private promptGeneration = 0;
  /** The last prompt written with each digest, for the recent ones. */
  private readonly promptTags = new Map<string, number>();
  /**
   * The turn whose `session/prompt` Anima has written and whose answer it has not
   * yet read, and when it was written. agy's updates belong to it only in that window.
   */
  private promptOnWire?: AntigravityPromptOnWire;
  /** Writes of self-started turns' text; quiescence and `completion` wait for them. */
  private readonly wakeWrites = new Set<Promise<void>>();
  private wake?: AntigravityWake;
  private wakePoll?: NodeJS.Timeout;
  private readonly wakeTiming: Required<AntigravityWakeTiming>;
  /** agy left the last ANTIGRAVITY_BARRIER_METHOD request unanswered past barrierWaitMs. */
  private barrierUnanswered = false;
  private configOptions: AcpSelectOption[] = [];
  private currentTurn?: AntigravityTurn;
  private initialized?: Promise<void>;
  /** Whether agy has started the session; until then it works only for the run that started it. */
  private sessionReady = false;
  private latestUsage?: Record<string, unknown>;
  private readonly usageCaptureId = randomUUID();
  private usageSequence = 0;
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly quiescentWaiters = new QuiescentWaiterSet();
  private readonly rpc: AcpJsonRpcPeer;
  private turnCompletion?: Promise<string>;
  /** True while a session/prompt RPC is outstanding. */
  private promptInFlight = false;
  // Length of the turn text when the current prompt last reported a tool step.
  private textAtLastStep = 0;
  /** Whether `agy acp` takes an appended system prompt on session/new. */
  private supportsSystemPromptAppend = false;
  /** Whether this process runs Anima's custom agent, whose body is the system prompt. */
  private readonly usesCustomAgent: boolean;
  /** Whether this session already carries Anima's system prompt. */
  private sessionHasSystemPrompt = false;
  readonly completion: Promise<{ stdout: string; stderr: string }>;
  sessionId = '';

  constructor(
    private readonly child: RunningChildProcess,
    options: { hookEvents?: string; hookKey?: string; usesCustomAgent?: boolean; wakeTiming?: AntigravityWakeTiming } = {},
  ) {
    this.usesCustomAgent = options.usesCustomAgent ?? false;
    if (options.hookEvents) this.hookEvents = new AntigravityHookEvents(options.hookEvents);
    if (options.hookKey) this.hookKey = options.hookKey;
    this.wakeTiming = {
      barrierWaitMs: options.wakeTiming?.barrierWaitMs ?? 10_000,
      pollMs: options.wakeTiming?.pollMs ?? 1_000,
      quietMs: options.wakeTiming?.quietMs ?? 120_000,
      settleMs: options.wakeTiming?.settleMs ?? 2_000,
      subagentsDoneMs: options.wakeTiming?.subagentsDoneMs ?? 10_000,
    };
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
      async (result) => {
        this.fail(
          new Error('Antigravity ACP runtime exited'),
          new Error('Antigravity ACP runtime exited before completing active turn'),
        );
        await this.wakeWritesDone();
        return result;
      },
      async (error) => {
        this.fail(error);
        await this.wakeWritesDone();
        throw error;
      },
    );
  }

  /**
   * The system prompt goes into the session itself: as Anima's custom agent, or
   * appended on session/new (`_meta.antigravity.systemPrompt.append`) when the
   * agent is unavailable. agy keeps a session's agent and prompt when it is
   * resumed, so a resumed session already has it. Only an older CLI with neither
   * gets the prompt prepended.
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
        .then(() => {
          this.sessionReady = true;
        })
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
    let turn!: AntigravityTurn;
    const result = new Promise<string>((resolve, reject) => {
      turn = {
        acceptingFollowups: true,
        followups: [],
        input,
        reject,
        resolve,
        text: [],
      };
    });
    this.currentTurn = turn;
    this.turnCompletion = result;
    void this.runTurnQueue(turn, prompt).catch((error) => this.abortTurn(turn, error));
    return result.finally(() => {
      if (this.turnCompletion === result) this.turnCompletion = undefined;
    });
  }

  /**
   * Stops the active turn of a run whose signal has aborted, and says whether agy
   * has to be stopped too. That is so only while agy works for the run: while it
   * starts the session, or works on one of the turn's prompts. A run with no prompt
   * on the wire sends none from here on (each send checks the signal first), and agy
   * may meanwhile be running a turn it started on its own for an earlier item, so a
   * cancel or a reset would stop that turn instead. Such a turn that has not ended
   * within 2s is held up in Anima's own writes; it ends here, and what is left of it
   * finds the turn gone and does nothing more.
   */
  async cancelActiveTurn(): Promise<boolean> {
    const turn = this.currentTurn;
    if (!turn) return !this.sessionReady;
    turn.acceptingFollowups = false;
    turn.followups.length = 0;
    const onWire = this.promptOnWire?.turn === turn;
    if (onWire && this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId });
    const completion = this.turnCompletion;
    const ended = !completion || await raceWithTimeout(completion.then(() => true, () => true), 2_000, false);
    if (onWire) return true;
    if (!ended) this.abortTurn(turn, new Error(`Antigravity turn cancelled: ${String(turn.input.signal?.reason ?? 'aborted')}`));
    return false;
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

  /** Also waits for output already read from agy, which can open a self-started turn again. */
  async waitForQuiescent(signal?: AbortSignal): Promise<void> {
    for (;;) {
      await this.quiescentWaiters.waitUntilReady(() => this.isSettled(), signal);
      if (!this.outputPending()) return;
      await settledUnlessAborted(this.child.outputSettled!(), signal);
    }
  }

  isQuiescent(): boolean {
    return this.isSettled() && !this.outputPending();
  }

  /**
   * No tool call in flight, no turn agy started on its own, no background work its
   * last Stop reported, and no self-started turn's text still being written.
   */
  private isSettled(): boolean {
    return this.activeToolIds.size === 0 && !this.wake && !this.backgroundPending && this.wakeWrites.size === 0;
  }

  /** Output has been read from agy but not yet handled. */
  private outputPending(): boolean {
    return Boolean(this.child.outputSettled && this.child.outputPending?.());
  }

  /** Settles once all output read from agy so far has been handled; rejects once `signal` aborts. */
  private async outputHandled(signal?: AbortSignal): Promise<void> {
    while (this.outputPending()) await settledUnlessAborted(this.child.outputSettled!(), signal);
  }

  /**
   * Reads and handles everything agy wrote until now, also what is still unread:
   * once the answer to ANTIGRAVITY_BARRIER_METHOD is read, so is all agy wrote before.
   * Any answer will do; if agy has exited, writing the prompt fails as before. An agy
   * that leaves the request unanswered for barrierWaitMs gets no more of them until
   * that answer comes, so it holds up one prompt, not every one.
   */
  private async outputSoFarHandled(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error('Drain wait aborted');
    if (!this.barrierUnanswered) {
      let answered = false;
      const answer = this.rpc.request(ANTIGRAVITY_BARRIER_METHOD, {}).then(() => undefined, () => undefined).then(() => {
        answered = true;
        this.barrierUnanswered = false;
      });
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.wakeTiming.barrierWaitMs);
      });
      try {
        await settledUnlessAborted(Promise.race([answer, waited]), signal);
      } finally {
        clearTimeout(timer);
      }
      if (!answered) {
        // The timer can fire before output already waiting is read, as when Anima's
        // event loop was held, so what is there is read and handled before giving up.
        await new Promise((resolve) => setImmediate(resolve));
        await this.outputHandled(signal);
        if (!answered) this.barrierUnanswered = true;
      }
    }
    await this.outputHandled(signal);
  }

  workSnapshot(): ProviderWorkSnapshot | undefined {
    if (!this.wake && !this.backgroundPending) return undefined;
    return { state: this.currentTurn || this.wake ? 'working' : 'background' };
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
        this.sessionHasSystemPrompt = this.usesCustomAgent || this.supportsSystemPromptAppend;
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
    const appendSystemPrompt = Boolean(systemPrompt && !this.usesCustomAgent && this.supportsSystemPromptAppend);
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
    this.sessionHasSystemPrompt = this.usesCustomAgent || appendSystemPrompt;
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

  /** A turn cancelActiveTurn ended while it was held up still runs this; it then leaves the controller alone. */
  private async runTurnQueue(turn: AntigravityTurn, firstPrompt: string): Promise<void> {
    await drainAcpTurnQueue({
      firstPrompt,
      runOnePrompt: (prompt) => this.runOnePrompt(turn, prompt),
      turn,
    });
    await this.finishTurn(turn);
  }

  private async runOnePrompt(turn: AntigravityTurn, prompt: string): Promise<void> {
    this.latestUsage = undefined;
    await turn.input.effects.recordEvent({
      eventType: 'antigravity.turn.started',
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      transport: 'acp',
      userInputLength: prompt.length,
    });
    // What agy wrote before this prompt belongs to the turn it was part of, so it
    // is read and handled first, however long Anima has left it unread. A Stop
    // during that wait means the prompt is never sent; nothing between the check
    // and the write yields. A stopped turn may already be gone (see
    // cancelActiveTurn), so the check comes before any shared state.
    const signal = turn.input.signal;
    const handled = await this.outputSoFarHandled(signal).then(() => true, () => false);
    if (!handled || signal?.aborted) {
      await turn.input.effects.recordEvent({
        eventType: 'antigravity.turn.completed',
        runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
        terminalReason: 'cancelled',
        transport: 'acp',
      });
      return;
    }
    const sourceId = `${this.sessionId}:${this.usageCaptureId}:prompt:${++this.usageSequence}`;
    const model = this.option('model')?.currentValue;
    // Assistant chunks stream into turn.text; if this prompt is cancelled for a
    // mid-turn follow-up, discard only the chunks produced by this prompt.
    const textCheckpoint = turn.text.length;
    this.textAtLastStep = textCheckpoint;
    let result: Record<string, unknown> | undefined;
    try {
      result = await withAcpPromptInFlight(
        (value) => {
          this.promptInFlight = value;
        },
        () => this.sendPrompt(turn, prompt),
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
    // agy's quota notice is a step of its own: the whole reply since the last tool step.
    const quotaNotice = stopReason === 'end_turn'
      ? antigravityQuotaNotice(turn.text.slice(Math.max(textCheckpoint, this.textAtLastStep)).join(''))
      : undefined;
    if (quotaNotice) {
      turn.text.length = textCheckpoint;
      throw new AntigravityQuotaError(quotaNotice);
    }
    await turn.input.effects.recordEvent({
      eventType: 'antigravity.turn.completed',
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      terminalReason: stopReason,
      transport: 'acp',
    });
  }

  /**
   * A prompt sent while agy runs a turn of its own joins that turn: what agy said
   * before this write goes to that turn's item, and everything after it to this
   * prompt until its answer is read.
   */
  private sendPrompt(turn: AntigravityTurn, prompt: string): Promise<Record<string, unknown> | undefined> {
    this.recordWakeText(this.detachWake());
    const inputTag = this.hookKey ? antigravityInputTag(this.hookKey, prompt) : undefined;
    // promptGeneration is still the prompt written last.
    const repeatsPrevious = inputTag !== undefined && this.promptTags.get(inputTag) === this.promptGeneration;
    const wire: AntigravityPromptOnWire = {
      generation: ++this.promptGeneration,
      ...(inputTag !== undefined ? { inputTag, repeatsPrevious } : {}),
      sentAt: Date.now(),
      turn,
    };
    if (wire.inputTag !== undefined) {
      this.promptTags.delete(wire.inputTag);
      this.promptTags.set(wire.inputTag, wire.generation);
      if (this.promptTags.size > ANTIGRAVITY_PROMPT_TAGS_KEPT) this.promptTags.delete(this.promptTags.keys().next().value!);
    }
    this.promptOnWire = wire;
    return this.rpc.request(
      'session/prompt',
      { prompt: [{ text: prompt, type: 'text' }], sessionId: this.sessionId },
      { onResponse: () => this.promptAnswered(wire) },
    );
  }

  /**
   * Runs as agy's answer is read, before the update that follows it on the wire.
   * agy runs a prompt's Stop just before it answers, so the prompt's Stop is on
   * disk by now, after the send. A Stop still being written when the prompt was
   * sent can land after the send too; it carries the input of the loop before,
   * while this prompt's Stop, and those of later loops, carry this prompt's. So
   * the prompt's Stop is the first own Stop after the send with this prompt's
   * input, or without digests the first own Stop after the send. Stops before it
   * end earlier loops; any after it end later loops and wait for the poll, however
   * late the answer is read. When the prompt before had the same text, that
   * earlier Stop carries this prompt's input too. agy runs one loop at a time,
   * runs its Stop before the next loop starts, and answers right after the
   * prompt's Stop, so the prompt's Stop is then the last own Stop with its input
   * so far. Should the answer be read so late that a later loop has also ended,
   * that loop's Stop is taken: it holds the later state, and output of that loop
   * read afterwards ends with the quiet period.
   */
  private promptAnswered(wire: AntigravityPromptOnWire): void {
    if (this.promptOnWire !== wire) return;
    this.promptOnWire = undefined;
    this.lastTurnInput = wire.turn.input;
    // Tool calls still open went to the background; their updates now arrive outside a prompt.
    this.activeToolIds.clear();
    const sinceSend = (this.hookEvents?.pending() ?? []).filter((event) => event.at > wire.sentAt && this.isOwnStop(event));
    const tagged = sinceSend.filter((event) => wire.inputTag !== undefined && event.input === wire.inputTag);
    const promptStop = (wire.repeatsPrevious ? tagged.at(-1) : tagged[0]) ?? sinceSend[0];
    let reached = false;
    this.applyHookEvents((event) => {
      if (reached) return false;
      reached = event === promptStop;
      return true;
    }, wire.turn.input, { generation: wire.generation, promptStop });
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
    const turn = this.promptOnWire?.turn;
    if (!turn) {
      await this.handleUpdateOutsideTurn(type, data);
      return;
    }

    if (type === 'agent_message_chunk') {
      const text = extractAcpText(data);
      if (text) turn.text.push(text);
      return;
    }
    if (type === 'agent_thought_chunk') {
      await this.recordThought(turn.input, data);
      return;
    }
    if (type === 'tool_call' || type === 'tool_call_update') {
      this.textAtLastStep = turn.text.length;
      await this.handleToolCall(turn.input, data);
      return;
    }
    if (type === 'usage_update') {
      const usage = acpUsagePayload(data);
      if (!usage) return;
      this.latestUsage = { ...(this.latestUsage ?? {}), ...usage };
      await this.recordContextStats(turn.input, usage);
    }
  }

  /**
   * agy starts a turn on its own when a subagent reports or a command it sent to
   * the background finishes. That turn has no prompt and no end marker; its
   * output goes to the item that left the background work (or the last item),
   * and it ends with the next Stop of the session's own conversation.
   */
  private async handleUpdateOutsideTurn(type: string | undefined, data: Record<string, unknown>): Promise<void> {
    const opensWake = type === 'agent_message_chunk'
      || type === 'agent_thought_chunk'
      || type === 'tool_call'
      || type === 'tool_call_update';
    if (opensWake && !this.wake) {
      const sink = this.observer ?? this.lastTurnInput;
      if (!sink) return;
      this.wake = { lastUpdateAt: Date.now(), sink, text: [] };
      this.updateWakePoll();
    }
    const wake = this.wake;
    if (wake) wake.lastUpdateAt = Date.now();
    const sink = wake?.sink ?? this.observer ?? this.lastTurnInput;
    if (!sink) return;
    try {
      if (type === 'agent_message_chunk') {
        const text = extractAcpText(data);
        if (text) wake?.text.push(text);
      } else if (type === 'agent_thought_chunk') {
        await this.recordThought(sink, data);
      } else if (type === 'tool_call' || type === 'tool_call_update') {
        await this.handleToolCall(sink, data);
      } else if (type === 'usage_update') {
        const usage = acpUsagePayload(data);
        if (usage) await this.recordContextStats(sink, usage);
      }
    } catch {
      // The item may be gone; a lost activity row must not stop the controller.
    }
  }

  private async recordThought(input: AgentRuntimeInput, data: Record<string, unknown>): Promise<void> {
    const text = extractAcpText(data);
    if (!text) return;
    await input.effects.recordEvent({
      eventType: 'antigravity.thinking.delta',
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      text: truncateForActivity(text),
      transport: 'acp',
    });
    await input.effects.recordEvent(exposedReasoningEvent({
      provider: 'antigravity',
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
      sourceEventType: 'antigravity.thinking.delta',
      text,
      textKind: 'think',
    }));
  }

  private async recordContextStats(input: AgentRuntimeInput, usage: Record<string, unknown>): Promise<void> {
    await input.effects.recordEvent({
      ...usage,
      eventType: 'antigravity.context.stats',
      runtimeKind: ANTIGRAVITY_RUNTIME_KIND,
    });
  }

  /**
   * Applies, in order, the Stop events of the session's own conversation that are
   * `ready` (subagents have conversations of their own). Each Stop ends the
   * execution loop that was running, so a turn agy started on its own is over,
   * and `fullyIdle` says whether background work remains. Work that is done has
   * nothing left to report, so the next turn that leaves work, `answered`, owns
   * the reports. `answering` is the prompt whose answer is being read, and its Stop.
   */
  private applyHookEvents(
    ready: (event: AntigravityStopEvent) => boolean,
    answered?: AgentRuntimeInput,
    answering?: { generation: number; promptStop?: AntigravityStopEvent },
  ): void {
    if (this.exited) return;
    let stopped = false;
    for (const event of this.hookEvents?.take(ready) ?? []) {
      if (!this.isOwnStop(event)) {
        this.noteSubagentStop(event);
        continue;
      }
      stopped = true;
      this.backgroundPending = event.fullyIdle === false;
      if (this.backgroundPending) {
        this.subagents.doneAt = undefined;
        this.subagents.subagentStoppedLast = false;
      } else {
        this.observer = undefined;
        // A Stop can be applied after later output was handled; calls of later prompts
        // start the next work. Without a prompt for the Stop, agy writes a call before
        // the Stop that ends its loop; a call read in the same millisecond stays, as
        // counting a call too many only waits longer.
        const generation = this.stopGeneration(event, answering);
        const later = (call: AntigravityInvoke) => generation === undefined ? call.readAt >= event.at : call.generation > generation;
        this.subagents = newSubagentRuns(new Map([...this.subagents.invoked].filter(([, call]) => later(call))));
      }
    }
    if (answered && this.backgroundPending) this.observer ??= answered;
    if (stopped && !this.promptOnWire) {
      this.endWake();
      if (!this.backgroundPending) this.pendingTools.clear();
    }
    this.settleBackground();
  }

  /**
   * The prompt whose loops an own Stop ends: the answered prompt for its own Stop,
   * else the last prompt written with the Stop's input. A Stop applied before a
   * prompt's own ends loops from before that prompt. Undefined when the input
   * matches no prompt Anima wrote (no digests, or a prompt from before).
   */
  private stopGeneration(
    event: AntigravityStopEvent,
    answering?: { generation: number; promptStop?: AntigravityStopEvent },
  ): number | undefined {
    if (answering && event === answering.promptStop) return answering.generation;
    const matched = event.input === undefined ? undefined : this.promptTags.get(event.input);
    const before = answering ?? this.promptOnWire;
    return matched === undefined || !before ? matched : Math.min(matched, before.generation - 1);
  }

  private isOwnStop(event: AntigravityStopEvent): boolean {
    return event.hookEventName === 'Stop' && Boolean(this.sessionId) && event.conversationId === this.sessionId;
  }

  /** A subagent's conversation stopped; its run is over unless it says work of its own is still running. */
  private noteSubagentStop(event: AntigravityStopEvent): void {
    if (event.hookEventName !== 'Stop' || !event.conversationId) return;
    const runs = this.subagents;
    if (event.fullyIdle === false) {
      runs.stopped.delete(event.conversationId);
      runs.doneAt = undefined;
      return;
    }
    runs.stopped.add(event.conversationId);
    runs.subagentStoppedLast = true;
    if (this.subagentsAllStopped()) runs.doneAt = event.at;
  }

  /**
   * A failed `invoke_subagent` call started no subagent, so no Stop is owed for it.
   * If the subagents that did start have all stopped, the work is done only when
   * the last of them stopped after the session's last Stop, as for subagentsDone.
   */
  private noteFailedInvoke(id: string, at: number): void {
    const runs = this.subagents;
    if (runs.invoked.delete(id) && runs.subagentStoppedLast && this.subagentsAllStopped()) runs.doneAt ??= at;
  }

  private subagentsAllStopped(): boolean {
    const invoked = this.subagents.invoked.size;
    return invoked > 0 && this.subagents.stopped.size >= invoked;
  }

  /**
   * A subagent hands its report to the session before its own run ends, so the
   * session can end the turn that reads the report with `fullyIdle: false` while
   * the subagent is still finishing. When that was the last background work, agy
   * runs no further loop and no Stop says the work is done. So the work counts as
   * done once as many subagent conversations as `invoke_subagent` calls that did
   * not fail have stopped, the last of them after the session's last Stop; no tool call is
   * still open (a command sent to the background); and agy has stayed silent for
   * `subagentsDoneMs`. A turn agy starts in that time, or a prompt, ends with a
   * Stop that decides instead.
   */
  private subagentsDone(now: number): boolean {
    const doneAt = this.subagents.doneAt;
    return this.backgroundPending
      && doneAt !== undefined
      && now - doneAt >= this.wakeTiming.subagentsDoneMs
      && !this.wake
      && !this.currentTurn
      && !this.promptOnWire
      && this.pendingTools.size === 0;
  }

  /** Ends the turn agy started on its own; tool calls still open in it went to the background. */
  private endWake(): void {
    const wake = this.detachWake();
    if (!wake) return;
    this.activeToolIds.clear();
    this.recordWakeText(wake);
  }

  private detachWake(): AntigravityWake | undefined {
    const wake = this.wake;
    this.wake = undefined;
    return wake;
  }

  /** Records a self-started turn's text on its item; quiescence and `completion` wait for the write. */
  private recordWakeText(wake: AntigravityWake | undefined): void {
    const text = wake?.text.join('').trim();
    if (!wake || !text) return;
    const write: Promise<void> = (async () => {
      try {
        await wake.sink.effects.recordAgentText(text, {
          eventType: 'antigravity.assistant',
          transport: 'acp',
        });
      } catch {
        // The item may be gone; the text is a record, not a reply.
      }
    })().finally(() => {
      this.wakeWrites.delete(write);
      this.resolveQuiescentWaitersIfReady();
    });
    this.wakeWrites.add(write);
  }

  private async wakeWritesDone(): Promise<void> {
    while (this.wakeWrites.size > 0) await Promise.all(this.wakeWrites);
  }

  /** Drops the observer once nothing is left to report, wakes drain waiters, and starts or stops the poll. */
  private settleBackground(): void {
    if (!this.currentTurn && !this.wake && !this.backgroundPending) this.observer = undefined;
    this.resolveQuiescentWaitersIfReady();
    this.updateWakePoll();
  }

  private updateWakePoll(): void {
    if (!this.exited && (this.wake || this.backgroundPending)) {
      if (this.wakePoll) return;
      this.wakePoll = setInterval(() => this.pollWake(), this.wakeTiming.pollMs);
      this.wakePoll.unref?.();
      return;
    }
    if (this.wakePoll) clearInterval(this.wakePoll);
    this.wakePoll = undefined;
  }

  /**
   * agy runs the Stop hook after the last update of an execution loop. A
   * prompt's answer follows its Stop and applies it; nothing follows the Stop of
   * a turn agy started on its own, so the poll applies a Stop once it has
   * settled and all output read from agy has been handled. The poll also ends a
   * self-started turn that has been silent for `quietMs` (an agy without hooks
   * never sends a Stop).
   */
  private pollWake(): void {
    // Output read before the Stop is recorded before the Stop ends anything.
    if (this.outputPending()) return;
    const now = Date.now();
    // A prompt's own Stop is for its answer to apply.
    const before = Math.min(now - this.wakeTiming.settleMs, this.promptOnWire?.sentAt ?? Infinity);
    this.applyHookEvents((event) => event.at <= before);
    if (this.wake && now - this.wake.lastUpdateAt >= this.wakeTiming.quietMs) {
      this.endWake();
      this.settleBackground();
    } else if (this.subagentsDone(now)) {
      this.backgroundPending = false;
      this.subagents = newSubagentRuns();
      this.settleBackground();
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
    const readAt = this.child.outputReadAt?.() ?? Date.now();
    if (!pending) {
      const name = antigravityToolName(data);
      if (name === ANTIGRAVITY_INVOKE_SUBAGENT_TOOL) this.subagents.invoked.set(id, { generation: this.promptGeneration, readAt });
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
    if (status === 'failed') this.noteFailedInvoke(id, readAt);

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
    if (this.currentTurn) this.abortTurn(this.currentTurn, error);
  }

  private abortTurn(turn: AntigravityTurn, error: unknown): void {
    if (this.currentTurn !== turn) return;
    this.clearCurrentTurn();
    turn.reject(error);
  }

  private clearCurrentTurn(): void {
    const turn = this.currentTurn;
    this.currentTurn = undefined;
    if (turn) {
      // A prompt agy never answered (a failed write, an exit) leaves no window open.
      if (this.promptOnWire?.turn === turn) this.promptOnWire = undefined;
      this.lastTurnInput = turn.input;
    }
    // A tool still running went to the background; keep its name for its result.
    if (!this.wake && !this.backgroundPending) this.pendingTools.clear();
    this.settleBackground();
  }

  /**
   * The turn is detached before the final writes, so a failed write must settle
   * it here: once `currentTurn` is cleared, abortTurn can no longer reach it.
   */
  private async finishTurn(turn: AntigravityTurn): Promise<void> {
    if (this.currentTurn !== turn) return;
    this.clearCurrentTurn();
    try {
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
    } catch (error) {
      turn.reject(error);
    }
  }

  private resolveQuiescentWaitersIfReady(): void {
    this.quiescentWaiters.resolveIfReady(() => this.isSettled());
  }

  /** `turnError` settles the active turn before the rejected requests' handlers run, so it decides how the turn is retried. */
  private fail(error: unknown, turnError: unknown = error): void {
    // Background work and a self-started turn end with the process.
    this.exited = true;
    this.rpc.rejectAll(error);
    this.quiescentWaiters.reject(error);
    this.recordWakeText(this.detachWake());
    this.backgroundPending = false;
    this.observer = undefined;
    this.promptOnWire = undefined;
    this.activeToolIds.clear();
    this.pendingTools.clear();
    this.abortCurrentTurn(turnError);
    this.updateWakePoll();
    if (this.hookEvents) void unlink(this.hookEvents.path).catch(() => {});
  }
}

/** Waits for `settled`, or rejects as a drain wait does once `signal` aborts. */
function settledUnlessAborted(settled: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) return settled.then(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Drain wait aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Drain wait aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void settled.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
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
 * `-32603 Failed to read session <id>; retry, or load it with session/load`. Only
 * that code and the error's own message count; any other resume error keeps the
 * saved session.
 */
function isAntigravitySessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof AcpJsonRpcError) || error.method !== 'session/resume') return false;
  return numberField(error.error, 'code') === -32603
    && /^Failed to read session\b/i.test(stringField(error.error, 'message')?.trim() ?? '');
}

const ANTIGRAVITY_QUOTA_SENTENCE =
  'Individual quota reached\\. Please upgrade your subscription to increase your limits\\. Resets in (?:\\d+[dhms])+\\.';
const ANTIGRAVITY_QUOTA_NOTICE = new RegExp(`^\\u26A0\\uFE0F?[^\\S\\n]*(${ANTIGRAVITY_QUOTA_SENTENCE})$`, 'u');

/**
 * When the account is out of quota, agy ends the turn normally (`end_turn`) with a
 * notice as the agent's reply: `⚠ Individual quota reached. Please upgrade your
 * subscription to increase your limits. Resets in 3h20m5s.` Returns the notice when
 * `text` is exactly that notice; a model reply that only mentions a quota is not one.
 */
export function antigravityQuotaNotice(text: string): string | undefined {
  return ANTIGRAVITY_QUOTA_NOTICE.exec(text.trim())?.[1];
}

/** `Resets in 1d2h3m4s` as a time, if the notice says. */
export function antigravityQuotaResetsAt(notice: string, now: Date = new Date()): Date | undefined {
  const match = /\bresets\s+in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(notice);
  if (!match?.[1]) return undefined;
  const unitMs: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  let total = 0;
  for (const [, amount, unit] of match[1].matchAll(/(\d+)\s*([dhms])/gi)) {
    total += Number(amount) * (unitMs[unit!.toLowerCase()] ?? 0);
  }
  return total > 0 ? new Date(now.getTime() + total) : undefined;
}

/** Classified as quota exhausted; the item is retried once the quota resets. */
export class AntigravityQuotaError extends ClassifiedProviderError {
  constructor(notice: string, options?: ErrorOptions) {
    const resetsAt = antigravityQuotaResetsAt(notice);
    super(
      `Antigravity: ${notice}`,
      { reason: 'provider_quota_exhausted', retryClass: 'rate_limited', ...(resetsAt ? { resetsAt } : {}) },
      options,
    );
    this.name = 'AntigravityQuotaError';
  }
}

/** JSON-RPC's own request errors (parse, invalid request, unknown method, invalid params). */
const JSON_RPC_REQUEST_ERROR_CODES = new Set([-32700, -32600, -32601, -32602]);
const ANTIGRAVITY_RPC_QUOTA_NOTICE = new RegExp(`^(?:\\u26A0\\uFE0F?[^\\S\\n]*)?(${ANTIGRAVITY_QUOTA_SENTENCE})$`, 'u');

/**
 * An ACP error from agy, classified from its code and its own message. A malformed
 * request fails at once, an authentication error asks for sign-in, and agy's quota
 * notice waits for the reset. Anything else is classified from its own message
 * alone. `data` can quote other text (an earlier error, a template), so it stays in
 * the message for diagnostics but never decides how the failure is reported or
 * retried.
 */
export function antigravityRpcError(error: unknown): unknown {
  if (!(error instanceof AcpJsonRpcError)) return error;
  const code = numberField(error.error, 'code');
  const reason = stringField(error.error, 'message')?.trim() ?? '';
  const classified = (message: string, classification: ConstructorParameters<typeof ClassifiedProviderError>[1]) => {
    const mapped = new ClassifiedProviderError(message, classification, { cause: error });
    mapped.name = error.name;
    return mapped;
  };
  if (code !== undefined && JSON_RPC_REQUEST_ERROR_CODES.has(code)) {
    return classified(error.message, { reason: 'provider_error', retryClass: 'terminal' });
  }
  if (code === -32000 || /^authentication required\b/i.test(reason)) {
    return classified(
      'Antigravity CLI is not signed in on this machine. Run `agy` in a terminal once and sign in '
        + `(or \`agy acp --login\`), then retry. ${error.message}`,
      { reason: 'provider_auth_failed', retryClass: 'terminal' },
    );
  }
  const notice = ANTIGRAVITY_RPC_QUOTA_NOTICE.exec(reason)?.[1];
  if (notice) return new AntigravityQuotaError(notice, { cause: error });
  const actual = new Error(reason || 'Unknown JSON-RPC error');
  const retryClass = classifyProviderRetry(actual);
  const failureReason = providerFailureReasonFromError(actual);
  return classified(error.message, {
    // Sign-in is agy's own authentication error above; a message that only mentions it is not one.
    reason: failureReason === 'provider_auth_failed' ? 'provider_error' : failureReason,
    retryClass,
    ...(retryClass === 'rate_limited' ? { resetsAt: providerRateLimitResumeAt(actual, new Date()) } : {}),
  });
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
