#!/usr/bin/env node
import { Command } from 'commander';

import { registerAskCommands } from '../tools/ask.js';
import { registerEnvCommands } from '../tools/env-cli.js';
import { registerReminderCommands } from '../reminders/cli.js';
import { registerFileCommands } from '../tools/files-cli.js';
import { registerMessageHistoryCommands } from '../tools/message-history-cli.js';
import { registerMessageCommands } from '../tools/messages-cli.js';
import { registerReactionCommands } from '../tools/reactions-cli.js';
import { registerSubscriptionCommands } from '../tools/subscriptions-cli.js';
import { renderCliError } from './cli-errors.js';

async function main(): Promise<void> {
  await createCliProgram().parseAsync(process.argv);
}

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name('anima')
    .description('Agent-facing Anima tools')
    .exitOverride()
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true })
    .configureOutput({ writeErr: () => undefined });

  registerMessageCommands(program);
  registerMessageHistoryCommands(program);
  registerEnvCommands(program);
  registerReactionCommands(program);
  registerSubscriptionCommands(program);
  registerReminderCommands(program);
  registerFileCommands(program);
  registerAskCommands(program);

  return program;
}

main().catch((error) => {
  const rendered = renderCliError(error);
  if (rendered) {
    console.error(rendered);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
});
