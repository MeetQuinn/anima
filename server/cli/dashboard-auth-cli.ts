import type { Command } from 'commander';

import { withAnimaHome } from '../anima-home.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { resolveManagedAnimaHome } from '../runtime-management/managed-runtime.js';
import { ensureAnimaHome } from '../storage/write-root.js';

interface DashboardAuthCliOptions {
  passwordStdin?: boolean;
  sessionTtlHours?: number;
}

export function registerDashboardAuthCommand(program: Command, options: { managedRuntimeHome?: boolean } = {}): void {
  const command = program
    .command('dashboard-auth')
    .description('Configure password protection for the Anima dashboard');

  command
    .command('status')
    .description('Show dashboard password protection status')
    .action(async () => {
      await withDashboardAuthHome(options, async () => {
        const status = await defaultDashboardAuthService.status();
        console.log(`dashboardAuth: ${status.enabled ? 'enabled' : 'disabled'}`);
        if (status.enabled) console.log(`sessionTtlHours: ${status.sessionTtlHours}`);
      });
    });

  command
    .command('set')
    .description('Enable dashboard password protection')
    .requiredOption('--password-stdin', 'Read the password from stdin')
    .option('--session-ttl-hours <hours>', 'Session duration in hours', parsePositiveInteger)
    .action(async (commandOptions: DashboardAuthCliOptions) => {
      if (!commandOptions.passwordStdin) throw new Error('--password-stdin is required');
      const password = await readPasswordFromStdin();
      await withDashboardAuthHome(options, async () => {
        // Configuring auth on a machine that has never run the server is a
        // legitimate first act, so provision the home deliberately here. Writes
        // themselves never create it (see storage/write-root.ts).
        await ensureAnimaHome();
        const result = await defaultDashboardAuthService.setPassword(password, {
          sessionTtlHours: commandOptions.sessionTtlHours,
        });
        console.log('dashboardAuth: enabled');
        console.log(`sessionTtlHours: ${result.sessionTtlHours}`);
      });
    });

  command
    .command('disable')
    .description('Disable dashboard password protection')
    .action(async () => {
      await withDashboardAuthHome(options, async () => {
        await ensureAnimaHome();
        await defaultDashboardAuthService.disable();
        console.log('dashboardAuth: disabled');
      });
    });
}

async function withDashboardAuthHome<T>(options: { managedRuntimeHome?: boolean }, body: () => Promise<T>): Promise<T> {
  return options.managedRuntimeHome ? withAnimaHome(resolveManagedAnimaHome(), body) : body();
}

async function readPasswordFromStdin(): Promise<string> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input.replace(/\r?\n$/, '');
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('value must be a positive integer');
  return parsed;
}
