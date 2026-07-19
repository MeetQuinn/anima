import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentConfig } from '../../shared/agent-config.js';
import type {
  ClaudeAccountLoginOperation,
  ClaudeAccountLoginStartRequest,
  ClaudeCodeAccountConfig,
  ClaudeCodeAccountRegistry,
  ProviderAccountsConfig,
} from '../../shared/provider-accounts.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { startChildProcess, terminateChildProcess, type RunningChildProcess } from '../providers/child-process.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import {
  CLAUDE_CONFIG_DIR_KEY,
  claudeAccountIsConfigured,
  discoverClaudeAccounts,
  effectiveClaudeAccountRegistry,
  normalizedConfigDir,
  readClaudeAccountName,
} from './claude-account-config.js';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const TERMINAL_OPERATION_RETENTION_MS = 10 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const LOGIN_PROFILE_MARKER = '.anima-login-profile';
const LOGIN_ENV_KEYS = [
  'ALL_PROXY',
  'APPDATA',
  'ComSpec',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

type StartChild = typeof startChildProcess;

interface ProviderAccountSettings {
  getProviderAccounts(): Promise<ProviderAccountsConfig>;
}

interface ProviderAccountAgents {
  listAgentConfigs(): Promise<AgentConfig[]>;
}

interface LoginTarget {
  account: ClaudeCodeAccountConfig;
  isNew: boolean;
  markerPath?: string;
}

interface LoginOperationRecord extends ClaudeAccountLoginOperation {
  child?: RunningChildProcess;
  output: string;
  target: LoginTarget;
  timeout?: NodeJS.Timeout;
}

export interface ClaudeAccountLoginServiceOptions {
  accountConfigured?: typeof claudeAccountIsConfigured;
  agents?: ProviderAccountAgents;
  createId?: () => string;
  discoverAccounts?: typeof discoverClaudeAccounts;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  profilesRoot?: string;
  readAccountName?: typeof readClaudeAccountName;
  settings?: ProviderAccountSettings;
  startChild?: StartChild;
}

export class ClaudeAccountLoginError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'ClaudeAccountLoginError';
  }
}

export class ClaudeAccountLoginService {
  private readonly accountConfigured: typeof claudeAccountIsConfigured;
  private readonly agents: ProviderAccountAgents;
  private readonly createId: () => string;
  private readonly discoverAccounts: typeof discoverClaudeAccounts;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly operations = new Map<string, LoginOperationRecord>();
  private readonly profilesRoot: string;
  private readonly readAccountName: typeof readClaudeAccountName;
  private readonly settings: ProviderAccountSettings;
  private readonly startChild: StartChild;
  private activeOperationId?: string;
  private startPending = false;

  constructor(options: ClaudeAccountLoginServiceOptions = {}) {
    this.accountConfigured = options.accountConfigured ?? claudeAccountIsConfigured;
    this.agents = options.agents ?? defaultAgentRegistryService;
    this.createId = options.createId ?? randomUUID;
    this.discoverAccounts = options.discoverAccounts ?? discoverClaudeAccounts;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.profilesRoot = options.profilesRoot ?? join(homedir(), '.claude-profiles');
    this.readAccountName = options.readAccountName ?? readClaudeAccountName;
    this.settings = options.settings ?? defaultServerSettingsService;
    this.startChild = options.startChild ?? startChildProcess;
  }

  async start(input: ClaudeAccountLoginStartRequest): Promise<ClaudeAccountLoginOperation> {
    this.pruneOperations();
    const active = this.activeOperationId ? this.operations.get(this.activeOperationId) : undefined;
    if (this.startPending || active) {
      throw new ClaudeAccountLoginError(409, 'A Claude sign-in is already in progress');
    }
    this.startPending = true;

    try {
      const target = input.accountId
        ? await this.existingTarget(input.accountId)
        : await this.allocateTarget();
      const createdAt = this.now().toISOString();
      const operation: LoginOperationRecord = {
        ...(input.accountId ? { accountId: input.accountId } : {}),
        createdAt,
        id: this.createId(),
        output: '',
        status: 'starting',
        target,
        updatedAt: createdAt,
      };
      this.operations.set(operation.id, operation);
      this.activeOperationId = operation.id;

      const env: NodeJS.ProcessEnv = {
        ...loginEnvironment(this.env),
        DISABLE_AUTOUPDATER: '1',
        NO_COLOR: '1',
      };
      delete env[CLAUDE_CONFIG_DIR_KEY];
      if (target.account.configDir) env[CLAUDE_CONFIG_DIR_KEY] = target.account.configDir;
      const args = ['auth', 'login', '--claudeai'];
      if (input.email) args.push('--email', input.email);
      try {
        operation.child = this.startChild({
          args,
          bufferOutput: false,
          command: 'claude',
          env,
          label: 'Claude account sign-in',
          onStderrChunk: async (chunk) => this.handleOutput(operation, chunk),
          onStdoutChunk: async (chunk) => this.handleOutput(operation, chunk),
          stdin: 'pipe',
        });
      } catch {
        this.fail(operation, 'Claude sign-in could not start. Check that Claude Code is installed.');
        this.release(operation);
        return publicOperation(operation);
      }
      operation.timeout = setTimeout(() => {
        if (terminalStatus(operation.status)) return;
        this.fail(operation, 'Claude sign-in timed out. Try again.');
        void this.stopAndRelease(operation).catch(() => undefined);
      }, LOGIN_TIMEOUT_MS);
      operation.timeout.unref?.();
      void this.finish(operation);
      return publicOperation(operation);
    } finally {
      this.startPending = false;
    }
  }

