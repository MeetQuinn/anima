import type { Command } from 'commander';
import { z } from 'zod';

import { readStdin } from './tool-context.js';
import { runRelayList, runRelaySend } from './relay.js';

const SendSchema = z.object({
  agent: z.string().optional(),
  message: z.string().optional(),
  replyTo: z.string().optional(),
  to: z.string().min(1, 'Missing --to <agentId>'),
});

const ListSchema = z.object({
  agent: z.string().optional(),
});

export function registerRelayCommands(program: Command): void {
  const relay = program
    .command('relay')
    .description('Send and list local agent-to-agent messages (no chat platform; local record only, shown in the dashboard log).');

  // Input:   anima relay send --to <agentId> [--message <text> | stdin] [--reply-to <messageId>]
  // Output:  relayed successfully. to=<id> (<name>), message_id=<id>.
  // Failure: human-readable error to stderr; exit 1.
  relay
    .command('send')
    .description('Send a local message to another agent in this Anima home.')
    .option('--to <agentId>', 'target agent id (see `anima relay list`)')
    .option('--message <text>', 'message body; or omit and pipe via stdin')
    .option('--reply-to <messageId>', 'message id this message is replying to')
    .addHelpText('after', '\nExamples:\n' +
      '  anima relay send --to milo --message "can you review PR #128?"\n' +
      '  anima relay send --to nora --reply-to agent_msg:milo:nora:m_abc --message "done"')
    .action(async (_, command) => {
      const opts = SendSchema.parse(command.optsWithGlobals());
      const text = opts.message ?? (await readStdin());
      if (!text.trim()) throw new Error('Empty message. Pass --message <text> or pipe via stdin.');
      await runRelaySend({
        text,
        to: opts.to,
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      });
    });

  // Input:   anima relay list
  // Output:  one line per reachable agent: <id> (<displayName>)[ — <role>]
  // Failure: human-readable error to stderr; exit 1.
  relay
    .command('list')
    .description('List other local agents you can relay to.')
    .action(async (_, command) => {
      const opts = ListSchema.parse(command.optsWithGlobals());
      await runRelayList({ ...(opts.agent ? { agent: opts.agent } : {}) });
    });
}
