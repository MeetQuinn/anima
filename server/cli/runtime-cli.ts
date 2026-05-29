import type { Command } from 'commander';
import { spawn } from 'node:child_process';

import { withAnimaHome } from '../anima-home.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import {
  DEFAULT_RUNTIME_PACKAGE,
  currentRuntimePackageInfo,
  ensureManagedRuntime,
  installManagedRuntime,
  readManagedRuntimeStatus,
  resolveManagedAnimaHome,
  type RuntimeInstallOptions,
  type RuntimeStatus,
} from '../runtime/managed-runtime.js';
import {
  RuntimeUpgradeService,
  runRuntimeUpgradeWorker,
  type RuntimeUpgradeWorkerOptions,
} from '../runtime/runtime-upgrade.js';
import { RuntimeReleaseTrack, type RuntimeUpgradeStatusResponse } from '../../shared/runtime-upgrade.js';

interface RuntimeCliOptions {
  channel?: string;
  dashboardHost?: string;
  dashboardPort?: number;
  drainTimeoutMs?: number;
  force?: boolean;
  idleTimeoutMs?: number;
  logPath?: string;
  npm?: string;
  only?: 'agent' | 'web';
  packageName?: string;
  previousStartedAt?: string;
  previousVersion?: string;
  releaseTrack?: string;
  runtimeDir?: string;
  skipInstall?: boolean;
  targetVersion?: string;
  version?: string;
  verifyTimeoutMs?: number;
}

type ServiceCommand = 'restart' | 'start' | 'status' | 'stop';

export function registerRuntimeCommand(program: Command): void {
  const runtime = program
    .command('runtime')
    .description('Manage the local npm-installed Anima runtime');
  registerRuntimeCommands(runtime, { topLevel: false });
}

export function registerTopLevelRuntimeCommands(program: Command): void {
  program
    .description('Control the local npm-installed Anima runtime')
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true });
  registerRuntimeCommands(program, { topLevel: true });
}

function registerRuntimeCommands(program: Command, options: { topLevel: boolean }): void {
  program
    .command('install')
    .description('Install Anima into the managed runtime directory')
    .option('--channel <tag>', 'npm dist-tag to install, for example latest or canary')
    .option('--version <version>', 'exact package version to install')
    .option('--runtime-dir <path>', 'runtime directory (default: ~/.anima/runtime/current)')
    .option('--package-name <name>', 'npm package name to install', DEFAULT_RUNTIME_PACKAGE)
    .option('--npm <command>', 'npm command to use', 'npm')
    .action(async (options: RuntimeCliOptions) => {
      const result = await installManagedRuntime(runtimeInstallOptions(options, { defaultChannel: 'latest' }));
      printInstallResult(result.metadata.version, result.metadata.specifier, result.paths.runtimeDir, result.installed);
    });

  const statusCommand = program
    .command('status')
    .description(options.topLevel ? 'Show managed runtime and local service status' : 'Show the managed runtime installation status')
    .option('--runtime-dir <path>', 'runtime directory (default: ~/.anima/runtime/current)')
    .option('--package-name <name>', 'npm package name to inspect', DEFAULT_RUNTIME_PACKAGE);
  statusCommand.action(async (commandOptions: RuntimeCliOptions) => {
    if (options.topLevel) {
      await runManagedServiceCommand('status', commandOptions);
      return;
    }
    const status = await readManagedRuntimeStatus({
      packageName: commandOptions.packageName,
      runtimeDir: commandOptions.runtimeDir,
    });
    printRuntimeStatus(status);
    if (!status.installed) process.exitCode = 1;
  });

  if (options.topLevel) {
    program
      .command('runtime-status')
      .description('Show only the managed runtime installation status')
      .option('--runtime-dir <path>', 'runtime directory (default: ~/.anima/runtime/current)')
      .option('--package-name <name>', 'npm package name to inspect', DEFAULT_RUNTIME_PACKAGE)
      .action(async (commandOptions: RuntimeCliOptions) => {
        const status = await readManagedRuntimeStatus({
          packageName: commandOptions.packageName,
          runtimeDir: commandOptions.runtimeDir,
        });
        printRuntimeStatus(status);
        if (!status.installed) process.exitCode = 1;
      });
  }

  program
    .command('upgrade-status')
    .description('Check whether the managed runtime has an available update')
    .action(async () => {
      await withRuntimeHome(options.topLevel, async () => {
        printUpgradeStatus(await new RuntimeUpgradeService().status());
      });
    });

  program
    .command('release-track')
    .description('Show or set the hidden operator release track: stable or canary')
    .argument('[track]', 'stable or canary')
    .action(async (track: string | undefined) => {
      await withRuntimeHome(options.topLevel, async () => {
        if (track === undefined) {
          console.log(`releaseTrack: ${await defaultServerSettingsService.getReleaseTrack()}`);
          return;
        }
        const parsed = RuntimeReleaseTrack.safeParse(track);
        if (!parsed.success) throw new Error('release track must be "stable" or "canary"');
        console.log(`releaseTrack: ${await defaultServerSettingsService.setReleaseTrack(parsed.data)}`);
      });
    });

  program
    .command('upgrade-worker')
    .description('Internal detached runtime upgrade worker')
    .requiredOption('--target-version <version>', 'exact runtime version to install')
    .requiredOption('--release-track <track>', 'stable or canary')
    .option('--dashboard-host <host>', 'dashboard host for post-upgrade verification')
    .option('--dashboard-port <port>', 'dashboard port for post-upgrade verification', parsePositiveInteger)
    .option('--idle-timeout-ms <ms>', 'how long to wait for idle agents before failing', parseNonNegativeInteger)
    .option('--log-path <path>', 'upgrade log path')
    .option('--npm <command>', 'npm command to use')
    .option('--package-name <name>', 'npm package name to install', DEFAULT_RUNTIME_PACKAGE)
    .option('--previous-started-at <iso>', 'server startedAt before the upgrade')
    .option('--previous-version <version>', 'version to rollback to on failure')
    .option('--verify-timeout-ms <ms>', 'how long to wait for the upgraded server to verify', parseNonNegativeInteger)
    .action(async (commandOptions: RuntimeCliOptions) => {
      await withRuntimeHome(options.topLevel, async () => {
        await runRuntimeUpgradeWorker(workerOptions(commandOptions));
      });
    });

  serviceCommand(program, 'start', { installable: true })
    .description('Install the managed runtime if needed, then start local Anima services')
    .action(async (options: RuntimeCliOptions) => {
      await runManagedServiceCommand('start', options);
    });

  serviceCommand(program, 'restart', { installable: true })
    .description('Install the managed runtime if needed, then restart local Anima services')
    .option('--drain-timeout-ms <ms>', 'How long to wait for active agents to reach a restart drain point', parseNonNegativeInteger)
    .option('--force', 'Restart even if agent inboxes are running or queued')
    .option('--idle-timeout-ms <ms>', 'How long to wait for idle agents before failing', parseNonNegativeInteger)
    .action(async (options: RuntimeCliOptions) => {
      await runManagedServiceCommand('restart', options);
    });

  serviceCommand(program, 'stop')
    .description('Stop local Anima services from the managed runtime')
    .action(async (options: RuntimeCliOptions) => {
      await runManagedServiceCommand('stop', options);
    });

  if (!options.topLevel) {
    serviceCommand(program, 'service-status')
      .description('Show managed runtime and local service status')
      .action(async (commandOptions: RuntimeCliOptions) => {
        await runManagedServiceCommand('status', commandOptions);
      });
  }
}

