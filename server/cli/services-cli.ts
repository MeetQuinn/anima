import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';

import type { Command } from 'commander';

import { defaultServerSettingsService } from '../settings/settings.service.js';
import { resolveAnimaHome } from '../anima-home.js';
import {
  clearRestartDrain,
} from '../services/restart-drain.js';
import {
  DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
  DEFAULT_RESTART_IDLE_TIMEOUT_MS,
  listRestartBlockers,
  RestartBlockedError,
  type RestartDrainResult,
  restartBlockedError,
  waitForRestartDrain,
  waitForRestartIdle,
} from '../services/restart-gate.js';
import {
  blockedServicesRestartResult,
  idleServicesRestartResult,
  type ServicesRestartResultDraft,
  writeServicesRestartResult,
} from '../services/restart-result.js';
import {
  isServiceRunning,
  printStatus,
  startService,
  stopService,
  type ServiceSpec,
  type SupervisorOptions,
} from '../services/supervisor.js';
import type { GlobalCliOptions } from './shared.js';

const DEFAULT_DASHBOARD_PORT = 4174;
type ServiceId = 'agent' | 'web';
type ServicesCliOptions = GlobalCliOptions & {
  drainActive?: boolean;
  drainTimeoutMs?: number;
  force?: boolean;
  idleTimeoutMs?: number;
  only?: ServiceId;
  resumeRunning?: boolean;
};

export function registerServicesCommand(program: Command): void {
  const services = program
    .command('services')
    .description('Supervise the agent and web daemons for this environment');

  services
    .command('start')
    .description('Start the agent and web app as background processes')
    .option('--only <service>', 'Start only one service: agent or web')
    .action(async (_, command) => {
      const opts = command.optsWithGlobals() as ServicesCliOptions;
      await runStart(opts);
    });

  services
    .command('stop')
    .description('Stop the agent and web app background processes')
    .option('--only <service>', 'Stop only one service: agent or web')
    .action(async (_, command) => {
      const opts = command.optsWithGlobals() as ServicesCliOptions;
      await runStop(opts);
    });

  services
    .command('restart')
    .description('Stop and start the agent and web app background processes')
    .option('--only <service>', 'Restart only one service: agent or web')
    .option('--drain-active', 'Drain running agents to a safe boundary before restart')
    .option(
      '--drain-timeout-ms <ms>',
      'How long to wait for running agents to reach a drain point',
      parseNonNegativeInteger,
      DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
    )
    .option('--force', 'Restart even if agent inboxes are running or queued')
    .option(
      '--idle-timeout-ms <ms>',
      'How long to wait for agent inboxes to become idle before failing',
      parseNonNegativeInteger,
      DEFAULT_RESTART_IDLE_TIMEOUT_MS,
    )
    .option('--resume-running', 'Resume drained running agents after restart')
    .action(async (_, command) => {
      const opts = command.optsWithGlobals() as ServicesCliOptions;
      await runRestart(opts);
    });

  services
    .command('status')
    .description('Report the agent and web app daemon status')
    .option('--only <service>', 'Show only one service: agent or web')
    .action(async (_, command) => {
      const opts = command.optsWithGlobals() as ServicesCliOptions;
      await runStatus(opts);
    });

  services
    .command('dashboard')
    .description('Launch the local Anima dashboard')
    .action(async (_, command) => {
      const opts = command.optsWithGlobals() as ServicesCliOptions;
      await runDashboard(opts);
    });
}

async function runStart(opts: ServicesCliOptions): Promise<void> {
  const { specs, supervisor } = await resolveServices(opts);
  for (const spec of specs) await startService(spec, supervisor);
  await printStatus(specs);
  printDashboardHint(specs);
}

async function runStop(opts: ServicesCliOptions): Promise<void> {
  const { specs } = await resolveServices(opts);
  assertCanControlServices(specs);
  for (const spec of specs) await stopService(spec);
  await printStatus(specs);
}

async function runRestart(opts: ServicesCliOptions): Promise<void> {
  validateRestartDrainOptions(opts);
  const { specs, supervisor } = await resolveServices(opts);
  assertCanControlServices(specs);
  let gate: RestartGateLease | undefined;
  let stopped = false;
  try {
    gate = await prepareRestartGate(specs, opts);
    for (const spec of specs) await stopService(spec);
    stopped = true;
    await gate.beforeStart();
    for (const spec of specs) await startService(spec, supervisor);
    await printStatus(specs);
    printDashboardHint(specs);
    await writeRestartResult(gate.result);
    if (gate.drainResult?.resumedCount) {
      console.log(`restart: ${gate.drainResult.resumedCount} agent item(s) resumed after restart`);
    }
  } catch (error) {
    if (error instanceof RestartBlockedError) {
      await writeRestartResult(blockedServicesRestartResult(error));
    }
    throw error;
  } finally {
    if (!stopped) await gate?.cleanup();
  }
}

async function runStatus(opts: ServicesCliOptions): Promise<void> {
  const { specs } = await resolveServices(opts);
  await printStatus(specs);
  printDashboardHint(specs);
}

