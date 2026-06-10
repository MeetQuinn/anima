import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord, numberField, stringField } from '../json.js';
import { runtimeErrorPayload } from '../activities/format.js';
import { resolveAnimaHome } from '../anima-home.js';
import { ActiveRuntimeRun } from './active-runtime.js';
import { startChildProcess, terminateChildProcess, type RunningChildProcess } from './child-process.js';
import { watchProviderCompletion } from './completion-watch.js';
import {
  CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW,
  CLAUDE_DISALLOWED_TOOLS,
  type AgentRuntime,
  type AgentRuntimeCloseOptions,
  type AgentRuntimeDrainInput,
  type AgentRuntimeFollowupInput,
  type AgentRuntimeFollowupResult,
  type AgentRuntimeHealth,
  type AgentRuntimeInput,
  type AgentRuntimeNotificationTarget,
  type AgentRuntimeNotificationTargetResolver,
  type AgentRuntimeResult,
  type ClaudeCodeAgentProviderConfig,
  providerSessionPayload,
} from './contract.js';

const CLAUDE_COMMAND = 'claude';
const CHANNEL_READY_TIMEOUT_MS = 15_000;
const CHANNEL_PLUGIN_NAME = 'anima-channel';
const CLAUDE_CHANNEL_DEFAULT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW),
};

interface ClaudeChannelServerInfo {
  host: string;
  port: number;
}

interface ClaudeChannelNotifyResult {
  text?: string;
}

export class ClaudeCodeChannelAgentRuntime implements AgentRuntime {
  readonly env: Record<string, string> | undefined;
  readonly kind = 'claude-code';
  private readonly activeRun = new ActiveRuntimeRun();
  private activeAgentId?: string;
  private controller?: ClaudeChannelController;
  private readonly config: ClaudeCodeAgentProviderConfig;
  private readonly notificationTargetResolver?: AgentRuntimeNotificationTargetResolver;

  constructor(
    config: ClaudeCodeAgentProviderConfig,
    options: { notificationTargetResolver?: AgentRuntimeNotificationTargetResolver } = {},
  ) {
    this.config = config;
    this.notificationTargetResolver = options.notificationTargetResolver;
    this.env = {
      ...CLAUDE_CHANNEL_DEFAULT_ENV,
      ...(config.env ?? {}),
    };
  }

  async close(options: AgentRuntimeCloseOptions = {}): Promise<void> {
    await this.resetController(options.signal, options);
  }

