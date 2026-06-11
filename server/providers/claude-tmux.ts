import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord, stringField } from "../json.js";
import { runtimeErrorPayload } from "../activities/format.js";
import { nowIso } from "../ids.js";
import { resolveAnimaHome } from "../anima-home.js";
import { ActiveRuntimeRun } from "./active-runtime.js";
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
} from "./contract.js";

const CLAUDE_COMMAND = "claude";
const CLAUDE_TMUX_DEFAULT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW),
};
const TMUX_REPLY_POLL_INTERVAL_MS = 250;
const TMUX_READY_POLL_INTERVAL_MS = 500;
const TMUX_READY_TIMEOUT_MS = 30_000;
const TMUX_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const TMUX_TRANSPORT_NAME = "tmux";

interface ClaudeTmuxReplyResult {
  text?: string;
}

interface TmuxSession {
  env: NodeJS.ProcessEnv;
  logFile: string;
  mcpConfigFile: string;
  name: string;
  startedAt: string;
  targetFile: string;
}

export class ClaudeCodeTmuxAgentRuntime implements AgentRuntime {
  readonly env: Record<string, string> | undefined;
  readonly kind = "claude-code";
  private readonly activeRun = new ActiveRuntimeRun();
  private readonly config: ClaudeCodeAgentProviderConfig;
  private readonly notificationTargetResolver?: AgentRuntimeNotificationTargetResolver;
  private session?: TmuxSession;

  constructor(
    config: ClaudeCodeAgentProviderConfig,
    options: {
      notificationTargetResolver?: AgentRuntimeNotificationTargetResolver;
    } = {},
  ) {
    this.config = config;
    this.notificationTargetResolver = options.notificationTargetResolver;
    this.env = {
      ...CLAUDE_TMUX_DEFAULT_ENV,
      ...(config.env ?? {}),
    };
  }

  async close(_options: AgentRuntimeCloseOptions = {}): Promise<void> {
    // Tmux transport intentionally leaves the interactive Claude Code session
    // alive so a runtime restart can reconnect to the same terminal.
  }

  health(): AgentRuntimeHealth {
    const session = this.session;
    if (!session) return { childExpected: this.activeRun.isActive() };
    const alive = tmuxSessionExists(session.name, session.env);
    return {
      childExpected: true,
      child: {
        alive,
        command: "tmux",
        exited: !alive,
        label: "Claude Code tmux runtime",
        startedAt: session.startedAt,
        stdinWritable: alive,
      },
    };
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const session = await this.ensureSession(input);
    await input.effects.recordRuntime("runtime.started", {
      command: "tmux",
      inputFormat: TMUX_TRANSPORT_NAME,
      providerSession: providerSessionPayload(input.providerSession, this.kind),
      tmuxSession: session.name,
      transport: TMUX_TRANSPORT_NAME,
    });
    await input.effects.persistProviderSession({
      id: session.name,
      updatedAt: nowIso(),
    });
    const finishRun = this.activeRun.start(
      input,
      "Claude Code tmux",
      () => undefined,
    );
    try {
      const result = await this.runTurn(input, session);
      if (result.text) {
        await input.effects.recordAgentText(result.text, {
          transport: TMUX_TRANSPORT_NAME,
        });
      }
      await input.effects.recordRuntime("runtime.completed");
      return result.text ? { text: result.text } : {};
    } catch (error) {
      if (!input.suppressFailureRecord) {
        await input.effects.recordRuntime(
          "runtime.failed",
          runtimeErrorPayload(error),
        );
      }
      throw error;
    } finally {
      finishRun();
    }
  }

