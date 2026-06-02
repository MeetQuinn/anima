import type { Command } from 'commander';
import { z } from 'zod';

import { runMessageRead } from './message-read.js';
import { runMessageReact } from './reactions.js';
import {
  runMessageSend,
  runMessageUpdate,
} from './messages.js';

const GlobalFlags = z.object({});

const MessageReadSchema = GlobalFlags.extend({
  after: z.string().optional(),
  around: z.string().optional(),
  before: z.string().optional(),
  channel: z.string().optional(),
  cursor: z.string().optional(),
  inclusive: z.boolean().optional(),
  latest: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  oldest: z.string().optional(),
  threadTs: z.string().optional(),
});

const MessageSendSchema = GlobalFlags.extend({
  channel: z.string().optional(),
  threadTs: z.string().optional(),
});

const MessageUpdateSchema = GlobalFlags.extend({
  channel: z.string().optional(),
  messageTs: z.string().optional(),
});

const MessageReactSchema = GlobalFlags.extend({
  channel: z.string().optional(),
  emoji: z.string().optional(),
  messageTs: z.string().optional(),
  name: z.string().optional(),
  remove: z.boolean().optional(),
});

export function registerMessageCommands(program: Command): void {
  const message = program
    .command('message')
    .description('Read Slack messages and record Slack outputs');

  // Input:   anima message read --channel <id> [--thread-ts <ts>] [--limit <n>]
  //          [--around <ts> | --before <ts> | --after <ts>] [--oldest <ts>] [--latest <ts>]
  //          [--cursor <c>] [--inclusive]
  // Output:  multi-line transcript, oldest → newest, one line per Slack message:
  //            [channel=<display> [channel_id=<id>] [thread_ts=<ts>] message_ts=<ts>
  //             time=<iso> [user_id=<id>] [user_local_time=<local> user_tz=<tz>]] <actor>: <text>
  //          File attachments append a trailing line:
  //            attached: id=<id> name=<name> mimetype=<m> size_bytes=<n> (path=<local> | use anima file fetch <id>)
  //          Pagination: [page has_more=<bool> next_cursor=<cursor|-}]
  // Failure: human-readable error to stderr; exit 1.
  message
    .command('read')
    .description('Read messages from a Slack channel or thread.')
    .option('--channel <channel>', 'channel ID (e.g. C123ABC) or name (e.g. prod)\nDM: D-prefixed channel ID (e.g. D123ABC)')
    .option('--thread-ts <ts>', 'read a thread; omit for the top-level channel')
    .option('--limit <n>', 'max messages to return (default: 20 for channel, 50 for thread; hard cap: 200)')
    .option('--around <ts>', 'window centered on ts (inclusive); cannot combine with --oldest/--latest/--cursor')
    .option('--before <ts>', 'messages before ts (exclusive); cannot combine with --oldest/--latest/--cursor')
    .option('--after <ts>', 'messages after ts (exclusive); cannot combine with --oldest/--latest/--cursor')
    .option('--oldest <ts>', 'lower bound; cannot combine with --around/--before/--after')
    .option('--latest <ts>', 'upper bound; cannot combine with --around/--before/--after')
    .option('--inclusive', 'include messages at the --oldest/--latest boundaries')
    .option('--cursor <cursor>', 'pagination: next_cursor value from a prior response\'s [page ...] line')
    .action(async (_, command) => {
      const opts = MessageReadSchema.parse(command.optsWithGlobals());
      await runMessageRead(opts);
    });

  // Input:   anima message send --channel <id> [--thread-ts <ts>] < body (stdin)
  // Output:  sent successfully. (channel=#<name> | dm=<handle>)[, thread_ts=<ts>], message_ts=<ts>.
  // Failure: human-readable error to stderr; exit 1.
  message
    .command('send')
    .description('Post a Slack or Feishu message.\nMessage body is read from stdin.')
    .option('--channel <channel>', 'Slack channel/DM target, or Feishu chat_id (oc_...)')
    .option('--thread-ts <ts>', 'Slack thread timestamp, or Feishu topic message_id; omit to post top-level/chat message')
    .action(async (_, command) => {
      const opts = MessageSendSchema.parse(command.optsWithGlobals());
      await runMessageSend(opts);
    });

  // Input:   anima message update --channel <id> --message-ts <ts> < body (stdin)
  // Output:  updated successfully. (channel=#<name> | dm=<handle>), message_ts=<ts>.
  // Failure: human-readable error to stderr; exit 1.
  message
    .command('update')
    .description('Edit a previously sent message in place.\nNew message body is read from stdin.')
    .option('--channel <channel>', 'channel ID (e.g. C123ABC) or name (e.g. prod)\nDM: D-prefixed channel ID (e.g. D123ABC)')
    .option('--message-ts <ts>', 'timestamp of the message to update (from the send output)')
    .action(async (_, command) => {
      const opts = MessageUpdateSchema.parse(command.optsWithGlobals());
      await runMessageUpdate(opts);
    });

  message
    .command('react')
    .description('Add a reaction emoji to a Slack message.')
    .option('--channel <channel>', 'channel ID (e.g. C123ABC) or name (e.g. prod)\nDM: D-prefixed channel ID (e.g. D123ABC)')
    .option('--message-ts <ts>', 'timestamp of the message to react to')
    .option('--name <emoji>', 'emoji name without colons (e.g. white_check_mark, eyes)')
    .option('--emoji <emoji>', 'alias for --name')
    .option('--remove', 'remove the reaction instead of adding it')
    .action(async (_, command) => {
      const opts = MessageReactSchema.parse(command.optsWithGlobals());
      await runMessageReact({
        ...opts,
        name: opts.name ?? opts.emoji,
        remove: Boolean(opts.remove),
      });
    });
}
