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
  defaultProviderCliCommandRunner,
  type ProviderCliCommandRunner,
} from '../provider-cli/provider-cli.service.js';
import { claudeKeychainService } from '../provider-usage/providers/claude-credentials.js';
import { inspectProvider } from '../provider-cli/provider-inspection.js';
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

interface ClaudeLauncherFixture {
  activeCredentials: string;
  command: string;
  env: NodeJS.ProcessEnv;
  launcher: string;
  nativeBinary: string;
  root: string;
  updates: string;
}

async function withClaudeLauncher(
  options: { hardPin?: boolean; mutate?: 'content' | 'entry'; version?: string; xdg?: boolean },
  body: (fixture: ClaudeLauncherFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-launcher-'));
  const home = join(root, 'home');
  const dataHome = options.xdg ? join(root, 'data') : join(home, '.local', 'share');
  const versions = join(dataHome, 'claude', 'versions');
  const bin = join(root, 'bin');
  const launcher = join(root, 'launcher');
  const command = join(bin, 'claude');
  const version = options.version ?? '2.1.285';
  const nativeBinary = join(versions, version);
  const nextBinary = join(versions, '2.1.293');
  const template = join(root, 'next-binary');
  const updates = join(root, 'updates');
  const activeProfile = join(home, 'active-profile');
  const activeCredentials = join(activeProfile, '.credentials.json');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await mkdir(versions, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(activeProfile, { recursive: true });
  await writeFile(activeCredentials, 'synthetic account sentinel');
  const fakeBinary = (current: string, path: string) => `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' ${quote(current)} ;;
  doctor) printf '%s\\n' ${quote(`Running: native (${current})`)} ${quote(`Path: ${path}`)} 'Auto-updates: enabled' 'Auto-update channel: latest' ;;
  update)
    printf '%s\\n' "$CLAUDE_CONFIG_DIR" >> ${quote(updates)}
    /bin/mkdir -p "$CLAUDE_CONFIG_DIR"
    printf '%s' 'synthetic updater sentinel' > "$CLAUDE_CONFIG_DIR/.credentials.json"
    /bin/cp ${quote(template)} ${quote(nextBinary)}
    /bin/chmod 755 ${quote(nextBinary)}
    ${options.mutate === 'content' ? `printf '\\n# changed during update\\n' >> ${quote(launcher)}` : ':'}
    ${options.mutate === 'entry' ? `/bin/rm ${quote(command)}; /bin/ln -s ${quote(nextBinary)} ${quote(command)}` : ':'}
    ;;
  *) exit 2 ;;
esac
`;
  await writeFile(template, fakeBinary('2.1.293', nextBinary));
  await writeFile(nativeBinary, fakeBinary(version, nativeBinary));
  await chmod(nativeBinary, 0o755);
  await writeFile(launcher, `#!/bin/sh
export CLAUDE_CONFIG_DIR=${quote(activeProfile)}
if [ "$1" = update ]; then exit 73; fi
versions=${quote(versions)}
pin=${options.hardPin ? quote(version) : '"\u0024{CLAUDE_PIN_VERSION:-}"'}
if [ -n "$pin" ] && [ -x "$versions/$pin" ]; then
  binary="$versions/$pin"
else
  binary=$(/usr/bin/find "$versions" -type f | /usr/bin/sort -V | /usr/bin/tail -n 1)
fi
exec "$binary" "$@"
`);
  await chmod(launcher, 0o755);
  await symlink(launcher, command);
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: activeProfile,
    DISABLE_AUTOUPDATER: '1',
    HOME: home,
    PATH: bin,
  };
  if (options.xdg) env.XDG_DATA_HOME = dataHome;
  try {
    await body({ activeCredentials, command, env, launcher, nativeBinary, root, updates });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function launcherService(fixture: ClaudeLauncherFixture): ProviderCliService {
  return new ProviderCliService({
    checkStore: new ProviderCliCheckStore(),
    env: fixture.env,
    fetch: async () => new Response('2.1.293', { status: 200 }),
    listAgentConfigs: async () => [],
    listStatuses: async () => [],
    operationStore: new ProviderCliOperationStore(),
  });
}

test('custom Claude launcher updates its verified native binary and rechecks the original entry', async () => {
  await withClaudeLauncher({}, async (fixture) => {
    const before = await readFile(fixture.launcher);
    const inspection = await inspectProvider('claude-code', fixture.env, defaultProviderCliCommandRunner);
    assert.equal(inspection.updateMode, 'managed');
    assert.equal(inspection.installSource, 'claude-native');
    assert.equal(inspection.restoreCommand, undefined);
    assert.deepEqual(inspection.updateCommand, { args: ['update'], command: await realpath(fixture.nativeBinary) });
    assert.match(inspection.launcherFingerprint ?? '', /^[a-f0-9]{64}$/);
    await withAnimaHome(fixture.root, async () => {
      const service = launcherService(fixture);
      const checked = await service.checkNow('claude-code');
      const row = checked.providers.find((provider) => provider.provider === 'claude-code');
      assert.equal(row?.updateMode, 'managed');
      assert.equal(row?.sourceDetail, 'Verified native install via custom launcher');
      assert.equal(Object.hasOwn(row ?? {}, 'launcherFingerprint'), false);
      const updated = await service.apply('claude-code');
      assert.equal(updated.ok, true);
      assert.equal(updated.installedVersion, '2.1.293');
      const profile = join(fixture.root, 'runtime', 'provider-cli', 'claude-update-profile');
      assert.equal(await readFile(fixture.updates, 'utf8'), `${profile}\n`);
      assert.equal(await readFile(join(profile, '.credentials.json'), 'utf8'), 'synthetic updater sentinel');
      assert.equal((await stat(profile)).mode & 0o777, 0o700);
    });
    assert.equal(await realpath(fixture.command), await realpath(fixture.launcher));
    assert.deepEqual(await readFile(fixture.launcher), before);
    assert.equal(await readFile(fixture.activeCredentials, 'utf8'), 'synthetic account sentinel');
    assert.equal((await defaultProviderCliCommandRunner(fixture.command, ['--version'], { env: fixture.env })).stdout.trim(), '2.1.293');
  });
});

test('custom Claude launcher supports the native XDG data directory', async () => {
  await withClaudeLauncher({ xdg: true }, async (fixture) => {
    const inspection = await inspectProvider('claude-code', fixture.env, defaultProviderCliCommandRunner);
    assert.equal(inspection.updateMode, 'managed');
    assert.equal(inspection.updateCommand?.command, await realpath(fixture.nativeBinary));
  });
});

test('a native Claude binary in XDG data is not fingerprinted as a custom launcher', async () => {
  await withClaudeLauncher({ xdg: true }, async (fixture) => {
    await rm(fixture.command);
    await symlink(fixture.nativeBinary, fixture.command);
    const inspection = await inspectProvider('claude-code', fixture.env, defaultProviderCliCommandRunner);
    assert.equal(inspection.updateMode, 'managed');
    assert.equal(inspection.sourceDetail, 'Native install');
    assert.equal(inspection.launcherFingerprint, undefined);
    assert.match(inspection.restoreCommand ?? '', /2.1.285/);
  });
});

test('custom Claude launcher with an explicit fixed version stays manual without executing update', async () => {
  await withClaudeLauncher({}, async (fixture) => {
    fixture.env.CLAUDE_PIN_VERSION = '2.1.285';
    await withAnimaHome(fixture.root, async () => {
      const service = launcherService(fixture);
      const checked = await service.checkNow('claude-code');
      const row = checked.providers.find((provider) => provider.provider === 'claude-code');
      assert.equal(row?.updateMode, 'manual');
      assert.match(row?.sourceDetail ?? '', /fixed version/);
      await assert.rejects(() => service.apply('claude-code'), /must be updated manually/);
    });
    await assert.rejects(() => readFile(fixture.updates), { code: 'ENOENT' });
    assert.equal(fixture.env.CLAUDE_PIN_VERSION, '2.1.285');
  });
});

test('custom Claude launchers before 2.1.207 stay manual', async () => {
  await withClaudeLauncher({ version: '2.1.206' }, async (fixture) => {
    const inspection = await inspectProvider('claude-code', fixture.env, defaultProviderCliCommandRunner);
    assert.equal(inspection.updateMode, 'manual');
    assert.match(inspection.sourceDetail ?? '', /does not preserve/);
    assert.equal(inspection.updateCommand, undefined);
  });
});

test('custom Claude launcher rejects unverified, ambiguous or inconsistent native evidence', async (context) => {
  await withClaudeLauncher({}, async (fixture) => {
    const canonical = await realpath(fixture.nativeBinary);
    const validDoctor = `Running: native (2.1.285)\nPath: ${canonical}\n`;
    const cases = [
      { name: 'missing doctor', doctor: '' },
      { name: 'non-native doctor', doctor: `Running: npm (2.1.285)\nPath: ${canonical}\n` },
      { name: 'outside native directory', doctor: `Running: native (2.1.285)\nPath: ${fixture.launcher}\n` },
      { name: 'ambiguous path', doctor: `${validDoctor}Path: ${canonical}\n` },
      { name: 'doctor version mismatch', doctor: `Running: native (2.1.284)\nPath: ${canonical}\n` },
      { name: 'native version mismatch', doctor: validDoctor, nativeVersion: '2.1.284' },
      { name: 'relative XDG directory', doctor: validDoctor, xdg: 'relative' },
    ];
    for (const entry of cases) {
      await context.test(entry.name, async () => {
        const runner: ProviderCliCommandRunner = async (command, args) => {
          if (args[0] === 'doctor') return { stderr: '', stdout: entry.doctor };
          if (command === canonical && entry.nativeVersion) return { stderr: '', stdout: entry.nativeVersion };
          return defaultProviderCliCommandRunner(command, args, { env: fixture.env });
        };
        const env = { ...fixture.env };
        if (entry.xdg) env.XDG_DATA_HOME = entry.xdg;
        const inspection = await inspectProvider('claude-code', env, runner);
        assert.equal(inspection.updateMode, 'manual');
        assert.equal(inspection.updateCommand, undefined);
      });
    }
  });
});

for (const mutate of ['content', 'entry'] as const) {
  test(`custom Claude launcher self-check rejects changed ${mutate} after update`, async () => {
    await withClaudeLauncher({ mutate }, async (fixture) => {
      await withAnimaHome(fixture.root, async () => {
        const service = launcherService(fixture);
        await assert.rejects(() => service.apply('claude-code'), /custom launcher changed/);
        const snapshot = await service.status();
        assert.equal(snapshot.operation?.status, 'failed');
        assert.match(snapshot.operation?.error ?? '', /custom launcher changed/);
      });
      assert.equal((await readFile(fixture.updates, 'utf8')).split('\n').filter(Boolean).length, 1);
      assert.equal(await readFile(fixture.activeCredentials, 'utf8'), 'synthetic account sentinel');
    });
  });
}

test('custom Claude launcher with a hidden pin cannot report success from the updater alone', async () => {
  await withClaudeLauncher({ hardPin: true }, async (fixture) => {
    const before = await readFile(fixture.launcher);
    await withAnimaHome(fixture.root, async () => {
      const service = launcherService(fixture);
      await assert.rejects(() => service.apply('claude-code'), /self-check returned 2.1.285/);
      assert.equal((await service.status()).operation?.status, 'failed');
    });
    assert.deepEqual(await readFile(fixture.launcher), before);
    assert.equal((await defaultProviderCliCommandRunner(fixture.command, ['--version'], { env: fixture.env })).stdout.trim(), '2.1.285');
    assert.equal(await readFile(fixture.activeCredentials, 'utf8'), 'synthetic account sentinel');
  });
});

test('OpenCode Homebrew installs use the paired brew and never invoke authentication commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-opencode-'));
  const prefix = join(root, 'homebrew');
  const binDir = join(prefix, 'bin');
  const opencodeCommand = join(binDir, 'opencode');
  const brewCommand = join(binDir, 'brew');
  let installedVersion = '1.18.4';
  const calls: Array<{ args: string[]; command: string }> = [];

  const installVersion = async (version: string) => {
    const binary = join(prefix, 'Cellar', 'opencode', version, 'bin', 'opencode');
    await mkdir(join(prefix, 'Cellar', 'opencode', version, 'bin'), { recursive: true });
    await writeFile(binary, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(binary, 0o755);
    await rm(opencodeCommand, { force: true });
    await symlink(binary, opencodeCommand);
    installedVersion = version;
  };

  await mkdir(binDir, { recursive: true });
  await writeFile(brewCommand, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(brewCommand, 0o755);
  await installVersion(installedVersion);
  const resolvedBrewCommand = await realpath(brewCommand);

  const runCommand: ProviderCliCommandRunner = async (command, args) => {
    calls.push({ args, command });
    if (command === opencodeCommand && args.join(' ') === '--version') {
      return { stderr: '', stdout: installedVersion };
    }
    if (command === resolvedBrewCommand && args.join(' ') === 'upgrade anomalyco/tap/opencode') {
      await installVersion('1.19.0');
      return { stderr: '', stdout: 'upgraded opencode' };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  try {
    await withAnimaHome(root, async () => {
      const service = new ProviderCliService({
        checkStore: new ProviderCliCheckStore(),
        env: { PATH: binDir },
        fetch: async () => new Response(JSON.stringify({ version: '1.19.0' }), { status: 200 }),
        listAgentConfigs: async () => [],
        listStatuses: async () => [],
        operationStore: new ProviderCliOperationStore(),
        runCommand,
      });

      const checked = await service.checkNow('opencode-cli');
      const before = checked.providers.find((row) => row.provider === 'opencode-cli');
      assert.equal(before?.installSource, 'opencode-brew');
      assert.equal(before?.updateMode, 'managed');
      assert.equal(before?.installedVersion, '1.18.4');
      assert.equal(before?.latestVersion, '1.19.0');
      assert.equal(before?.updateAvailable, true);

      const applied = await service.apply('opencode-cli');
      assert.equal(applied.installedVersion, '1.19.0');
      assert.equal(
        calls.some((call) =>
          call.command === resolvedBrewCommand && call.args.join(' ') === 'upgrade anomalyco/tap/opencode'),
        true,
      );
      assert.equal(
        calls.some((call) => call.args.includes('auth') || call.args.includes('login') || call.args.includes('logout')),
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

test('managed Claude updates model the Keychain-service clobber outcome (not just a file proxy)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-claude-keychain-'));
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  const nativeBinary = join(home, '.local', 'share', 'claude', 'versions', '2.1.211');
  const claudeCommand = join(binDir, 'claude');
  const activeProfile = join(home, '.claude-profiles', 'secondary');
  const updateProfile = join(root, 'runtime', 'provider-cli', 'claude-update-profile');

  // Service keys come from the PRODUCTION derivation, never from paths: the incident destroyed a
  // logical Keychain SERVICE credential, and keying by path would silently rebuild the file proxy
  // this test exists to retire (#567).
  const defaultService = claudeKeychainService(undefined);
  const activeService = claudeKeychainService(activeProfile);
  const updateService = claudeKeychainService(updateProfile);
  // The three logical services must be genuinely distinct, or the outcome assertions are vacuous.
  assert.equal(new Set([defaultService, activeService, updateService]).size, 3);

  const BLANK = ''; // the incident rewrote OAuth tokens to blank
  const SEED: Record<string, string> = {
    [defaultService]: 'default-service-oauth-token',
    [activeService]: 'active-service-oauth-token',
    [updateService]: 'updater-service-oauth-token',
  };
  const seedStore = (): Map<string, string> => new Map(Object.entries(SEED));

  interface Records {
    inspectionEnvs: NodeJS.ProcessEnv[];
    updateEnv?: NodeJS.ProcessEnv;
    updateCalls: number;
  }
  const freshRecords = (): Records => ({ inspectionEnvs: [], updateCalls: 0 });

  // Hermetic disaster model in the SAME logical domain as the incident: a claude invocation that
  // migrates credentials blanks the OAuth tokens of the Keychain SERVICE selected by its
  // CLAUDE_CONFIG_DIR (via the production derivation). `claude update` always migrates; `--version`
  // /`doctor` migrate only when the background auto-updater is NOT disabled. No real `security`
  // call, no real Keychain, no live `claude update`, no account switch.
  const handle = (
    store: Map<string, string>,
    records: Records,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): { stderr: string; stdout: string } => {
    const migrateSelectedService = (): void => {
      store.set(claudeKeychainService(env.CLAUDE_CONFIG_DIR), BLANK);
    };
    if (args[0] === '--version' || args[0] === 'doctor') {
      records.inspectionEnvs.push(env);
      if (env.DISABLE_AUTOUPDATER !== '1') migrateSelectedService();
      return args[0] === '--version'
        ? { stderr: '', stdout: `Claude Code ${records.updateCalls > 0 ? '2.1.214' : '2.1.211'}` }
        : { stderr: '', stdout: 'Auto-updates: enabled\nAuto-update channel: latest\n' };
    }
    if (args[0] === 'update') {
      records.updateCalls += 1;
      records.updateEnv = env;
      migrateSelectedService();
      return { stderr: '', stdout: 'updated' };
    }
    throw new Error(`Unexpected Claude command: ${args.join(' ')}`);
  };

  await mkdir(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(activeProfile, { recursive: true });
  await mkdir(updateProfile, { mode: 0o777, recursive: true });
  await writeFile(nativeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(nativeBinary, 0o755);
  await symlink(nativeBinary, claudeCommand);

  try {
    // GREEN BASELINE — drive the REAL ProviderCliService command/env seam (not a copy of its branching).
    const store = seedStore();
    const records = freshRecords();
    const runCommand: ProviderCliCommandRunner = async (_command, args, options) =>
      handle(store, records, args, options?.env ?? {});

    let applied: Awaited<ReturnType<ProviderCliService['apply']>> | undefined;
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
      applied = await service.apply('claude-code');
    });

    // OUTCOME FIRST — the #567 disaster-domain guard, asserted ahead of the mechanism it rests on so
    // a regression reddens HERE (in the Keychain-service domain), not only on the env-shape check the
    // sibling #566 test already owns. Only the throwaway updater service was migrated; the default and
    // active-account service sentinels read back BYTE-UNCHANGED (present controls, proven red-capable
    // by the mutations below).
    assert.equal(store.get(defaultService), SEED[defaultService]);
    assert.equal(store.get(activeService), SEED[activeService]);
    assert.equal(store.get(updateService), BLANK);

    // The mechanism the outcome rests on (also covered by the sibling #566 test):
    assert.equal(applied?.installedVersion, '2.1.214');
    assert.equal(records.updateEnv?.CLAUDE_CONFIG_DIR, updateProfile);
    assert.equal(records.updateEnv?.DISABLE_AUTOUPDATER, '1');
    assert.equal(records.inspectionEnvs.length >= 4, true);
    assert.equal(records.inspectionEnvs.every((e) => e.CLAUDE_CONFIG_DIR === activeProfile), true);
    assert.equal(records.inspectionEnvs.every((e) => e.DISABLE_AUTOUPDATER === '1'), true);

    // MUTATION 1 — remove the dedicated updater profile: `claude update` runs on the real active dir.
    const m1Store = seedStore();
    assert.equal(m1Store.get(activeService), SEED[activeService]); // green before the mutation
    handle(m1Store, freshRecords(), ['update'], {
      CLAUDE_CONFIG_DIR: activeProfile,
      DISABLE_AUTOUPDATER: '1',
      HOME: home,
    });
    assert.equal(m1Store.get(activeService), BLANK); // RED: a de-isolated update blanks the real service
    assert.equal(m1Store.get(defaultService), SEED[defaultService]);

    // MUTATION 2 — remove observational inspect wiring: `--version` runs without DISABLE_AUTOUPDATER.
    const m2Store = seedStore();
    const m2Records = freshRecords();
    assert.equal(m2Store.get(activeService), SEED[activeService]); // green before the mutation
    // Observational control: WITH the flag, inspecting the real profile leaves its service intact...
    handle(m2Store, m2Records, ['--version'], {
      CLAUDE_CONFIG_DIR: activeProfile,
      DISABLE_AUTOUPDATER: '1',
      HOME: home,
    });
    assert.equal(m2Store.get(activeService), SEED[activeService]);
    // ...WITHOUT the flag, the auto-updater migration blanks the real service.
    handle(m2Store, m2Records, ['--version'], { CLAUDE_CONFIG_DIR: activeProfile, HOME: home });
    assert.equal(m2Store.get(activeService), BLANK); // RED for the intended reason
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
          const version = url.includes('claude')
            ? '2.1.0'
            : url.includes('%40openai')
              ? '1.2.0'
              : url.includes('opencode-ai')
                ? '1.18.4'
                : url.includes('%40earendil-works')
                  ? '0.84.3'
                  : '0.24.0';
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
        ['2.1.0', '1.2.0', '0.24.0', undefined, '1.18.4', '0.84.3'],
      );
      assert.match(first.providers[3]?.checkError?.message ?? '', /grok/i);
      round = 1;
      const second = await service.checkNow();
      assert.equal(second.providers[0]?.latestVersion, '2.1.0');
      assert.equal(second.providers[0]?.checkError, undefined);
      assert.match(second.providers[1]?.checkError?.message ?? '', /429.*retry after 60/);
      assert.equal(second.providers[2]?.latestVersion, '0.24.0');
      assert.match(second.providers[3]?.checkError?.message ?? '', /grok/i);
      assert.match(second.providers[4]?.checkError?.message ?? '', /429.*retry after 60/);
      assert.match(second.providers[5]?.checkError?.message ?? '', /429.*retry after 60/);
      assert.equal(conditionalHeaders.includes('"2.1.0"'), true);
      assert.equal(conditionalHeaders.includes('"1.2.0"'), true);
      assert.equal(conditionalHeaders.includes('"0.24.0"'), true);
      assert.equal(conditionalHeaders.includes('"1.18.4"'), true);
      assert.equal(conditionalHeaders.includes('"0.84.3"'), true);
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

test('pi installed as a global npm package is managed through the npm paired with its prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-cli-pi-'));
  const prefix = join(root, 'active-prefix');
  const binDir = join(prefix, 'bin');
  const packageDir = join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const piScript = join(packageDir, 'dist', 'bundle', 'cli.js');
  const piCommand = join(binDir, 'pi');
  const npmCommand = join(binDir, 'npm');
  try {
    await mkdir(join(packageDir, 'dist', 'bundle'), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(piScript, '// fake pi\n', 'utf8');
    await chmod(piScript, 0o755);
    await writeFile(npmCommand, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(npmCommand, 0o755);
    await symlink(piScript, piCommand);
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.84.3' }),
      'utf8',
    );
    const resolvedPrefix = await realpath(prefix);
    const resolvedNpmCommand = join(resolvedPrefix, 'bin', 'npm');
    const runCommand: ProviderCliCommandRunner = async (command, args) => {
      if (command === piCommand && args[0] === '--version') return { stderr: '', stdout: '0.84.3' };
      if (command === resolvedNpmCommand && args.join(' ') === 'prefix -g') {
        return { stderr: '', stdout: resolvedPrefix };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    const inspection = await inspectProvider('pi', { PATH: binDir }, runCommand);
    assert.equal(inspection.installSource, 'pi-npm-global');
    assert.equal(inspection.installedVersion, '0.84.3');
    assert.equal(inspection.updateMode, 'managed');
    assert.equal(inspection.npmPrefix, resolvedPrefix);
    assert.deepEqual(inspection.updateCommand, {
      args: ['install', '-g', '@earendil-works/pi-coding-agent@{targetVersion}'],
      command: resolvedNpmCommand,
    });
    assert.equal(
      inspection.restoreCommand,
      `'${resolvedNpmCommand}' install -g @earendil-works/pi-coding-agent@0.84.3`,
    );

    // A pi that does not live in a global npm prefix stays manual.
    const looseDir = join(root, 'loose');
    await mkdir(looseDir, { recursive: true });
    const loosePi = join(looseDir, 'pi');
    await writeFile(loosePi, '#!/bin/sh\necho 0.84.3\n', 'utf8');
    await chmod(loosePi, 0o755);
    const loose = await inspectProvider('pi', { PATH: looseDir }, async (command, args) => {
      if (command === loosePi && args[0] === '--version') return { stderr: '', stdout: '0.84.3' };
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });
    assert.equal(loose.installSource, 'unknown');
    assert.equal(loose.updateMode, 'manual');
    assert.equal(loose.manualCommand, 'npm install -g @earendil-works/pi-coding-agent@latest');
    assert.match(String(loose.sourceDetail), /not a recognized global npm install/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