  get(operationId: string): ClaudeAccountLoginOperation {
    this.pruneOperations();
    const operation = this.operations.get(operationId);
    if (!operation) throw new ClaudeAccountLoginError(404, 'Claude sign-in operation not found');
    return publicOperation(operation);
  }

  submitCode(operationId: string, code: string): ClaudeAccountLoginOperation {
    const operation = this.requireActive(operationId);
    if (!operation.child) throw new ClaudeAccountLoginError(409, 'Claude sign-in is not ready for a code');
    try {
      operation.child.writeStdin(`${code.trim()}\n`);
    } catch {
      this.fail(operation, 'Claude sign-in is no longer waiting for a code. Try again.');
      void this.stopAndRelease(operation).catch(() => undefined);
      throw new ClaudeAccountLoginError(409, operation.error ?? 'Claude sign-in is no longer active');
    }
    this.touch(operation, 'verifying');
    return publicOperation(operation);
  }

  async cancel(operationId: string): Promise<ClaudeAccountLoginOperation> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new ClaudeAccountLoginError(404, 'Claude sign-in operation not found');
    if (!terminalStatus(operation.status)) {
      this.touch(operation, 'cancelled');
      await this.stopAndRelease(operation);
    }
    return publicOperation(operation);
  }

  private async finish(operation: LoginOperationRecord): Promise<void> {
    try {
      await operation.child?.completion;
      if (terminalStatus(operation.status)) {
        this.release(operation);
        return;
      }
      this.touch(operation, 'verifying');
      if (!await this.accountConfigured(operation.target.account)) {
        this.fail(operation, 'Claude did not return a usable account. Try signing in again.');
        this.release(operation);
        return;
      }
      const account = await this.resolveCompletedAccount(operation.target);
      operation.accountId = account.id;
      operation.account = await this.readAccountName(account);
      if (operation.target.markerPath) await unlink(operation.target.markerPath).catch(() => undefined);
      this.touch(operation, 'succeeded');
      this.release(operation);
    } catch {
      if (terminalStatus(operation.status)) {
        this.release(operation);
        return;
      }
      this.fail(operation, 'Claude sign-in did not complete. Try again.');
      this.release(operation);
    } finally {
      operation.output = '';
    }
  }

  private handleOutput(operation: LoginOperationRecord, chunk: string): void {
    if (terminalStatus(operation.status)) return;
    operation.output = `${operation.output}${chunk}`.slice(-MAX_OUTPUT_BYTES);
    const loginUrl = trustedLoginUrl(operation.output);
    if (!loginUrl) return;
    operation.loginUrl = loginUrl;
    if (operation.status === 'starting') this.touch(operation, 'waiting');
  }

  private fail(operation: LoginOperationRecord, error: string): void {
    operation.error = error;
    this.touch(operation, 'failed');
  }

  private async stopAndRelease(operation: LoginOperationRecord): Promise<void> {
    if (operation.child) {
      await terminateChildProcess(operation.child, { forceAfterMs: 2_000 });
    }
    this.release(operation);
  }

  private release(operation: LoginOperationRecord): void {
    if (operation.timeout) clearTimeout(operation.timeout);
    operation.timeout = undefined;
    operation.output = '';
    if (this.activeOperationId === operation.id) this.activeOperationId = undefined;
  }

  private requireActive(operationId: string): LoginOperationRecord {
    const operation = this.operations.get(operationId);
    if (!operation) throw new ClaudeAccountLoginError(404, 'Claude sign-in operation not found');
    if (terminalStatus(operation.status)) {
      throw new ClaudeAccountLoginError(409, 'Claude sign-in is no longer active');
    }
    return operation;
  }

  private touch(
    operation: LoginOperationRecord,
    status: ClaudeAccountLoginOperation['status'],
  ): void {
    operation.status = status;
    operation.updatedAt = this.now().toISOString();
  }

  private async existingTarget(accountId: string): Promise<LoginTarget> {
    const registry = await this.registry();
    const account = registry.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new ClaudeAccountLoginError(404, `Claude account not found: ${accountId}`);
    return { account, isNew: false };
  }

  private async allocateTarget(): Promise<LoginTarget> {
    await mkdir(this.profilesRoot, { mode: 0o700, recursive: true });
    const root = await lstat(this.profilesRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new ClaudeAccountLoginError(409, 'Claude account profile root must be a real directory');
    }
    const entries = new Set(await readdir(this.profilesRoot));
    for (let index = 2; index < 1_000; index += 1) {
      const configDir = join(this.profilesRoot, `account-${index}`);
      const markerPath = join(configDir, LOGIN_PROFILE_MARKER);
      if (entries.has(`account-${index}`)) {
        const metadata = await lstat(configDir).catch(() => undefined);
        if (!metadata?.isDirectory() || metadata.isSymbolicLink()) continue;
        if (!await lstat(markerPath).then((value) => value.isFile(), () => false)) continue;
        await chmod(configDir, 0o700);
        return {
          account: { configDir, id: `account-${index}`, label: `Account ${index}` },
          isNew: true,
          markerPath,
        };
      }
      try {
        await mkdir(configDir, { mode: 0o700 });
        await writeFile(markerPath, '', { flag: 'wx', mode: 0o600 });
        return {
          account: { configDir, id: `account-${index}`, label: `Account ${index}` },
          isNew: true,
          markerPath,
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    }
    throw new ClaudeAccountLoginError(409, 'Could not allocate another Claude account profile');
  }

  private async resolveCompletedAccount(target: LoginTarget): Promise<ClaudeCodeAccountConfig> {
    if (!target.isNew) return target.account;
    const targetDir = normalizedConfigDir(target.account.configDir);
    const discovered = await this.discoverAccounts(this.profilesRoot);
    const account = discovered.find((candidate) => normalizedConfigDir(candidate.configDir) === targetDir);
    if (!account) throw new Error('Completed Claude account was not discoverable');
    return account;
  }

  private async registry(): Promise<ClaudeCodeAccountRegistry> {
    const [configured, agents, discovered] = await Promise.all([
      this.settings.getProviderAccounts(),
      this.agents.listAgentConfigs(),
      this.discoverAccounts(this.profilesRoot),
    ]);
    return effectiveClaudeAccountRegistry(configured.claudeCode, agents, discovered);
  }

  private pruneOperations(): void {
    const cutoff = this.now().getTime() - TERMINAL_OPERATION_RETENTION_MS;
    for (const [id, operation] of this.operations) {
      if (id === this.activeOperationId) continue;
      if (terminalStatus(operation.status) && Date.parse(operation.updatedAt) < cutoff) {
        this.operations.delete(id);
      }
    }
  }
}

function publicOperation(operation: LoginOperationRecord): ClaudeAccountLoginOperation {
  return {
    ...(operation.account ? { account: operation.account } : {}),
    ...(operation.accountId ? { accountId: operation.accountId } : {}),
    createdAt: operation.createdAt,
    ...(operation.error ? { error: operation.error } : {}),
    id: operation.id,
    ...(operation.loginUrl ? { loginUrl: operation.loginUrl } : {}),
    status: operation.status,
    updatedAt: operation.updatedAt,
  };
}

function terminalStatus(status: ClaudeAccountLoginOperation['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function loginEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LOGIN_ENV_KEYS) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  return env;
}

function trustedLoginUrl(output: string): string | undefined {
  const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const matches = plain.match(/https:\/\/[^\s<>"']+/g) ?? [];
  for (const match of matches) {
    const candidate = match.replace(/[),.;\]]+$/g, '');
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      if (
        host === 'claude.ai'
        || host.endsWith('.claude.ai')
        || host === 'claude.com'
        || host.endsWith('.claude.com')
        || host === 'anthropic.com'
        || host.endsWith('.anthropic.com')
      ) {
        return url.toString();
      }
    } catch {
      // Keep scanning: terminal output may contain non-URL punctuation.
    }
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export const defaultClaudeAccountLoginService = new ClaudeAccountLoginService();
