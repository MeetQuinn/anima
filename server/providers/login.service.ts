import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import { PROVIDER_CATALOG } from '../../shared/provider-catalog.js';
import {
  providerLoginSpec,
  type ProviderLoginMode,
  type ProviderLoginOperation,
  type ProviderLoginRow,
  type ProviderLoginStatusResponse,
} from '../../shared/provider-login.js';
import {
  effectiveProviderRuntimeCommand,
  type ProviderRuntimeCommandsConfig,
} from '../../shared/provider-runtime-commands.js';
import type { ProviderUsageKind } from '../../shared/provider-usage.js';
import { resolveProviderExecutable } from '../provider-cli/provider-inspection.js';
import type { ProviderCliCommandRunner } from '../provider-cli/types.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { startChildProcess, type RunningChildProcess } from './child-process.js';
import { LineBuffer } from './line-buffer.js';

const STATUS_TIMEOUT_MS = 10_000;
const STATUS_CACHE_MS = 15_000;
// Grace past the provider's own expiry so the CLI can report the expiry itself.
const EXPIRY_GRACE_MS = 30_000;
const IDLE: ProviderLoginOperation = { status: 'idle' };
const execFileAsync = promisify(execFile);

async function runStatusCommand(
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ stderr: string; stdout: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    env: options?.env,
    maxBuffer: 1024 * 1024,
    timeout: options?.timeout,
  });
  return { stderr: String(stderr), stdout: String(stdout) };
}

interface ProviderLoginSettings {
  getProviderRuntimeCommands(): Promise<ProviderRuntimeCommandsConfig>;
}

interface ProviderLoginServiceOptions {
  env?: NodeJS.ProcessEnv;
  runCommand?: ProviderCliCommandRunner;
  settings?: ProviderLoginSettings;
  spawn?: typeof startChildProcess;
}

interface LoginStatusCheck {
  checkedAt: string;
  detail?: string;
  state: 'signed_in' | 'signed_out' | 'unknown';
}

interface ActiveLogin {
  cancel: () => void;
  provider: ProviderUsageKind;
}

export class ProviderLoginError extends Error {
  constructor(
    readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderLoginError';
  }
}

/**
 * Reads the sign-in URL and one-time code out of a provider login transcript.
 * Both login commands print the link on its own line; device auth prints the
 * code on its own line as upper-case groups joined by dashes. Terminal color
 * codes are stripped first so a colored line still matches. The local callback
 * address the browser flow announces is not a sign-in link.
 */
export function parseProviderLoginOutput(lines: readonly string[]): { code?: string; url?: string } {
  let url: string | undefined;
  let code: string | undefined;
  for (const raw of lines) {
    const line = stripAnsi(raw).trim();
    if (!url) {
      const match = /https?:\/\/\S+/.exec(line);
      if (match && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(match[0])) {
        url = match[0].replace(/[.,)]+$/, '');
        continue;
      }
    }
    if (!code && /^[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+$/.test(line)) code = line;
  }
  return { ...(code ? { code } : {}), ...(url ? { url } : {}) };
}

export function stripAnsi(text: string): string {
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function redactHome(text: string): string {
  const home = homedir();
  return home ? text.split(home).join('~') : text;
}

function lastMeaningfulLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  return last ? redactHome(last).slice(0, 300) : undefined;
}

