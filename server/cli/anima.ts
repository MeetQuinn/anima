#!/usr/bin/env node
import { Command } from 'commander';

import { errorMessage } from '../ids.js';
import { registerAskCommands } from '../tools/ask.js';
import { registerEnvCommands } from '../tools/env-cli.js';
import { registerReminderCommands } from '../reminders/cli.js';
import { registerFileCommands } from '../tools/files-cli.js';
import { registerMessageHistoryCommands } from '../tools/message-history-cli.js';
import { registerMessageCommands } from '../tools/messages-cli.js';
import { registerReactionCommands } from '../tools/reactions-cli.js';
import { registerSubscriptionCommands } from '../tools/subscriptions-cli.js';

async function main(): Promise<void> {
  await createCliProgram().parseAsync(process.argv);
}

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name('anima')
    .description('Agent-facing Anima tools')
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true });

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
  console.error(errorMessage(error));
  process.exitCode = 1;
});
