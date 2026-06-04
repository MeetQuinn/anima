#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';

import { errorMessage } from '../ids.js';
import { registerRuntimeCommand } from './runtime-cli.js';
import { registerServiceCommands } from './service.js';
import { registerServicesCommand } from './services-cli.js';

async function main(): Promise<void> {
  await createAdminCliProgram().parseAsync(process.argv);
}

export function createAdminCliProgram(): Command {
  const program = new Command();
  program
    .name('animactl')
    .description('Operate Anima server and web services')
    .version(readAdminCliVersion())
    .option('--agent <id>')
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true });

  registerServiceCommands(program);
  registerServicesCommand(program);
  registerRuntimeCommand(program);

  return program;
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});

function readAdminCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