export class ProviderLoginService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand: ProviderCliCommandRunner;
  private readonly settings: ProviderLoginSettings;
  private readonly spawn: typeof startChildProcess;
  private readonly operations = new Map<ProviderUsageKind, ProviderLoginOperation>();
  private readonly statusCache = new Map<ProviderUsageKind, LoginStatusCheck>();
  private active?: ActiveLogin;

  constructor(options: ProviderLoginServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.runCommand = options.runCommand ?? runStatusCommand;
    this.settings = options.settings ?? defaultServerSettingsService;
    this.spawn = options.spawn ?? startChildProcess;
  }

  async status(options: { force?: boolean } = {}): Promise<ProviderLoginStatusResponse> {
    const commands = await this.settings.getProviderRuntimeCommands();
    const providers = await Promise.all(
      PROVIDER_CATALOG.map((entry) => this.row(entry.kind, commands, options.force ?? false)),
    );
    return { providers };
  }

  // One sign-in at a time across providers: the browser flow binds a fixed
  // local callback port, and two prompts on one screen are a footgun anyway.
  async start(provider: ProviderUsageKind, mode: ProviderLoginMode): Promise<ProviderLoginStatusResponse> {
    const spec = providerLoginSpec(provider);
    if (!spec) throw new ProviderLoginError(404, `Dashboard sign-in is not available for ${provider}`);
    if (this.active) {
      throw new ProviderLoginError(
        409,
        `A ${this.active.provider} sign-in is already running; cancel it or wait for it to finish`,
      );
    }
    // Reserve the singleton synchronously, before the first await: two
    // concurrent starts would otherwise both pass the check above and both
    // spawn. The reservation's cancel becomes real once the child exists.
    const reservation: ActiveLogin = { cancel: () => {}, provider };
    this.active = reservation;
    let executable;
    try {
      const commands = await this.settings.getProviderRuntimeCommands();
      const command = effectiveProviderRuntimeCommand(provider, commands);
      executable = await resolveProviderExecutable(command, this.env);
      if (!executable) {
        throw new ProviderLoginError(409, `Runtime command was not found or is not executable: ${command}`);
      }
    } catch (error) {
      this.active = undefined;
      throw error;
    }

    const startedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(startedAt) + spec.expiresAfterMinutes * 60_000).toISOString();
    const lineBuffer = new LineBuffer();
    const lines: string[] = [];
    let running: ProviderLoginOperation = { expiresAt, mode, startedAt, status: 'running' };
    this.operations.set(provider, running);
    const absorb = async (chunk: string): Promise<void> => {
      lines.push(...lineBuffer.accept(chunk));
      if (this.operations.get(provider)?.status !== 'running') return;
      running = { ...running, ...parseProviderLoginOutput(lines) };
      this.operations.set(provider, running);
    };
    let cancelled = false;
    let expired = false;
    const child: RunningChildProcess = this.spawn({
      args: mode === 'device' ? spec.deviceArgs : spec.browserArgs,
      command: executable.path,
      env: this.env,
      label: `${provider} login`,
      onStderrChunk: absorb,
      onStdoutChunk: absorb,
      stdin: 'ignore',
    });
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGTERM');
    }, spec.expiresAfterMinutes * 60_000 + EXPIRY_GRACE_MS);
    reservation.cancel = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    const finish = (patch: Partial<ProviderLoginOperation> & Pick<ProviderLoginOperation, 'status'>): void => {
      clearTimeout(timer);
      this.active = undefined;
      this.statusCache.delete(provider);
      this.operations.set(provider, { ...running, completedAt: new Date().toISOString(), ...patch });
    };
    void child.completion.then(
      () => finish({ status: 'succeeded' }),
      (error: unknown) => {
        if (cancelled) return finish({ status: 'cancelled' });
        if (expired) {
          return finish({ error: 'The sign-in link expired before it was completed', status: 'failed' });
        }
        const detail =
          lastMeaningfulLine(lines.filter((line) => !/https?:\/\//.test(line)).join('\n')) ??
          (error instanceof Error ? redactHome(error.message) : 'Sign-in did not complete');
        finish({ error: detail, status: 'failed' });
      },
    );
    return this.status();
  }

  async cancel(provider: ProviderUsageKind): Promise<ProviderLoginStatusResponse> {
    if (!this.active || this.active.provider !== provider) {
      throw new ProviderLoginError(409, `No ${provider} sign-in is running`);
    }
    this.active.cancel();
    return this.status();
  }

  private async row(
    provider: ProviderUsageKind,
    commands: ProviderRuntimeCommandsConfig,
    force: boolean,
  ): Promise<ProviderLoginRow> {
    const command = effectiveProviderRuntimeCommand(provider, commands);
    const operation = this.operations.get(provider) ?? IDLE;
    const spec = providerLoginSpec(provider);
    if (!spec) return { command, operation, provider, state: 'unsupported' };
    const check = await this.check(provider, command, spec.statusArgs, force);
    return {
      checkedAt: check.checkedAt,
      command,
      ...(check.detail ? { detail: check.detail } : {}),
      operation,
      provider,
      state: check.state,
    };
  }

  private async check(
    provider: ProviderUsageKind,
    command: string,
    args: string[],
    force: boolean,
  ): Promise<LoginStatusCheck> {
    const cached = this.statusCache.get(provider);
    if (cached && !force && Date.now() - Date.parse(cached.checkedAt) < STATUS_CACHE_MS) return cached;
    const checkedAt = new Date().toISOString();
    const executable = await resolveProviderExecutable(command, this.env);
    let result: LoginStatusCheck;
    if (!executable) {
      result = { checkedAt, detail: `Runtime command was not found: ${redactHome(command)}`, state: 'unknown' };
    } else {
      try {
        const { stdout, stderr } = await this.runCommand(executable.path, args, {
          env: this.env,
          timeout: STATUS_TIMEOUT_MS,
        });
        const detail = lastMeaningfulLine(stdout) ?? lastMeaningfulLine(stderr);
        result = { checkedAt, ...(detail ? { detail } : {}), state: 'signed_in' };
      } catch (error: unknown) {
        const failure = error as { code?: unknown; killed?: boolean; stderr?: string; stdout?: string };
        const detail =
          lastMeaningfulLine(failure.stdout) ??
          lastMeaningfulLine(failure.stderr) ??
          (error instanceof Error ? redactHome(error.message) : undefined);
        // Login status commands exit non-zero when signed out. A spawn failure
        // or timeout carries no numeric exit code and is reported as unknown.
        const exited = typeof failure.code === 'number' && !failure.killed;
        result = { checkedAt, ...(detail ? { detail } : {}), state: exited ? 'signed_out' : 'unknown' };
      }
    }
    this.statusCache.set(provider, result);
    return result;
  }
}

export const defaultProviderLoginService = new ProviderLoginService();