  async appendToActiveRun(
    input: AgentRuntimeFollowupInput,
  ): Promise<AgentRuntimeFollowupResult> {
    if (!this.activeRun.accepts(input) || !this.session)
      return { accepted: false };
    await sendTmuxPrompt({
      env: this.session.env,
      prompt: tmuxSteeringPrompt(input),
      session: this.session.name,
      workDir: dirname(this.session.targetFile),
    });
    return {
      accepted: true,
      text: "sent steering update to Claude tmux session",
    };
  }

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    if (!this.activeRun.accepts(input)) return;
  }

  private async ensureSession(input: AgentRuntimeInput): Promise<TmuxSession> {
    assertTmuxAvailable(input.env);
    const agentId = input.env.ANIMA_AGENT_ID;
    if (!agentId)
      throw new Error(
        "ANIMA_AGENT_ID is required for Claude Code tmux runtime",
      );
    const sessionName = tmuxSessionName({
      agentId,
      effort: this.config.reasoningEffort,
      model: this.config.model,
    });
    const existing =
      this.session?.name === sessionName ? this.session : undefined;
    if (existing && tmuxSessionExists(existing.name, existing.env))
      return existing;

    const files = await writeTmuxFiles(input, sessionName);
    const command = shellCommand([
      CLAUDE_COMMAND,
      ...this.claudeArgs(files.mcpConfigFile),
    ]);
    if (!tmuxSessionExists(sessionName, input.env)) {
      tmux(["new-session", "-d", "-s", sessionName, "-c", input.cwd, command], {
        env: input.env,
      });
    }
    tmux(
      [
        "pipe-pane",
        "-o",
        "-t",
        sessionName,
        `cat >> ${shellQuote(files.logFile)}`,
      ],
      {
        allowFailure: true,
        env: input.env,
      },
    );
    this.session = {
      ...files,
      env: input.env,
      name: sessionName,
      startedAt: nowIso(),
    };
    return this.session;
  }

  private async runTurn(
    input: AgentRuntimeInput,
    session: TmuxSession,
  ): Promise<ClaudeTmuxReplyResult> {
    const replyTarget = await this.replyTarget(input);
    const replyFile = join(
      dirname(session.targetFile),
      `reply-${safeName(input.itemId)}.json`,
    );
    await writeTargetFile(session.targetFile, {
      itemId: input.itemId,
      replyFile,
      ...(replyTarget?.channel ? { channel: replyTarget.channel } : {}),
      ...(replyTarget?.threadTs ? { threadTs: replyTarget.threadTs } : {}),
    });
    await rm(replyFile, { force: true });
    await waitForTmuxReady(session, input);
    await sendTmuxPrompt({
      env: session.env,
      prompt: tmuxPrompt(input),
      session: session.name,
      workDir: dirname(session.targetFile),
    });
    return waitForReplyFile(replyFile, input);
  }

  private claudeArgs(mcpConfigFile: string): string[] {
    const args = [
      "--mcp-config",
      mcpConfigFile,
      "--strict-mcp-config",
      "--permission-mode",
      "bypassPermissions",
      `--disallowedTools=${CLAUDE_DISALLOWED_TOOLS.join(",")}`,
    ];
    if (this.config.model) args.push("--model", this.config.model);
    if (this.config.reasoningEffort)
      args.push("--effort", this.config.reasoningEffort);
    return args;
  }

  private async replyTarget(
    input: AgentRuntimeInput,
  ): Promise<AgentRuntimeNotificationTarget | undefined> {
    const agentId = input.env.ANIMA_AGENT_ID;
    if (!agentId || !this.notificationTargetResolver) return undefined;
    return this.notificationTargetResolver(agentId, input.itemId);
  }
}

async function writeTmuxFiles(
  input: AgentRuntimeInput,
  sessionName: string,
): Promise<{
  logFile: string;
  mcpConfigFile: string;
  targetFile: string;
}> {
  const agentId = input.env.ANIMA_AGENT_ID;
  if (!agentId)
    throw new Error("ANIMA_AGENT_ID is required for Claude Code tmux runtime");
  const animaHome = input.env.ANIMA_HOME || resolveAnimaHome();
  const root = join(
    animaHome,
    "run",
    "agents",
    agentId,
    "claude-tmux",
    sessionName,
  );
  const mcpConfigFile = join(root, "mcp.json");
  const targetFile = join(root, "target.json");
  const logFile = join(root, "terminal.ansi.log");
  const serverEntry = fileURLToPath(
    new URL("./claude-channel-mcp-server.js", import.meta.url),
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    mcpConfigFile,
    `${JSON.stringify(
      {
        mcpServers: {
          anima: {
            command: process.execPath,
            args: [
              serverEntry,
              "--agent-id",
              agentId,
              "--target-file",
              targetFile,
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { logFile, mcpConfigFile, targetFile };
}

async function writeTargetFile(
  path: string,
  target: {
    channel?: string;
    itemId: string;
    replyFile: string;
    threadTs?: string;
  },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(target, null, 2)}\n`, "utf8");
}

