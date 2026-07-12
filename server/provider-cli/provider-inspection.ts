import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

import { PROVIDER_CATALOG, type ProviderKind } from '../../shared/provider-catalog.js';
import { errorMessage } from '../ids.js';
import type { ProviderCliCommandRunner, ProviderInspection, ResolvedExecutable } from './types.js';

const CHECK_TIMEOUT_MS = 10_000;

export async function inspectProvider(
  provider: ProviderKind,
  env: NodeJS.ProcessEnv,
  runCommand: ProviderCliCommandRunner,
): Promise<ProviderInspection> {
  const catalog = PROVIDER_CATALOG.find((entry) => entry.kind === provider);
  if (!catalog) throw new Error(`Unknown provider ${provider}`);
  const executable = await resolveExecutable(catalog.command, env);
  if (!executable) {
    return {
      installSource: 'unknown',
      label: catalog.label,
      provider,
      sourceDetail: `${catalog.command} was not found on PATH`,
      updateMode: 'unavailable',
    };
  }
  let installedVersion: string;
  try {
    installedVersion = await commandVersion(
      executable.path,
      runCommand,
      env,
      provider === 'grok-cli' ? ['--no-auto-update', '--version'] : undefined,
    );
  } catch (error) {
    return {
      binaryPath: executable.path,
      installSource: 'unknown',
      label: catalog.label,
      manualCommand: manualCommandFor(provider),
      provider,
      realPath: executable.realPath,
      sourceDetail: `The active ${catalog.command} version could not be verified: ${errorMessage(error)}`,
      updateMode: 'manual',
    };
  }
  if (executable.shadowed) {
    return {
      binaryPath: executable.path,
      installSource: 'unknown',
      installedVersion,
      label: catalog.label,
      manualCommand: manualCommandFor(provider),
      provider,
      realPath: executable.realPath,
      sourceDetail: `Multiple ${catalog.command} installations resolve to different files on PATH`,
      updateMode: 'manual',
    };
  }
  if (provider === 'claude-code') {
    return inspectClaude(executable, installedVersion, catalog.label, env, runCommand);
  }
  if (provider === 'codex-cli') {
    return inspectCodex(executable, installedVersion, catalog.label, env, runCommand);
  }
  if (provider === 'kimi-cli') {
    return inspectKimi(executable, installedVersion, catalog.label, env);
  }
  return inspectGrok(executable, installedVersion, catalog.label, env, runCommand);
}

async function inspectClaude(
  executable: ResolvedExecutable,
  installedVersion: string,
  label: string,
  env: NodeJS.ProcessEnv,
  runCommand: ProviderCliCommandRunner,
): Promise<ProviderInspection> {
  const native = /[/\\]\.local[/\\]share[/\\]claude[/\\]versions[/\\][^/\\]+$/.test(executable.realPath);
  if (!native) {
    return {
      binaryPath: executable.path,
      installSource: 'unknown',
      installedVersion,
      label,
      manualCommand: 'claude update',
      provider: 'claude-code',
      realPath: executable.realPath,
      sourceDetail: 'The active Claude Code binary is not a recognized native install',
      updateMode: 'manual',
    };
  }
  const doctor = await runCommand(executable.path, ['doctor'], {
    env,
    timeout: 30_000,
  })
    .then(({ stdout, stderr }) => `${stdout}\n${stderr}`)
    .catch(() => '');
  const autoUpdates = doctor.match(/^Auto-updates:\s+(enabled|disabled)$/m)?.[1];
  const channel = doctor.match(/^Auto-update channel:\s+(.+)$/m)?.[1]?.trim();
  return {
    ...(channel ? { autoUpdateChannel: channel } : {}),
    ...(autoUpdates ? { autoUpdatesEnabled: autoUpdates === 'enabled' } : {}),
    binaryPath: executable.path,
    installSource: 'claude-native',
    installedVersion,
    label,
    provider: 'claude-code',
    realPath: executable.realPath,
    restoreCommand: `curl -fsSL https://claude.ai/install.sh | bash -s ${installedVersion}`,
    sourceDetail: 'Native install',
    updateCommand: { args: ['update'], command: executable.path },
    updateMode: 'managed',
  };
}