export function runtimeInstallOptions(
  options: RuntimeCliOptions,
  defaults: { defaultChannel?: string; defaultVersion?: string } = {},
): RuntimeInstallOptions {
  return {
    channel: options.version ? undefined : options.channel ?? defaults.defaultChannel,
    npmCommand: options.npm,
    packageName: options.packageName,
    runtimeDir: options.runtimeDir,
    version: options.version ?? defaults.defaultVersion,
  };
}

export function printRuntimeStatus(status: RuntimeStatus): void {
  if (!status.installed) {
    console.log('runtime: not installed');
    console.log(`dir: ${status.paths.runtimeDir}`);
    console.log('Run `npx @totoday/animactl start` to install and start the local runtime.');
    return;
  }
  console.log(`runtime: ${status.packageName}@${status.version ?? 'unknown'}`);
  console.log(`dir: ${status.paths.runtimeDir}`);
  console.log(`animactl: ${status.paths.animactlScript}`);
  if (status.metadata) {
    console.log(`requested: ${status.metadata.requested}`);
    console.log(`installedAt: ${status.metadata.installedAt}`);
  }
}

export function printUpgradeStatus(status: RuntimeUpgradeStatusResponse): void {
  console.log(`runtime: ${status.currentVersion}`);
  console.log(`releaseTrack: ${status.releaseTrack}`);
  console.log(`latestOnTrack: ${status.latestOnTrack ?? 'unknown'}`);
  console.log(`update: ${status.updateAvailable ? 'available' : 'none'}`);
  console.log(`checkedAt: ${status.checkedAt}`);
  if (status.checkError) console.log(`checkError: ${status.checkError.type}: ${status.checkError.message}`);
  console.log(`gate: ${status.gate.state}${status.gate.blockers.length ? ` (${status.gate.blockers.length} blockers)` : ''}`);
  if (status.operation.status !== 'idle') {
    const parts = [
      status.operation.status,
      status.operation.targetVersion ? `target=${status.operation.targetVersion}` : undefined,
      status.operation.error ? `error=${JSON.stringify(status.operation.error)}` : undefined,
    ].filter(Boolean);
    console.log(`operation: ${parts.join(' ')}`);
  }
}

function printInstallResult(version: string, specifier: string, runtimeDir: string, installed: boolean): void {
  const action = installed ? 'installed' : 'using';
  console.log(`runtime: ${action} ${specifier} -> ${version}`);
  console.log(`dir: ${runtimeDir}`);
}