async function runDashboard(opts: ServicesCliOptions): Promise<void> {
  const { specs } = await resolveServices(opts);
  const url = dashboardUrl(specs);
  if (!url) throw new Error('No web service URL is configured.');
  console.log(`Dashboard: ${url}`);
  await launchDashboard(url);
}

async function resolveServices(opts: ServicesCliOptions): Promise<{ specs: ServiceSpec[]; supervisor: SupervisorOptions }> {
  const animaHome = resolveAnimaHome();
  const { host: dashboardHost, port: dashboardPort } = await defaultServerSettingsService.getDashboardSettings({
    defaultHost: '0.0.0.0',
    defaultPort: DEFAULT_DASHBOARD_PORT,
  });
  // For the status URL display: 0.0.0.0 means all interfaces, show 127.0.0.1 for local access.
  const dashboardDisplayHost = dashboardHost === '0.0.0.0' ? '127.0.0.1' : dashboardHost;

  const allSpecs: ServiceSpec[] = [
    {
      args: ['server'],
      animaHome,
      id: 'agent',
      logName: 'agent.log',
      matchAny: [' server'],
    },
    {
      args: ['web', '--host', dashboardHost, '--port', String(dashboardPort)],
      animaHome,
      id: 'web',
      legacyIds: ['ui'],
      logName: 'web.log',
      matchAny: [' web ', ' ui '],
      url: `http://${dashboardDisplayHost}:${dashboardPort}`,
    },
  ];
  if (opts.only && opts.only !== 'agent' && opts.only !== 'web') {
    throw new Error('--only must be "agent" or "web"');
  }
  const specs = opts.only ? allSpecs.filter((spec) => spec.id === opts.only) : allSpecs;

  const animactl = fileURLToPath(new URL('./animactl.js', import.meta.url));
  const cwd = process.cwd();
  return { specs, supervisor: { animactl, cwd } };
}

function printDashboardHint(specs: ServiceSpec[]): void {
  const url = dashboardUrl(specs);
  if (url) console.log(`Dashboard: ${url}`);
}

function dashboardUrl(specs: ServiceSpec[]): string | undefined {
  return specs.find((spec) => spec.id === 'web')?.url;
}

async function launchDashboard(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  await new Promise<void>((resolveOpen, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveOpen();
    });
  });
}

function assertCanControlServices(specs: ServiceSpec[]): void {
  if (!specs.some((spec) => spec.id === 'agent')) return;
  const isRuntimeItem = Boolean(process.env.ANIMA_INBOX_ITEM_ID || process.env.ANIMA_AGENT_ID);
  if (!isRuntimeItem) return;

  const runtimeHome = process.env.ANIMA_RUNTIME_HOME;
  if (runtimeHome && resolvePath(runtimeHome) !== resolvePath(resolveAnimaHome())) return;

  throw new Error(
    'Refusing to stop or restart the agent service from inside its own active runtime. '
      + 'Use an external shell or idle-gated restart for full restarts, or pass --only web for web-only reloads.',
  );
}

interface RestartGateLease {
  beforeStart(): Promise<void>;
  cleanup(): Promise<void>;
  drainResult?: RestartDrainResult;
  result: ServicesRestartResultDraft;
}

async function prepareRestartGate(specs: ServiceSpec[], opts: ServicesCliOptions): Promise<RestartGateLease> {
  const agentSpec = specs.find((spec) => spec.id === 'agent');
  const noop = {
    beforeStart: async () => {},
    cleanup: async () => {},
    result: idleServicesRestartResult(),
  };
  if (!agentSpec || opts.force || !(await isServiceRunning(agentSpec))) return noop;

  if (opts.drainActive || opts.resumeRunning) {
    const drainResult = await waitForRestartDrain({
      drainTimeoutMs: opts.drainTimeoutMs ?? DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
      markerTtlMs: (opts.drainTimeoutMs ?? DEFAULT_RESTART_DRAIN_TIMEOUT_MS) + 60_000,
    });
    return {
      beforeStart: clearRestartDrain,
      cleanup: clearRestartDrain,
      drainResult,
      result: drainResult,
    };
  }

  await waitForRestartIdle(opts.idleTimeoutMs ?? DEFAULT_RESTART_IDLE_TIMEOUT_MS);

  const finalBlockers = await listRestartBlockers();
  if (finalBlockers.length > 0) {
    throw restartBlockedError(finalBlockers, 'Agents became busy before restart.', 'became_busy');
  }
  return noop;
}

function validateRestartDrainOptions(opts: ServicesCliOptions): void {
  if ((opts.drainActive || opts.resumeRunning) && (!opts.drainActive || !opts.resumeRunning)) {
    throw new Error('--drain-active and --resume-running must be used together');
  }
}

async function writeRestartResult(result: ServicesRestartResultDraft): Promise<void> {
  const resultPath = process.env.ANIMA_RESTART_RESULT_FILE;
  if (!resultPath) return;
  await writeServicesRestartResult(resultPath, result);
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('timeout must be a non-negative integer');
  }
  return parsed;
}