  health(): AgentRuntimeHealth {
    return {
      ...(this.controller ? { child: this.controller.snapshot() } : {}),
      childExpected: Boolean(this.controller) || this.activeRun.isActive(),
    };
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    await input.effects.recordRuntime('runtime.started', {
      command: CLAUDE_COMMAND,
      inputFormat: 'channel',
      providerSession: providerSessionPayload(input.providerSession, this.kind),
      pty: 'script',
      transport: 'channel',
    });
    this.activeAgentId = input.env.ANIMA_AGENT_ID;
    const finishRun = this.activeRun.start(input, 'Claude Code channel', (signal) => void this.resetController(signal));
    try {
      const result = await this.runTurn(input);
      if (result.text) {
        await input.effects.recordAgentText(result.text, { transport: 'channel' });
      }
      await input.effects.recordRuntime('runtime.completed');
      return result.text ? { text: result.text } : {};
    } catch (error) {
      if (!input.suppressFailureRecord) {
        await input.effects.recordRuntime('runtime.failed', runtimeErrorPayload(error));
      }
      throw error;
    } finally {
      if (this.activeAgentId === input.env.ANIMA_AGENT_ID) this.activeAgentId = undefined;
      finishRun();
    }
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    if (!this.activeRun.accepts(input)) return { accepted: false };
    const controller = this.controller;
    if (!controller) return { accepted: false };
    const agentId = this.activeAgentId;
    void controller.notify({
      itemId: input.itemId,
      prompt: input.prompt,
      ...(agentId ? { target: await this.notificationTargetForAgentItem(agentId, input.itemId) } : {}),
    }).catch((error: unknown) => {
      process.stderr.write(`[anima-channel] follow-up notification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    return { accepted: true, text: 'sent to Claude Code channel' };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    if (!this.activeRun.accepts(input)) return;
  }

  private async runTurn(input: AgentRuntimeInput): Promise<ClaudeChannelNotifyResult> {
    const controller = await this.ensureController(input);
    controller.setCurrentInput(input);
    try {
      return await controller.notify({
        itemId: input.itemId,
        prompt: input.prompt,
        signal: input.signal,
        target: await this.notificationTargetForRuntimeInput(input),
      });
    } finally {
      controller.clearCurrentInput(input);
    }
  }

  private async ensureController(input: AgentRuntimeInput): Promise<ClaudeChannelController> {
    if (this.controller) return this.controller;
    const systemPromptFilePath = await writeSystemPromptFile(input);
    const plugin = await writeChannelPlugin(input);
    await rm(plugin.stateFile, { force: true });
    let controller!: ClaudeChannelController;
    const launch = claudePtyLaunch(this.claudeArgs(plugin.root, systemPromptFilePath));
    controller = new ClaudeChannelController({
      child: startChildProcess({
        args: launch.args,
        bufferOutput: true,
        command: launch.command,
        cwd: input.cwd,
        env: {
          ...input.env,
          ANIMA_CLAUDE_CHANNEL_STATE_FILE: plugin.stateFile,
        },
        label: 'Claude Code channel runtime',
        onStderrChunk: (chunk) => controller.acceptOutput('stderr', chunk),
        onStdoutChunk: (chunk) => controller.acceptOutput('stdout', chunk),
        stdin: 'ignore',
      }),
      stateFile: plugin.stateFile,
    });
    this.controller = controller;
    watchProviderCompletion(controller.completion, () => {
      if (this.controller === controller) this.controller = undefined;
    });
    await controller.ready();
    return controller;
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

  private claudeArgs(pluginRoot: string, systemPromptFilePath: string | undefined): string[] {
    const args = [
      '--plugin-dir', pluginRoot,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', CLAUDE_DISALLOWED_TOOLS.join(','),
    ];
    if (this.config.model) args.push('--model', this.config.model);
    if (this.config.reasoningEffort) args.push('--effort', this.config.reasoningEffort);
    if (systemPromptFilePath) args.push('--system-prompt-file', systemPromptFilePath);
    return args;
  }

  private async notificationTargetForRuntimeInput(
    input: AgentRuntimeInput,
  ): Promise<AgentRuntimeNotificationTarget | undefined> {
    const agentId = input.env.ANIMA_AGENT_ID;
    if (!agentId) return undefined;
    return this.notificationTargetForAgentItem(agentId, input.itemId);
  }

  private async notificationTargetForAgentItem(
    agentId: string,
    itemId: string,
  ): Promise<AgentRuntimeNotificationTarget | undefined> {
    return this.notificationTargetResolver?.(agentId, itemId);
  }
}

class ClaudeChannelController {
  private currentInput?: AgentRuntimeInput;
  private serverInfo?: ClaudeChannelServerInfo;

  constructor(private readonly input: { child: RunningChildProcess; stateFile: string }) {}

  get completion(): Promise<{ stdout: string; stderr: string }> {
    return this.input.child.completion;
  }

  kill(signal?: NodeJS.Signals): void {
    this.input.child.kill(signal);
  }

  snapshot() {
    return this.input.child.snapshot();
  }

  setCurrentInput(input: AgentRuntimeInput): void {
    this.currentInput = input;
  }

  clearCurrentInput(input: AgentRuntimeInput): void {
    if (this.currentInput === input) this.currentInput = undefined;
  }

  async acceptOutput(stream: 'stderr' | 'stdout', chunk: string): Promise<void> {
    const input = this.currentInput;
    if (!input) return;
    input.onActivity?.();
    await input.effects.recordOutput(stream, chunk);
  }

  async ready(): Promise<ClaudeChannelServerInfo> {
    if (this.serverInfo) return this.serverInfo;
    const deadline = Date.now() + CHANNEL_READY_TIMEOUT_MS;
    for (;;) {
      const parsed = await readChannelStateFile(this.input.stateFile).catch(() => undefined);
      if (parsed) {
        this.serverInfo = parsed;
        return parsed;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Claude Code channel server did not become ready within ${CHANNEL_READY_TIMEOUT_MS}ms`);
      }
      await Promise.race([
        sleep(100),
        this.input.child.completion.then(
          () => {
            throw new Error('Claude Code channel runtime exited before channel server became ready');
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
    }
  }

  async notify(input: {
    itemId: string;
    prompt: string;
    signal?: AbortSignal;
    target?: AgentRuntimeNotificationTarget;
  }): Promise<ClaudeChannelNotifyResult> {
    const server = await this.ready();
    const response = await fetch(`http://${server.host}:${server.port}/notify`, {
      body: JSON.stringify({
        itemId: input.itemId,
        prompt: input.prompt,
        ...(input.target?.channel ? { channel: input.target.channel } : {}),
        ...(input.target?.platform ? { platform: input.target.platform } : {}),
        ...(input.target?.threadTs ? { threadTs: input.target.threadTs } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: input.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Claude Code channel notification failed (${response.status}): ${body.trim()}`);
    }
    const parsed: unknown = body ? JSON.parse(body) : {};
    return isRecord(parsed) ? { text: stringField(parsed, 'text') } : {};
  }
}

async function writeSystemPromptFile(input: AgentRuntimeInput): Promise<string | undefined> {
  if (!input.systemPrompt || !input.systemPromptFilePath) return undefined;
  await mkdir(dirname(input.systemPromptFilePath), { recursive: true });
  await writeFile(input.systemPromptFilePath, input.systemPrompt, 'utf8');
  return input.systemPromptFilePath;
}

async function writeChannelPlugin(input: AgentRuntimeInput): Promise<{ root: string; stateFile: string }> {
  const agentId = input.env.ANIMA_AGENT_ID;
  if (!agentId) throw new Error('ANIMA_AGENT_ID is required for Claude Code channel runtime');
  const animaHome = input.env.ANIMA_HOME || resolveAnimaHome();
  const root = join(animaHome, 'run', 'agents', agentId, CHANNEL_PLUGIN_NAME);
  const stateFile = join(animaHome, 'run', 'agents', agentId, `${CHANNEL_PLUGIN_NAME}.json`);
  const serverEntry = fileURLToPath(new URL('./claude-channel-mcp-server.js', import.meta.url));
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(root, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({
      name: CHANNEL_PLUGIN_NAME,
      version: '0.1.0',
      description: 'Anima channel adapter for Claude Code.',
      keywords: ['anima', 'channel', 'mcp'],
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(root, '.mcp.json'),
    `${JSON.stringify({
      mcpServers: {
        anima: {
          command: process.execPath,
          args: [serverEntry],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );
  return { root, stateFile };
}

async function readChannelStateFile(path: string): Promise<ClaudeChannelServerInfo | undefined> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(value)) return undefined;
  const port = numberField(value, 'port');
  const host = stringField(value, 'host') ?? '127.0.0.1';
  if (!port) return undefined;
  return { host, port };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function claudePtyLaunch(claudeArgs: string[]): { args: string[]; command: string } {
  if (process.platform === 'darwin') {
    return {
      command: 'script',
      args: ['-q', '/dev/null', CLAUDE_COMMAND, ...claudeArgs],
    };
  }
  return {
    command: 'script',
    args: ['-q', '-c', shellCommand([CLAUDE_COMMAND, ...claudeArgs]), '/dev/null'],
  };
}

function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