function tmuxPrompt(input: AgentRuntimeInput): string {
  return [
    "Anima delivered this team message to you.",
    `When you need to reply, call the MCP tool mcp__anima__reply with item_id ${JSON.stringify(input.itemId)} and your reply text.`,
    "Plain terminal output is not visible to the team. The team only sees messages sent through the reply tool.",
    "",
    input.prompt,
  ].join("\n");
}

function tmuxSteeringPrompt(input: AgentRuntimeFollowupInput): string {
  return [
    "Steering update from Anima for the active team-message turn.",
    "Use this update before sending the final reply through mcp__anima__reply.",
    "",
    input.prompt,
  ].join("\n");
}

async function sendTmuxPrompt(input: {
  env: NodeJS.ProcessEnv;
  prompt: string;
  session: string;
  workDir: string;
}): Promise<void> {
  await mkdir(input.workDir, { recursive: true });
  const id = safeName(`${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const promptFile = join(input.workDir, `prompt-${id}.txt`);
  const bufferName = `anima-${id}`;
  await writeFile(promptFile, input.prompt, "utf8");
  tmux(["load-buffer", "-b", bufferName, promptFile], { env: input.env });
  try {
    tmux(["paste-buffer", "-p", "-r", "-b", bufferName, "-t", input.session], {
      env: input.env,
    });
  } finally {
    tmux(["delete-buffer", "-b", bufferName], {
      allowFailure: true,
      env: input.env,
    });
  }
  tmux(["send-keys", "-t", input.session, "C-m"], { env: input.env });
}

async function waitForTmuxReady(
  session: TmuxSession,
  input: AgentRuntimeInput,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TMUX_READY_TIMEOUT_MS) {
    if (input.signal?.aborted) throw new Error("Claude Code tmux turn aborted");
    input.onActivity?.();
    const captured = tmux(
      ["capture-pane", "-p", "-J", "-S", "-120", "-t", session.name],
      {
        allowFailure: true,
        env: session.env,
      },
    );
    const text = stripAnsi(captured.stdout ?? "");
    if (
      /Quick safety check|Yes, I trust this folder|Enter to confirm/.test(text)
    ) {
      tmux(["send-keys", "-t", session.name, "C-m"], {
        allowFailure: true,
        env: session.env,
      });
      await sleep(2_500);
      continue;
    }
    if (/bypass permissions on|accept edits on|plan mode on|>\s*$/.test(text))
      return;
    await sleep(TMUX_READY_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Claude Code tmux session ${session.name} was not ready for input`,
  );
}

async function waitForReplyFile(
  path: string,
  input: AgentRuntimeInput,
): Promise<ClaudeTmuxReplyResult> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TMUX_TURN_TIMEOUT_MS) {
    if (input.signal?.aborted) throw new Error("Claude Code tmux turn aborted");
    input.onActivity?.();
    const parsed = await readReplyFile(path).catch(() => undefined);
    if (parsed) return parsed;
    await sleep(TMUX_REPLY_POLL_INTERVAL_MS);
  }
  throw new Error("Claude Code tmux turn timed out before sending a reply");
}

async function readReplyFile(
  path: string,
): Promise<ClaudeTmuxReplyResult | undefined> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) return undefined;
  return { text: stringField(value, "text") };
}

function assertTmuxAvailable(env: NodeJS.ProcessEnv): void {
  const result = spawnSync("tmux", ["-V"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0)
    throw new Error("tmux is required for Claude Code Tmux session transport");
}

function tmux(
  args: string[],
  options: {
    allowFailure?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): { status: number | null; stdout?: string; stderr?: string } {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (options.allowFailure) {
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `tmux ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim(),
    );
  }
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function tmuxSessionExists(session: string, env?: NodeJS.ProcessEnv): boolean {
  const result = tmux(["has-session", "-t", session], {
    allowFailure: true,
    env,
  });
  return result.status === 0;
}

function tmuxSessionName(input: {
  agentId: string;
  effort?: string;
  model?: string;
}): string {
  return `anima-${safeName(input.agentId)}-${safeName(input.model ?? "default")}-${safeName(input.effort ?? "default")}`;
}

function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default"
  );
}

function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