async function inspectCodex(
  executable: ResolvedExecutable,
  installedVersion: string,
  label: string,
  env: NodeJS.ProcessEnv,
  runCommand: ProviderCliCommandRunner,
): Promise<ProviderInspection> {
  const suffix = join('lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!executable.realPath.endsWith(suffix)) {
    return {
      binaryPath: executable.path,
      installSource: 'unknown',
      installedVersion,
      label,
      manualCommand: 'npm install -g @openai/codex@latest',
      provider: 'codex-cli',
      realPath: executable.realPath,
      sourceDetail: 'The active Codex binary is not a recognized global npm install',
      updateMode: 'manual',
    };
  }
  const prefix = executable.realPath.slice(0, -suffix.length).replace(/[/\\]$/, '');
  const packageDir = join(prefix, 'lib', 'node_modules', '@openai', 'codex');
  const npmPath = join(prefix, 'bin', 'npm');
  const packageJson = await readFile(join(packageDir, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text) as { name?: unknown; version?: unknown })
    .catch(() => undefined);
  const packageMatches = packageJson?.name === '@openai/codex' && packageJson.version === installedVersion;
  const npmPrefix = await runCommand(npmPath, ['prefix', '-g'], {
    env,
    timeout: CHECK_TIMEOUT_MS,
  })
    .then(({ stdout }) => resolve(stdout.trim()))
    .catch(() => undefined);
  const writable = await Promise.all([
    isAccessible(join(prefix, 'lib', 'node_modules'), constants.W_OK),
    isAccessible(dirname(packageDir), constants.W_OK),
    isAccessible(packageDir, constants.W_OK),
    isAccessible(npmPath, constants.X_OK),
  ]).then((results) => results.every(Boolean));
  const managed = packageMatches && npmPrefix === resolve(prefix) && writable;
  const quotedNpm = shellQuote(npmPath);
  return {
    binaryPath: executable.path,
    installSource: 'codex-npm-global',
    installedVersion,
    label,
    manualCommand: `${quotedNpm} install -g @openai/codex@latest`,
    ...(npmPrefix ? { npmPath, npmPrefix } : {}),
    provider: 'codex-cli',
    realPath: executable.realPath,
    restoreCommand: `${quotedNpm} install -g @openai/codex@${installedVersion}`,
    sourceDetail: managed
      ? `Global npm install in ${prefix}`
      : npmPrefix && npmPrefix !== resolve(prefix)
        ? `Active package is in ${prefix}, but its npm reports ${npmPrefix}`
        : !writable
          ? `Global npm prefix ${prefix} is not writable without elevation`
          : 'Active npm package metadata could not be verified',
    ...(managed
      ? {
          updateCommand: {
            args: ['install', '-g', '@openai/codex@{targetVersion}'],
            command: npmPath,
          },
        }
      : {}),
    updateMode: managed ? 'managed' : 'manual',
  };
}

function inspectKimi(
  executable: ResolvedExecutable,
  installedVersion: string,
  label: string,
  env: NodeJS.ProcessEnv,
): ProviderInspection {
  const nativePath = join(env.HOME?.trim() || homedir(), '.kimi-code', 'bin', 'kimi');
  const native = executable.realPath === nativePath;
  return {
    binaryPath: executable.path,
    installSource: native ? 'kimi-native' : 'unknown',
    installedVersion,
    label,
    manualCommand: 'kimi upgrade',
    provider: 'kimi-cli',
    realPath: executable.realPath,
    sourceDetail: native
      ? 'Native ~/.kimi-code install; official updater is interactive'
      : 'The active Kimi binary is not a recognized native install',
    updateMode: 'manual',
  };
}

async function inspectGrok(
  executable: ResolvedExecutable,
  installedVersion: string,
  label: string,
  env: NodeJS.ProcessEnv,
  runCommand: ProviderCliCommandRunner,
): Promise<ProviderInspection> {
  const grokHome = resolve(env.GROK_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.grok'));
  const resolvedGrokHome = await realpath(grokHome).catch(() => grokHome);
  const downloads = join(resolvedGrokHome, 'downloads');
  const native = executable.realPath.startsWith(`${downloads}/`);
  const check = await runCommand(executable.path, ['update', '--check', '--json'], {
    env,
    timeout: CHECK_TIMEOUT_MS,
  })
    .then(({ stdout }) => JSON.parse(stdout) as Record<string, unknown>)
    .catch(() => undefined);
  const channel = typeof check?.['channel'] === 'string' ? check['channel'] : undefined;
  const autoUpdate = typeof check?.['autoUpdate'] === 'boolean' ? check['autoUpdate'] : undefined;
  return {
    ...(channel ? { autoUpdateChannel: channel } : {}),
    ...(autoUpdate !== undefined ? { autoUpdatesEnabled: autoUpdate } : {}),
    binaryPath: executable.path,
    installSource: native ? 'grok-native' : 'unknown',
    installedVersion,
    label,
    manualCommand: 'grok update',
    provider: 'grok-cli',
    realPath: executable.realPath,
    restoreCommand: `grok update --version ${installedVersion}`,
    sourceDetail: native ? `Native ${grokHome} install` : 'The active Grok binary is not a recognized native install',
    ...(native
      ? {
          updateCommand: {
            args: ['update', '--version', '{targetVersion}'],
            command: executable.path,
          },
        }
      : {}),
    updateMode: native ? 'managed' : 'manual',
  };
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<ResolvedExecutable | undefined> {
  const candidates: Array<{ path: string; realPath: string }> = [];
  const seenPaths = new Set<string>();
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (!entry) continue;
    const path = resolve(entry, command);
    if (seenPaths.has(path) || !(await isAccessible(path, constants.X_OK))) continue;
    seenPaths.add(path);
    candidates.push({ path, realPath: await realpath(path).catch(() => path) });
  }
  const first = candidates[0];
  if (!first) return undefined;
  return {
    ...first,
    shadowed: new Set(candidates.map((candidate) => candidate.realPath)).size > 1,
  };
}

async function commandVersion(
  command: string,
  runCommand: ProviderCliCommandRunner,
  env: NodeJS.ProcessEnv,
  args = ['--version'],
): Promise<string> {
  const { stdout, stderr } = await runCommand(command, args, {
    env,
    timeout: CHECK_TIMEOUT_MS,
  });
  const output = `${stdout}\n${stderr}`;
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  if (!match?.[1])
    throw Object.assign(new Error(`Unable to parse version from ${command}`), {
      code: 'PARSE',
    });
  return match[1];
}

function manualCommandFor(provider: ProviderKind): string {
  if (provider === 'claude-code') return 'claude update';
  if (provider === 'codex-cli') return 'npm install -g @openai/codex@latest';
  if (provider === 'kimi-cli') return 'kimi upgrade';
  return 'grok update';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function isAccessible(path: string, mode: number): Promise<boolean> {
  return access(path, mode).then(
    () => true,
    () => false,
  );
}