function serviceCommand(runtime: Command, name: string, options: { installable?: boolean } = {}): Command {
  const command = runtime
    .command(name)
    .option('--only <service>', 'Limit the service command to agent or web')
    .option('--runtime-dir <path>', 'runtime directory (default: ~/.anima/runtime/current)')
    .option('--package-name <name>', 'npm package name to inspect/use', DEFAULT_RUNTIME_PACKAGE);
  if (options.installable) {
    command
      .option('--npm <command>', 'npm command to use', 'npm')
      .option('--channel <tag>', 'npm dist-tag to install before start/restart, for example latest or canary')
      .option('--version <version>', 'exact package version to install before start/restart')
      .option('--skip-install', 'Use the currently installed runtime without running npm install first');
  }
  return command;
}

async function runManagedServiceCommand(command: ServiceCommand, options: RuntimeCliOptions): Promise<void> {
  assertServiceOptions(options);
  const packageName = options.packageName ?? DEFAULT_RUNTIME_PACKAGE;
  const shouldInstall = (command === 'start' || command === 'restart') && !options.skipInstall;
  const status = shouldInstall
    ? undefined
    : await readManagedRuntimeStatus({ packageName, runtimeDir: options.runtimeDir });

  const paths = shouldInstall
    ? (await installRuntimeForService(options)).paths
    : status?.paths;
  if (!paths) throw new Error('Unable to resolve managed runtime paths.');

  if (!shouldInstall) {
    if (command === 'status' && status) printRuntimeStatus(status);
    if (!status?.installed) {
      process.exitCode = 1;
      return;
    }
  }

  const exitCode = await runAnimactlServices(paths.animactlScript, paths.packageDir, command, options);
  if (exitCode !== 0) process.exitCode = exitCode;
}

async function installRuntimeForService(options: RuntimeCliOptions): Promise<{ paths: RuntimeStatus['paths'] }> {
  const current = await currentRuntimePackageInfo();
  const result = await ensureManagedRuntime(runtimeInstallOptions({
    ...options,
    packageName: options.packageName ?? current.name,
  }, {
    defaultVersion: options.channel ? undefined : current.version,
  }));
  const action = result.installed ? 'installed' : 'using';
  console.log(`runtime: ${action} ${result.metadata.packageName}@${result.metadata.version}`);
  console.log(`dir: ${result.paths.runtimeDir}`);
  return { paths: result.paths };
}

function assertServiceOptions(options: RuntimeCliOptions): void {
  if (options.only && options.only !== 'agent' && options.only !== 'web') {
    throw new Error('--only must be "agent" or "web"');
  }
  if (options.channel && options.version) throw new Error('Choose either --version or --channel, not both.');
}

async function runAnimactlServices(
  animactlScript: string,
  packageDir: string,
  command: ServiceCommand,
  options: RuntimeCliOptions,
): Promise<number> {
  const args = [animactlScript, 'services', command];
  if (options.only) args.push('--only', options.only);
  if (command === 'restart') {
    if (options.force) {
      args.push('--force');
      if (options.idleTimeoutMs !== undefined) args.push('--idle-timeout-ms', String(options.idleTimeoutMs));
    } else {
      args.push('--drain-active', '--resume-running');
      const drainTimeoutMs = options.drainTimeoutMs ?? options.idleTimeoutMs;
      if (drainTimeoutMs !== undefined) args.push('--drain-timeout-ms', String(drainTimeoutMs));
    }
  }

  return new Promise((resolveDone, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: packageDir,
      env: {
        ...process.env,
        ANIMA_HOME: resolveManagedAnimaHome(),
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`animactl services ${command} exited from signal ${signal}`));
      else resolveDone(code ?? 1);
    });
  });
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('value must be a non-negative integer');
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('value must be a positive integer');
  return parsed;
}

function workerOptions(options: RuntimeCliOptions): RuntimeUpgradeWorkerOptions {
  if (!options.targetVersion) throw new Error('--target-version is required');
  const releaseTrack = RuntimeReleaseTrack.parse(options.releaseTrack);
  return {
    ...(options.dashboardHost ? { dashboardHost: options.dashboardHost } : {}),
    ...(options.dashboardPort !== undefined ? { dashboardPort: options.dashboardPort } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.logPath ? { logPath: options.logPath } : {}),
    ...(options.npm ? { npmCommand: options.npm } : {}),
    ...(options.packageName ? { packageName: options.packageName } : {}),
    ...(options.previousStartedAt ? { previousStartedAt: options.previousStartedAt } : {}),
    ...(options.previousVersion ? { previousVersion: options.previousVersion } : {}),
    releaseTrack,
    targetVersion: options.targetVersion,
    ...(options.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: options.verifyTimeoutMs } : {}),
  };
}

function withRuntimeHome<T>(topLevel: boolean, body: () => Promise<T>): Promise<T> {
  return topLevel ? withAnimaHome(resolveManagedAnimaHome(), body) : body();
}
