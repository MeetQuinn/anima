import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord, stringField } from '../json.js';
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
  type AgentRuntimeResult,
  type ClaudeCodeAgentProviderConfig,
  providerSessionPayload,
} from './contract.js';

const CLAUDE_COMMAND = 'claude';
const CHANNEL_COMPLETION_POLL_INTERVAL_MS = 100;
const CHANNEL_PLUGIN_NAME = 'anima-channel';
const CLAUDE_CHANNEL_DEFAULT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW),
};

interface ClaudeChannelCompletionResult {
  text?: string;
}

export class ClaudeCodeChannelAgentRuntime implements AgentRuntime {
  readonly env: Record<string, string> | undefined;
  readonly kind = 'claude-code';
  private readonly activeRun = new ActiveRuntimeRun();
  private controller?: ClaudeChannelController;
  private readonly config: ClaudeCodeAgentProviderConfig;

  constructor(config: ClaudeCodeAgentProviderConfig) {
    this.config = config;
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
      finishRun();
    }
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<AgentRuntimeFollowupResult> {
    if (!this.activeRun.accepts(input)) return { accepted: false };
    return { accepted: false };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    if (!this.activeRun.accepts(input)) return;
  }

  private async runTurn(input: AgentRuntimeInput): Promise<ClaudeChannelCompletionResult> {
    const controller = await this.startController(input);
    controller.setCurrentInput(input);
    try {
      return await controller.waitForCompletion(input.signal);
    } finally {
      controller.clearCurrentInput(input);
      if (this.controller === controller) this.controller = undefined;
      await terminateChildProcess(controller, { forceAfterMs: 5_000 });
    }
  }

  private async startController(input: AgentRuntimeInput): Promise<ClaudeChannelController> {
    const systemPromptFilePath = await writeSystemPromptFile(input);
    const channelFiles = await writeChannelFiles(input);
    await rm(channelFiles.completionFile, { force: true });
    let controller!: ClaudeChannelController;
    const launch = claudePtyLaunch(this.claudeArgs(
      channelFiles.mcpConfigFile,
      systemPromptFilePath,
      channelPrompt(input),
    ));
    controller = new ClaudeChannelController({
      child: startChildProcess({
        args: launch.args,
        bufferOutput: true,
        command: launch.command,
        cwd: input.cwd,
        env: {
          ...input.env,
        },
        label: 'Claude Code channel runtime',
        onStderrChunk: (chunk) => controller.acceptOutput('stderr', chunk),
        onStdoutChunk: (chunk) => controller.acceptOutput('stdout', chunk),
        signal: input.signal,
        stdin: 'ignore',
      }),
      completionFile: channelFiles.completionFile,
    });
    this.controller = controller;
    watchProviderCompletion(controller.completion, () => {
      if (this.controller === controller) this.controller = undefined;
    });
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

  private claudeArgs(
    mcpConfigFile: string,
    systemPromptFilePath: string | undefined,
    prompt: string,
  ): string[] {
    const args = [
      '--mcp-config', mcpConfigFile,
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
      `--disallowedTools=${CLAUDE_DISALLOWED_TOOLS.join(',')}`,
    ];
    if (this.config.model) args.push('--model', this.config.model);
    if (this.config.reasoningEffort) args.push('--effort', this.config.reasoningEffort);
    if (systemPromptFilePath) args.push('--system-prompt-file', systemPromptFilePath);
    args.push(prompt);
    return args;
  }
}

class ClaudeChannelController {
  private currentInput?: AgentRuntimeInput;

  constructor(private readonly input: { child: RunningChildProcess; completionFile: string }) {}

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

  async acceptOutput(_stream: 'stderr' | 'stdout', _chunk: string): Promise<void> {
    const input = this.currentInput;
    if (!input) return;
    input.onActivity?.();
  }

  async waitForCompletion(signal: AbortSignal | undefined): Promise<ClaudeChannelCompletionResult> {
    for (;;) {
      if (signal?.aborted) throw new Error('Claude Code channel turn aborted');
      const parsed = await readCompletionFile(this.input.completionFile).catch(() => undefined);
      if (parsed) return parsed;
      await Promise.race([
        sleep(CHANNEL_COMPLETION_POLL_INTERVAL_MS),
        this.input.child.completion.then(
          async () => {
            const settledCompletion = await readCompletionFile(this.input.completionFile).catch(() => undefined);
            if (settledCompletion) return;
            throw new Error('Claude Code channel runtime exited before completing the turn');
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
    }
  }
}

async function writeSystemPromptFile(input: AgentRuntimeInput): Promise<string | undefined> {
  if (!input.systemPrompt || !input.systemPromptFilePath) return undefined;
  await mkdir(dirname(input.systemPromptFilePath), { recursive: true });
  await writeFile(input.systemPromptFilePath, input.systemPrompt, 'utf8');
  return input.systemPromptFilePath;
}

async function writeChannelFiles(
  input: AgentRuntimeInput,
): Promise<{
  mcpConfigFile: string;
  completionFile: string;
}> {
  const agentId = input.env.ANIMA_AGENT_ID;
  if (!agentId) throw new Error('ANIMA_AGENT_ID is required for Claude Code channel runtime');
  const animaHome = input.env.ANIMA_HOME || resolveAnimaHome();
  const root = join(animaHome, 'run', 'agents', agentId, CHANNEL_PLUGIN_NAME);
  const mcpConfigFile = join(root, 'mcp.json');
  const completionFile = join(root, 'completion.json');
  const serverEntry = fileURLToPath(new URL('./claude-channel-mcp-server.js', import.meta.url));
  const serverArgs = [
    serverEntry,
    '--agent-id', agentId,
    '--item-id', input.itemId,
    '--completion-file', completionFile,
  ];
  await mkdir(root, { recursive: true });
  await writeFile(
    mcpConfigFile,
    `${JSON.stringify({
      mcpServers: {
        anima: {
          command: process.execPath,
          args: serverArgs,
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );
  return { mcpConfigFile, completionFile };
}

async function readCompletionFile(path: string): Promise<ClaudeChannelCompletionResult | undefined> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(value)) return undefined;
  return { text: stringField(value, 'text') };
}

function channelPrompt(input: AgentRuntimeInput): string {
  return [
    'Anima delivered this team message to you.',
    channelCompletionInstructions(input),
    'Plain terminal output is not visible to the team. The team only sees messages sent through Anima tools.',
    '',
    input.prompt,
  ].join('\n');
}

function channelCompletionInstructions(input: AgentRuntimeInput): string {
  return [
    'Use the normal Anima CLI/tools from the standing prompt for any needed team action, including replies.',
    `When this turn is finished, call the MCP tool mcp__anima__complete with item_id ${JSON.stringify(input.itemId)}.`,
    'If you already sent the needed team message through Anima CLI, call complete without text. For a no-op or targetless turn, include a short completion note.',
  ].join(' ');
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
