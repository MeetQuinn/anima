import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentConfig } from '../../shared/agent-config.js';
import type { ProviderAccountsConfig } from '../../shared/provider-accounts.js';
import {
  ClaudeAccountLoginError,
  ClaudeAccountLoginService,
  type ClaudeAccountLoginServiceOptions,
} from '../provider-accounts/claude-account-login.service.js';
import type { RunningChildProcess } from '../providers/child-process.js';

test('managed Claude login isolates a new account, exposes only a trusted URL, and accepts a one-time code', async () => {
  const profilesRoot = await mkdtemp(join(tmpdir(), 'anima-claude-login-'));
  const loginProcess = fakeChild();
  let startInput: Parameters<NonNullable<ClaudeAccountLoginServiceOptions['startChild']>>[0] | undefined;
  let configured = false;
  try {
    const service = loginService({
      accountConfigured: async () => configured,
      discoverAccounts: async () => configured
        ? [{ configDir: join(profilesRoot, 'account-2'), id: 'account-finished', label: 'Account 2' }]
        : [],
      profilesRoot,
      readAccountName: async () => 'new@example.com',
      startChild: (input) => {
        startInput = input;
        return loginProcess.child;
      },
    });

    const started = await service.start({ email: 'new@example.com' });
    assert.equal(started.status, 'starting');
    assert.equal(started.accountId, undefined, 'adding an account must not select or invent a registry id early');
    assert.deepEqual(startInput?.args, ['auth', 'login', '--claudeai', '--email', 'new@example.com']);
    assert.equal(startInput?.command, 'claude');
    assert.equal(startInput?.env.CLAUDE_CONFIG_DIR, join(profilesRoot, 'account-2'));
    assert.equal(startInput?.env.DISABLE_AUTOUPDATER, '1');
    assert.equal(startInput?.env.ANIMA_AGENT_ID, undefined);
    assert.equal(startInput?.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(startInput?.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(startInput?.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(startInput?.env.DYLD_INSERT_LIBRARIES, undefined);
    assert.equal(startInput?.env.FEISHU_APP_SECRET, undefined);
    assert.equal(startInput?.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(startInput?.env.LD_PRELOAD, undefined);
    assert.equal(startInput?.env.NODE_OPTIONS, undefined);
    assert.equal(startInput?.env.OPENAI_API_KEY, undefined);
    assert.equal(startInput?.env.SLACK_BOT_TOKEN, undefined);
    assert.equal(startInput?.env.UNRELATED_SERVICE_SECRET, undefined);
    assert.equal(startInput?.env.HOME, '/home/test');
    assert.equal(startInput?.env.HTTPS_PROXY, 'https://proxy.example');
    assert.equal(startInput?.env.NO_PROXY, '127.0.0.1,localhost');
    assert.equal(startInput?.env.SSL_CERT_FILE, '/etc/test-ca.pem');
    assert.equal(startInput?.env.PATH, process.env.PATH);
    assert.deepEqual(Object.keys(startInput?.env ?? {}).sort(), [
      'CLAUDE_CONFIG_DIR',
      'DISABLE_AUTOUPDATER',
      'HOME',
      'HTTPS_PROXY',
      'NO_COLOR',
      'NO_PROXY',
      'PATH',
      'SSL_CERT_FILE',
    ]);
    assert.equal((await stat(join(profilesRoot, 'account-2'))).mode & 0o777, 0o700);
    assert.equal(await readFile(join(profilesRoot, 'account-2', '.anima-login-profile'), 'utf8'), '');

    await startInput?.onStdoutChunk?.('Ignore https://example.com/phish and continue at https://cla');
    await startInput?.onStdoutChunk?.('ude.com/cai/oauth/authorize?state=abc.');
    const waiting = service.get(started.id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.loginUrl, 'https://claude.com/cai/oauth/authorize?state=abc');
    assert.equal(JSON.stringify(waiting).includes('example.com/phish'), false);

    const verifying = service.submitCode(started.id, '  one-time-secret  ');
    assert.equal(verifying.status, 'verifying');
    assert.deepEqual(loginProcess.stdin, ['one-time-secret\n']);
    assert.equal(JSON.stringify(verifying).includes('one-time-secret'), false);

    configured = true;
    loginProcess.resolve();
    const completed = await waitForStatus(service, started.id, 'succeeded');
    assert.equal(completed.accountId, 'account-finished');
    assert.equal(completed.account, 'new@example.com');
    await assert.rejects(readFile(join(profilesRoot, 'account-2', '.anima-login-profile')), /ENOENT/);
  } finally {
    await rm(profilesRoot, { force: true, recursive: true });
  }
});

test('managed Claude login rejects concurrent work, reports generic failure, and can be cancelled', async () => {
  const profilesRoot = await mkdtemp(join(tmpdir(), 'anima-claude-login-failure-'));
  const first = fakeChild();
  const second = fakeChild();
  const children = [first, second];
  try {
    const service = loginService({
      profilesRoot,
      startChild: () => children.shift()!.child,
    });
    const starting = service.start({});
    await assert.rejects(
      service.start({}),
      (error: unknown) => error instanceof ClaudeAccountLoginError && error.statusCode === 409,
      'the lock must cover asynchronous profile allocation before an operation id exists',
    );
    const operation = await starting;
    await assert.rejects(
      service.start({}),
      (error: unknown) => error instanceof ClaudeAccountLoginError && error.statusCode === 409,
    );

    first.reject(new Error('stderr contained oauth-secret-that-must-not-escape'));
    const failed = await waitForStatus(service, operation.id, 'failed');
    assert.equal(failed.error, 'Claude sign-in did not complete. Try again.');
    assert.equal(JSON.stringify(failed).includes('oauth-secret-that-must-not-escape'), false);

    const retry = await service.start({});
    const cancelled = await service.cancel(retry.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(second.signals, ['SIGTERM']);
  } finally {
    await rm(profilesRoot, { force: true, recursive: true });
  }
});

test('managed Claude login holds its global lock until cancellation proves the child exited', async () => {
  const profilesRoot = await mkdtemp(join(tmpdir(), 'anima-claude-login-cancel-drain-'));
  const first = fakeChild({ resolveOnKill: false });
  const second = fakeChild();
  const children = [first, second];
  try {
    const service = loginService({
      profilesRoot,
      startChild: () => children.shift()!.child,
    });
    const operation = await service.start({});
    const cancelling = service.cancel(operation.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await assert.rejects(
      service.start({}),
      (error: unknown) => error instanceof ClaudeAccountLoginError && error.statusCode === 409,
      'a cancelled operation remains exclusive until its child has actually exited',
    );

    first.resolve();
    assert.equal((await cancelling).status, 'cancelled');
    const retry = await service.start({});
    await service.cancel(retry.id);
  } finally {
    await rm(profilesRoot, { force: true, recursive: true });
  }
});

test('managed Claude login releases its global lock when the subprocess cannot start', async () => {
  const profilesRoot = await mkdtemp(join(tmpdir(), 'anima-claude-login-start-failure-'));
  let starts = 0;
  try {
    const service = loginService({
      profilesRoot,
      startChild: () => {
        starts += 1;
        throw new Error('spawn contained local-path-that-must-not-escape');
      },
    });

    const failed = await service.start({});
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Claude sign-in could not start. Check that Claude Code is installed.');
    assert.equal(JSON.stringify(failed).includes('local-path-that-must-not-escape'), false);

    const retry = await service.start({});
    assert.equal(retry.status, 'failed');
    assert.equal(starts, 2, 'a synchronous spawn failure must not hold the one-login-at-a-time lock');
  } finally {
    await rm(profilesRoot, { force: true, recursive: true });
  }
});

test('reauthentication targets an existing global account without changing account selection', async () => {
  const profilesRoot = await mkdtemp(join(tmpdir(), 'anima-claude-login-existing-'));
  const secondaryDir = join(profilesRoot, 'secondary');
  const first = fakeChild();
  const second = fakeChild();
  const starts: Array<{ env: NodeJS.ProcessEnv }> = [];
  try {
    const service = loginService({
      configured: {
        claudeCode: {
          accounts: [
            { id: 'primary', label: 'Primary' },
            { configDir: secondaryDir, id: 'secondary', label: 'Secondary' },
          ],
          activeAccountId: 'secondary',
        },
      },
      discoverAccounts: async () => [],
      profilesRoot,
      startChild: (input) => {
        starts.push({ env: input.env });
        return starts.length === 1 ? first.child : second.child;
      },
    });

    const primary = await service.start({ accountId: 'primary' });
    assert.equal(starts[0]?.env.CLAUDE_CONFIG_DIR, undefined);
    await service.cancel(primary.id);

    const secondary = await service.start({ accountId: 'secondary' });
    assert.equal(starts[1]?.env.CLAUDE_CONFIG_DIR, secondaryDir);
    await service.cancel(secondary.id);
  } finally {
    await rm(profilesRoot, { force: true, recursive: true });
  }
});

function loginService(options: {
  accountConfigured?: () => Promise<boolean>;
  configured?: ProviderAccountsConfig;
  discoverAccounts?: () => Promise<Array<{ configDir: string; id: string; label: string }>>;
  profilesRoot: string;
  readAccountName?: () => Promise<string | undefined>;
  startChild: NonNullable<ClaudeAccountLoginServiceOptions['startChild']>;
}): ClaudeAccountLoginService {
  return new ClaudeAccountLoginService({
    accountConfigured: options.accountConfigured ?? (async () => false),
    agents: { listAgentConfigs: async () => [] as AgentConfig[] },
    createId: sequenceUuid(),
    discoverAccounts: options.discoverAccounts ?? (async () => []),
    env: {
      ANIMA_AGENT_ID: 'milo',
      ANTHROPIC_API_KEY: 'anthropic-api-key-that-must-not-reach-claude',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token-that-must-not-reach-claude',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-that-must-not-reach-claude',
      DYLD_INSERT_LIBRARIES: '/private/evil.dylib',
      FEISHU_APP_SECRET: 'feishu-secret-that-must-not-reach-claude',
      GOOGLE_APPLICATION_CREDENTIALS: '/private/google-credentials.json',
      HOME: '/home/test',
      HTTPS_PROXY: 'https://proxy.example',
      LD_PRELOAD: '/private/evil.so',
      NODE_OPTIONS: '--require /private/evil.cjs',
      NO_PROXY: '127.0.0.1,localhost',
      OPENAI_API_KEY: 'openai-key-that-must-not-reach-claude',
      PATH: process.env.PATH,
      SLACK_BOT_TOKEN: 'slack-secret-that-must-not-reach-claude',
      SSL_CERT_FILE: '/etc/test-ca.pem',
      UNRELATED_SERVICE_SECRET: 'generic-secret-that-must-not-reach-claude',
    },
    now: () => new Date('2026-07-19T13:00:00.000Z'),
    profilesRoot: options.profilesRoot,
    readAccountName: options.readAccountName ?? (async () => undefined),
    settings: { getProviderAccounts: async () => options.configured ?? {} },
    startChild: options.startChild,
  });
}

function fakeChild(options: { resolveOnKill?: boolean } = {}): {
  child: RunningChildProcess;
  reject: (error: Error) => void;
  resolve: () => void;
  signals: NodeJS.Signals[];
  stdin: string[];
} {
  let resolveCompletion!: (value: { stderr: string; stdout: string }) => void;
  let rejectCompletion!: (error: Error) => void;
  const stdin: string[] = [];
  const signals: NodeJS.Signals[] = [];
  const completion = new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  return {
    child: {
      completion,
      endStdin() {},
      kill(signal = 'SIGTERM') {
        signals.push(signal);
        if (options.resolveOnKill ?? true) resolveCompletion({ stderr: '', stdout: '' });
      },
      setVersion() {},
      snapshot: () => ({
        alive: true,
        command: 'claude',
        exited: false,
        label: 'Claude account sign-in',
        startedAt: '2026-07-19T13:00:00.000Z',
        stdinWritable: true,
      }),
      writeStdin(input) {
        stdin.push(input);
      },
    },
    reject: rejectCompletion,
    resolve: () => resolveCompletion({ stderr: '', stdout: '' }),
    signals,
    stdin,
  };
}

async function waitForStatus(
  service: ClaudeAccountLoginService,
  operationId: string,
  status: 'failed' | 'succeeded',
): Promise<ReturnType<ClaudeAccountLoginService['get']>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = service.get(operationId);
    if (operation.status === status) return operation;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`operation did not reach ${status}`);
}

function sequenceUuid(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
}
