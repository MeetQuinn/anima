import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { withAnimaHome } from './anima-home.js';
import {
  ProviderCliCheckStore,
  ProviderCliConflictError,
  ProviderCliOperationStore,
  ProviderCliService,
  type ProviderCliCommandRunner,
} from '../provider-cli/provider-cli.service.js';
import { claudeKeychainService } from '../provider-accounts/claude-account-config.js';
import {
  providerCliUpgradeLocked,
  tryAcquireProviderCliUpgradeLease,
  withProviderCliLaunchPermit,
} from '../provider-cli/launch-gate.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import type { AgentStatusSummary } from '../../shared/snapshot.js';

test('Codex updates use the npm paired with the active binary and block new launches through self-check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-codex-'));
  const prefix = join(root, 'active-prefix');
  const binDir = join(prefix, 'bin');
  const packageDir = join(prefix, 'lib', 'node_modules', '@openai', 'codex');
  const codexScript = join(packageDir, 'bin', 'codex.js');
  const codexCommand = join(binDir, 'codex');
  const npmCommand = join(binDir, 'npm');
  let installedVersion = '1.0.0';
  let finishInstall!: () => void;
  let finishSelfCheck!: () => void;
  let installStarted!: () => void;
  let selfCheckStarted!: () => void;
  const installStartedPromise = new Promise<void>((resolve) => {
    installStarted = resolve;
  });
  const finishInstallPromise = new Promise<void>((resolve) => {
    finishInstall = resolve;
  });
  const selfCheckStartedPromise = new Promise<void>((resolve) => {
    selfCheckStarted = resolve;
  });
  const finishSelfCheckPromise = new Promise<void>((resolve) => {
    finishSelfCheck = resolve;
  });
  const calls: Array<{ args: string[]; command: string }> = [];

  await mkdir(join(packageDir, 'bin'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(codexScript, '// fake codex\n', 'utf8');
  await chmod(codexScript, 0o755);
  await writeFile(npmCommand, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(npmCommand, 0o755);
  await symlink(codexScript, codexCommand);
  await writeCodexPackage(packageDir, installedVersion);
  const resolvedPrefix = await realpath(prefix);
  const resolvedNpmCommand = join(resolvedPrefix, 'bin', 'npm');

  const runCommand: ProviderCliCommandRunner = async (command, args) => {
    calls.push({ args, command });
    if (command === codexCommand && args[0] === '--version') {
      if (installedVersion === '1.1.0') {
        selfCheckStarted();
        await finishSelfCheckPromise;
      }
      return { stderr: '', stdout: `codex-cli ${installedVersion}` };
    }
    if (command === resolvedNpmCommand && args.join(' ') === 'prefix -g') {
      return { stderr: '', stdout: resolvedPrefix };
    }
    if (command === resolvedNpmCommand && args[0] === 'install') {
      installStarted();
      await finishInstallPromise;
      installedVersion = '1.1.0';
      await writeCodexPackage(packageDir, installedVersion);
      return { stderr: '', stdout: 'updated' };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  try {
    await withAnimaHome(root, async () => {
      const service = new ProviderCliService({
        checkStore: new ProviderCliCheckStore(),
        env: { PATH: binDir },
        fetch: async () => new Response(JSON.stringify({ version: '1.1.0' }), { status: 200 }),
        listAgentConfigs: async () => [],
        listStatuses: async () => [],
        operationStore: new ProviderCliOperationStore(),
        runCommand,
      });

      const applying = service.apply('codex-cli');
      await assert.rejects(() => service.apply('claude-code'), ProviderCliConflictError);
      await installStartedPromise;
      let launchReleased = false;
      const launch = withProviderCliLaunchPermit('codex-cli', undefined, () => {
        launchReleased = true;
      });
      await Promise.resolve();
      assert.equal(launchReleased, false);
      finishInstall();
      await selfCheckStartedPromise;
      assert.equal(launchReleased, false);
      finishSelfCheck();
      const result = await applying;
      await launch;
      assert.equal(result.installedVersion, '1.1.0');
      assert.equal(launchReleased, true);
      assert.equal(
        calls.some(
          (call) => call.command === resolvedNpmCommand && call.args.join(' ') === 'install -g @openai/codex@1.1.0',
        ),
        true,
      );
      assert.equal(
        calls.some((call) => call.command === 'npm'),
        false,
      );
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('managed Claude updates isolate updater writes from account credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-claude-'));
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  const nativeBinary = join(home, '.local', 'share', 'claude', 'versions', '2.1.211');
  const claudeCommand = join(binDir, 'claude');
  const activeProfile = join(home, '.claude-profiles', 'secondary');
  const activeCredentials = join(activeProfile, '.credentials.json');
  const updateProfile = join(root, 'runtime', 'provider-cli', 'claude-update-profile');
  const updateCredentials = join(updateProfile, '.credentials.json');
  const inspectionEnvs: NodeJS.ProcessEnv[] = [];
  let installedVersion = '2.1.211';
  let updateCalls = 0;
  let updateEnv: NodeJS.ProcessEnv | undefined;

  await mkdir(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(activeProfile, { recursive: true });
  await mkdir(updateProfile, { mode: 0o777, recursive: true });
  await writeFile(nativeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(nativeBinary, 0o755);
  await symlink(nativeBinary, claudeCommand);
  await writeFile(activeCredentials, 'account credential sentinel', 'utf8');

  const runCommand: ProviderCliCommandRunner = async (_command, args, options) => {
    if (args[0] === '--version' || args[0] === 'doctor') {
      const inspectionEnv = options?.env ?? {};
      inspectionEnvs.push(inspectionEnv);
      if (inspectionEnv.DISABLE_AUTOUPDATER !== '1') {
        const configDir = inspectionEnv.CLAUDE_CONFIG_DIR ?? join(inspectionEnv.HOME ?? home, '.claude');
        await mkdir(configDir, { recursive: true });
        await writeFile(join(configDir, '.credentials.json'), 'inspection touched this profile', 'utf8');
      }
      return args[0] === '--version'
        ? { stderr: '', stdout: `Claude Code ${installedVersion}` }
        : {
            stderr: '',
            stdout: 'Auto-updates: enabled\nAuto-update channel: latest\n',
          };
    }
    if (args[0] === 'update') {
      updateCalls += 1;
      updateEnv = options?.env;
      const configDir = updateEnv?.CLAUDE_CONFIG_DIR ?? join(updateEnv?.HOME ?? home, '.claude');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, '.credentials.json'), 'updater touched only this profile', 'utf8');
      installedVersion = '2.1.214';
      return { stderr: '', stdout: 'updated' };
    }
    throw new Error(`Unexpected Claude command: ${args.join(' ')}`);
  };

  try {
    await withAnimaHome(root, async () => {
      const service = new ProviderCliService({
        checkStore: new ProviderCliCheckStore(),
        env: { CLAUDE_CONFIG_DIR: activeProfile, HOME: home, PATH: binDir },
        fetch: async () => new Response('2.1.214', { status: 200 }),
        listAgentConfigs: async () => [],
        listStatuses: async () => [],
        operationStore: new ProviderCliOperationStore(),
        runCommand,
      });

      const applied = await service.apply('claude-code');

      assert.equal(applied.installedVersion, '2.1.214');
      assert.equal(updateEnv?.CLAUDE_CONFIG_DIR, updateProfile);
      assert.equal(updateEnv?.DISABLE_AUTOUPDATER, '1');
      assert.notEqual(claudeKeychainService(updateProfile), claudeKeychainService(undefined));
      assert.notEqual(claudeKeychainService(updateProfile), claudeKeychainService(activeProfile));
      assert.equal(inspectionEnvs.length >= 4, true);
      assert.equal(inspectionEnvs.every((env) => env.CLAUDE_CONFIG_DIR === activeProfile), true);
      assert.equal(inspectionEnvs.every((env) => env.DISABLE_AUTOUPDATER === '1'), true);
      assert.equal(await readFile(activeCredentials, 'utf8'), 'account credential sentinel');
      assert.equal(await readFile(updateCredentials, 'utf8'), 'updater touched only this profile');
      assert.equal((await stat(updateProfile)).mode & 0o777, 0o700);

      await rm(updateProfile, { force: true, recursive: true });
      await symlink(activeProfile, updateProfile);
      installedVersion = '2.1.211';
      await assert.rejects(() => service.apply('claude-code'));
      assert.equal(updateCalls, 1);
      assert.equal(await readFile(activeCredentials, 'utf8'), 'account credential sentinel');
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('machine gates serialize upgrades and provider launches across Node processes', async () => {
  const upgrade = await holdMachineGate('upgrade');
  try {
    assert.equal(await providerCliUpgradeLocked(), true);
    await assert.rejects(
      () => new ProviderCliService().apply('claude-code'),
      (error: unknown) =>
        error instanceof ProviderCliConflictError && /already running on this machine/.test(error.message),
    );
    assert.equal(await tryAcquireProviderCliUpgradeLease('claude-code'), undefined);
  } finally {
    await upgrade.release();
  }
  assert.equal(await providerCliUpgradeLocked(), false);

  const crashed = await holdMachineGate('upgrade');
  await crashed.terminate();
  const recovered = await tryAcquireProviderCliUpgradeLease('claude-code');
  assert.ok(recovered);
  await recovered.release();

  const install = await holdMachineGate('install');
  let launched = false;
  try {
    const launch = withProviderCliLaunchPermit('codex-cli', undefined, () => {
      launched = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(launched, false);
    await install.release();
    await launch;
    assert.equal(launched, true);
  } finally {
    await install.release();
  }
});

test('machine gate grants one contender after a holder crashes', async () => {
  for (let round = 0; round < 60; round += 1) {
    const crashed = await holdMachineGate('upgrade');
    await crashed.terminate();
    await assertSingleUpgradeWinner(round);
  }
});

test('provider checks reuse validators and keep failures isolated by provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-checks-'));
  let round = 0;
  const conditionalHeaders: string[] = [];
  try {
    await withAnimaHome(root, async () => {
      const service = new ProviderCliService({
        checkStore: new ProviderCliCheckStore(),
        env: { PATH: '' },
        fetch: async (input, init) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          if (round > 0) conditionalHeaders.push(headers.get('if-none-match') ?? '');
          if (round > 0 && url.includes('claude')) return new Response(null, { status: 304 });
          if (round > 0 && url.includes('registry.npmjs.org')) {
            return new Response('busy', {
              headers: { 'retry-after': '60' },
              status: 429,
            });
          }
          const version = url.includes('claude') ? '2.1.0' : url.includes('codex') ? '1.2.0' : '0.24.0';
          const body = url.includes('claude') ? version : JSON.stringify({ version });
          return new Response(body, {
            headers: { etag: `\"${version}\"` },
            status: 200,
          });
        },
        listAgentConfigs: async () => [],
        listStatuses: async () => [],
        operationStore: new ProviderCliOperationStore(),
      });

      const first = await service.checkNow();
      assert.deepEqual(
        first.providers.map((row) => row.latestVersion),
        ['2.1.0', '1.2.0', '0.24.0', undefined],
      );
      assert.match(first.providers[3]?.checkError?.message ?? '', /grok/i);
      round = 1;
      const second = await service.checkNow();
      assert.equal(second.providers[0]?.latestVersion, '2.1.0');
      assert.equal(second.providers[0]?.checkError, undefined);
      assert.match(second.providers[1]?.checkError?.message ?? '', /429.*retry after 60/);
      assert.equal(second.providers[2]?.latestVersion, '0.24.0');
      assert.match(second.providers[3]?.checkError?.message ?? '', /grok/i);
      assert.equal(conditionalHeaders.includes('"2.1.0"'), true);
      assert.equal(conditionalHeaders.includes('"1.2.0"'), true);
      assert.equal(conditionalHeaders.includes('"0.24.0"'), true);
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Grok native installs use their own update authority and preserve the active binary path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-grok-'));
  const grokHome = join(root, '.grok');
  const downloads = join(grokHome, 'downloads');
  const binDir = join(root, 'bin');
  const nativeBinary = join(downloads, 'grok-macos-aarch64');
  const grokCommand = join(binDir, 'grok');
  let installedVersion = '0.2.93';
  const calls: Array<{ args: string[]; command: string }> = [];
  await mkdir(downloads, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(nativeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(nativeBinary, 0o755);
  await symlink(nativeBinary, grokCommand);
  const runCommand: ProviderCliCommandRunner = async (command, args) => {
    calls.push({ args, command });
    if (args.join(' ') === '--no-auto-update --version') {
      return { stderr: '', stdout: `grok ${installedVersion} (probe)` };
    }
    if (args.join(' ') === 'update --check --json') {
      return {
        stderr: '',
        stdout: JSON.stringify({
          autoUpdate: false,
          channel: 'stable',
          currentVersion: installedVersion,
          latestVersion: '0.2.94',
          updateAvailable: installedVersion !== '0.2.94',
        }),
      };
    }
    if (args.join(' ') === 'update --version 0.2.94') {
      installedVersion = '0.2.94';
      return { stderr: '', stdout: 'updated' };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  try {
    await withAnimaHome(root, async () => {
      const service = new ProviderCliService({
        checkStore: new ProviderCliCheckStore(),
        env: { GROK_HOME: grokHome, HOME: root, PATH: binDir },
        fetch: async () => new Response('unused', { status: 500 }),
        listAgentConfigs: async () => [],
        listStatuses: async () => [],
        operationStore: new ProviderCliOperationStore(),
        runCommand,
      });
      const checked = await service.checkNow('grok-cli');
      const before = checked.providers.find((row) => row.provider === 'grok-cli');
      assert.equal(before?.installSource, 'grok-native');
      assert.equal(before?.updateMode, 'managed');
      assert.equal(before?.latestVersion, '0.2.94');
      assert.equal(before?.updateAvailable, true);
      assert.equal(before?.autoUpdateChannel, 'stable');
      assert.equal(before?.autoUpdatesEnabled, false);

      const applied = await service.apply('grok-cli');
      assert.equal(applied.installedVersion, '0.2.94');
      assert.equal(
        calls.some((call) => call.command === grokCommand && call.args.join(' ') === 'update --version 0.2.94'),
        true,
      );
      assert.equal(
        calls.some((call) => call.args.includes('login') || call.args.includes('logout')),
        false,
      );
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('multiple PATH installations are reported as manual and never managed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-shadow-'));
  const firstBin = join(root, 'first');
  const secondBin = join(root, 'second');
  await mkdir(firstBin);
  await mkdir(secondBin);
  for (const path of [join(firstBin, 'claude'), join(secondBin, 'claude')]) {
    await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(path, 0o755);
  }
  try {
    await withAnimaHome(root, async () => {
      const service = new ProviderCliService({
        checkStore: new ProviderCliCheckStore(),
        env: { PATH: `${firstBin}:${secondBin}` },
        fetch: async (input) => {
          const url = String(input);
          const version = url.includes('claude') ? '2.2.0' : url.includes('codex') ? '1.0.0' : '0.24.0';
          return new Response(url.includes('claude') ? version : JSON.stringify({ version }));
        },
        listAgentConfigs: async () => [],
        listStatuses: async () => [],
        operationStore: new ProviderCliOperationStore(),
        runCommand: async () => ({ stderr: '', stdout: '2.1.0' }),
      });
      const status = await service.checkNow();
      const claude = status.providers.find((row) => row.provider === 'claude-code');
      assert.equal(claude?.installSource, 'unknown');
      assert.equal(claude?.updateMode, 'manual');
      assert.equal(claude?.updateAvailable, true);
      assert.match(claude?.sourceDetail ?? '', /Multiple claude installations/);
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('provider status reports configured agents and the actual running child version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-impact-'));
  try {
    await withAnimaHome(root, async () => {
      const service = new ProviderCliService({
        checkStore: new ProviderCliCheckStore(),
        env: { PATH: '' },
        fetch: async (input) => {
          const url = String(input);
          const version = url.includes('claude') ? '2.2.0' : url.includes('codex') ? '1.0.0' : '0.24.0';
          return new Response(url.includes('claude') ? version : JSON.stringify({ version }));
        },
        listAgentConfigs: async () => [
          {
            enabled: true,
            id: 'aria',
            profile: { displayName: 'Aria' },
            provider: { kind: 'claude-code' },
          } as AgentConfig,
        ],
        listStatuses: async () => [
          {
            agentId: 'aria',
            health: {
              runtime: {
                providerChild: {
                  alive: true,
                  command: 'claude',
                  exited: false,
                  startedAt: '2026-07-12T05:00:00.000Z',
                  stdinWritable: true,
                  version: '2.1.207',
                },
              },
            },
          } as AgentStatusSummary,
        ],
        operationStore: new ProviderCliOperationStore(),
      });
      const status = await service.checkNow();
      const claude = status.providers.find((row) => row.provider === 'claude-code');
      assert.deepEqual(claude?.agents, [
        {
          enabled: true,
          id: 'aria',
          name: 'Aria',
          runningSince: '2026-07-12T05:00:00.000Z',
          runningVersion: '2.1.207',
        },
      ]);
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

async function holdMachineGate(
  mode: 'install' | 'upgrade',
): Promise<{ release(): Promise<void>; terminate(): Promise<void> }> {
  const moduleUrl = new URL('../provider-cli/launch-gate.js', import.meta.url).href;
  const script = String.raw`
    import { once } from 'node:events';
    const [moduleUrl, mode] = process.argv.slice(1);
    const gate = await import(moduleUrl);
    if (mode === 'upgrade') {
      const lease = await gate.tryAcquireProviderCliUpgradeLease('codex-cli');
      if (!lease) throw new Error('failed to acquire upgrade lease');
      process.stdout.write('LOCKED\n');
      await once(process.stdin, 'data');
      await lease.release();
    } else {
      await gate.withProviderCliInstallGate('codex-cli', async () => {
        process.stdout.write('LOCKED\n');
        await once(process.stdin, 'data');
      });
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`gate holder exited before ready (${code ?? signal ?? 'unknown'}): ${stderr}`));
      };
      child.once('exit', onExit);
      child.stdout.on('data', (chunk: string) => {
        if (!chunk.includes('LOCKED')) return;
        child.off('exit', onExit);
        resolve();
      });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      child.stdin.end('release\n');
      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      assert.equal(code, 0, `gate holder exited with ${code ?? signal ?? 'unknown'}: ${stderr}`);
    },
    async terminate() {
      if (released) return;
      released = true;
      child.kill('SIGKILL');
      await once(child, 'exit');
    },
  };
}

async function assertSingleUpgradeWinner(round: number): Promise<void> {
  const moduleUrl = new URL('../provider-cli/launch-gate.js', import.meta.url).href;
  const script = String.raw`
    import { once } from 'node:events';
    const gate = await import(process.argv[1]);
    process.stdout.write('READY\n');
    await once(process.stdin, 'data');
    const lease = await gate.tryAcquireProviderCliUpgradeLease('codex-cli');
    if (!lease) {
      process.stdout.write('BLOCKED\n');
      process.exit(0);
    }
    process.stdout.write('ACQUIRED\n');
    await once(process.stdin, 'data');
    await lease.release();
  `;
  const contenders = [gateContender(script, moduleUrl), gateContender(script, moduleUrl)];
  try {
    assert.deepEqual(await Promise.all(contenders.map((contender) => contender.nextLine())), ['READY', 'READY']);
    for (const contender of contenders) contender.child.stdin.write('go\n');
    const outcomes = await Promise.all(contenders.map((contender) => contender.nextLine()));
    assert.deepEqual(
      [...outcomes].sort(),
      ['ACQUIRED', 'BLOCKED'],
      `round ${round} must grant exactly one machine lease`,
    );
    for (let index = 0; index < contenders.length; index += 1) {
      if (outcomes[index] === 'ACQUIRED') contenders[index]!.child.stdin.end('release\n');
    }
    await Promise.all(contenders.map((contender) => contender.exited));
  } finally {
    for (const contender of contenders) {
      contender.child.stdin.destroy();
      if (contender.child.exitCode === null) contender.child.kill('SIGKILL');
    }
    await Promise.allSettled(contenders.map((contender) => contender.exited));
  }
}

function gateContender(
  script: string,
  moduleUrl: string,
): {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  nextLine(): Promise<string>;
} {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, moduleUrl], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`gate contender exited with ${code ?? signal ?? 'unknown'}: ${stderr}`));
    });
  });
  return {
    child,
    exited,
    async nextLine() {
      const line = await lines.next();
      if (line.done) throw new Error(`gate contender closed stdout before verdict: ${stderr}`);
      return line.value;
    },
  };
}

async function writeCodexPackage(packageDir: string, version: string): Promise<void> {
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version }), 'utf8');
}
