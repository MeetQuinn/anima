import type { Command } from 'commander';
import { z } from 'zod';

import { resolveAgentIdFrom } from '../cli/shared.js';
import type { Reminder, ReminderProvenance, ReminderStatus } from '../../shared/reminder.js';
import { reminderServiceForAgent } from './reminder.service.js';
import { parseDurationMs } from './reminder.helper.js';

const SharedFlags = z.object({
  agent: z.string().optional(),
});

const ScheduleSchema = SharedFlags.extend({
  anchorChannel: z.string().optional(),
  anchorMessageTs: z.string().optional(),
  anchorThreadTs: z.string().optional(),
  fireAt: z.string().optional(),
  in: z.string().optional(),
  instructions: z.string().optional(),
  message: z.string().optional(),
  note: z.string().optional(),
  repeat: z.string().optional(),
  timezone: z.string().optional(),
  title: z.string().optional(),
});

const ListSchema = SharedFlags.extend({
  status: z.string().optional(),
});

const CancelSchema = SharedFlags.extend({
  id: z.string().min(1, 'Missing --id'),
});

const SnoozeSchema = SharedFlags.extend({
  by: z.string().min(1, 'Missing --by'),
  id: z.string().min(1, 'Missing --id'),
});

type ScheduleOptions = z.infer<typeof ScheduleSchema>;
type ListOptions = z.infer<typeof ListSchema>;
type CancelOptions = z.infer<typeof CancelSchema>;
type SnoozeOptions = z.infer<typeof SnoozeSchema>;

export const REMINDER_SCHEDULE_EXAMPLES = [
  ['--in', '1h', '--title', 'check deploy', '--instructions', 'verify prod is healthy'],
  [
    '--fire-at', '2026-05-24T09:00:00Z', '--repeat', 'daily@09:00',
    '--timezone', 'Asia/Shanghai', '--title', 'standup', '--instructions', 'post the async standup',
  ],
] as const;

export function reminderScheduleExampleCommand(args: readonly string[]): string {
  return ['anima', 'reminder', 'schedule', ...args].map(readableShellArg).join(' ');
}

export function registerReminderCommands(program: Command): void {
  const reminder = program.command('reminder').description('Schedule and manage agent wake-up reminders.');

  // Input:   anima reminder schedule --title <text> [--instructions <text> | stdin]
  //          (--in <duration> | --fire-at <iso>) [--repeat <rule>] [--timezone <tz>]
  //          [--anchor-channel <id> --anchor-message-ts <ts> [--anchor-thread-ts <ts>]]
  // Output:  scheduled successfully. reminder_id=<id>, title=<title>, next=<iso>.
  // Failure: human-readable error to stderr; exit 1.
  reminder
    .command('schedule')
    .description('Schedule a one-shot or recurring agent wake-up.')
    .option('--title <text>', 'short display label for the reminder')
    .option('--instructions <text>',
      'what to do when the reminder fires; or omit and pipe via stdin\n' +
      'this text is delivered to the agent as the reminder body')
    .option('--message <text>', 'alias for --instructions')
    .option('--note <text>', 'alias for --instructions')
    .option('--in <duration>',
      'fire after a delay from now; format: <n><unit> where unit = s/m/h/d\n' +
      'e.g. 30m, 2h, 1d')
    .option('--fire-at <iso>',
      'fire first at a specific ISO 8601 datetime\n' +
      'e.g. 2026-05-24T09:00:00Z')
    .option('--repeat <rule>',
      'make this a recurring reminder; formats:\n' +
      '  every:<n><m|h|d>            fixed interval, e.g. every:30m\n' +
      '  daily@HH:MM                 daily at a time, e.g. daily@09:00\n' +
      '  weekly:<day[,day]>@HH:MM    weekly on days, e.g. weekly:mon,fri@10:00\n' +
      'days: sun mon tue wed thu fri sat')
    .option('--timezone <tz>',
      'IANA timezone name for --fire-at and --repeat time interpretation\n' +
      'e.g. America/Los_Angeles, Asia/Shanghai\n' +
      'defaults to UTC if omitted')
    .option('--anchor-channel <id>',
      'Slack channel ID or name to return to when this reminder fires\n' +
      'requires --anchor-message-ts; together they set the reply context')
    .option('--anchor-message-ts <ts>', 'Slack message timestamp to anchor to (requires --anchor-channel)')
    .option('--anchor-thread-ts <ts>', 'thread root timestamp when anchoring inside a thread')
    .addHelpText('after', `\nExamples:\n${REMINDER_SCHEDULE_EXAMPLES
      .map((args) => `  ${reminderScheduleExampleCommand(args)}`)
      .join('\n')}`)
    .action(async (_, command) => {
      const opts = ScheduleSchema.parse(command.optsWithGlobals());
      await runSchedule(opts);
    });

  // Input:   anima reminder list [--status <statuses>]
  // Output:  one line per reminder: <id> [<status>] [next=<iso>] [repeat=<rule>] <title>
  //          Default: scheduled reminders only.
  // Failure: human-readable error to stderr; exit 1.
  reminder
    .command('list')
    .description('List reminders (default: scheduled only).')
    .option('--status <statuses>',
      'comma-separated status filter; values: scheduled, fired, cancelled\n' +
      'e.g. --status scheduled  or  --status scheduled,fired')
    .action(async (_, command) => {
      const opts = ListSchema.parse(command.optsWithGlobals());
      await runList(opts);
    });

  // Input:   anima reminder cancel --id <id>
  // Output:  cancelled successfully. reminder_id=<id>, title=<title>.
  // Failure: human-readable error to stderr; exit 1.
  reminder
    .command('cancel [id]')
    .description('Cancel a scheduled reminder.')
    .option('--id <id>', 'reminder ID (from reminder list output)')
    .action(async (id: string | undefined, _, command) => {
      const raw = command.optsWithGlobals();
      const opts = CancelSchema.parse({ ...raw, id: raw.id ?? id });
      await runCancel(opts);
    });

  // Input:   anima reminder snooze --id <id> --by <duration>
  // Output:  snoozed successfully. reminder_id=<id>, title=<title>, next=<iso>.
  // Failure: human-readable error to stderr; exit 1.
  reminder
    .command('snooze [id]')
    .description('Delay a reminder\'s next firing without changing its repeat schedule.')
    .option('--id <id>', 'reminder ID (from reminder list output)')
    .option('--by <duration>',
      'how long to snooze; format: <n><unit> where unit = s/m/h/d\n' +
      'e.g. 30m, 2h')
    .action(async (id: string | undefined, _, command) => {
      const raw = command.optsWithGlobals();
      const opts = SnoozeSchema.parse({ ...raw, id: raw.id ?? id });
      await runSnooze(opts);
    });
}

function readableShellArg(value: string): string {
  return /^[a-zA-Z0-9_@:/.,=-]+$/.test(value) ? value : JSON.stringify(value);
}

async function runSchedule(opts: ScheduleOptions): Promise<void> {
  const agentId = await resolveReminderAgentId(opts);
  const reminderService = reminderServiceForAgent(agentId);
  const instructions = opts.instructions ?? opts.message ?? opts.note ?? (await stdinText());
  const delaySeconds = opts.in ? Math.ceil(parseDurationMs(opts.in) / 1000) : undefined;
  const provenance = anchorProvenance(opts);

  const reminder = await reminderService.scheduleReminder({
    instructions,
    title: opts.title ?? defaultReminderTitle(instructions),
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    ...(opts.fireAt ? { fireAt: opts.fireAt } : {}),
    ...(opts.repeat ? { repeat: opts.repeat } : {}),
    ...(opts.timezone ? { timezone: opts.timezone } : {}),
    ...(provenance ? { provenance } : {}),
  });
  printReminderResult('scheduled', reminder);
}

async function runList(opts: ListOptions): Promise<void> {
  const agentId = await resolveReminderAgentId(opts);
  const reminderService = reminderServiceForAgent(agentId);
  const statuses = reminderStatuses(opts);
  const reminders = await reminderService.listReminders({
    ...(statuses ? { statuses } : {}),
  });
  if (reminders.length === 0) {
    console.log('No reminders.');
    return;
  }
  for (const reminder of reminders) {
    console.log(reminderLine(reminder));
  }
}

async function runCancel(opts: CancelOptions): Promise<void> {
  const agentId = await resolveReminderAgentId(opts);
  const reminder = await reminderServiceForAgent(agentId).cancelReminder({ id: opts.id });
  printReminderResult('cancelled', reminder);
}

async function runSnooze(opts: SnoozeOptions): Promise<void> {
  const agentId = await resolveReminderAgentId(opts);
  const reminder = await reminderServiceForAgent(agentId).snoozeReminder({ by: opts.by, id: opts.id });
  printReminderResult('snoozed', reminder);
}

function anchorProvenance(opts: ScheduleOptions): ReminderProvenance | undefined {
  if (!opts.anchorChannel && !opts.anchorMessageTs && !opts.anchorThreadTs) return undefined;
  if (!opts.anchorChannel || !opts.anchorMessageTs) {
    throw new Error('Anchor requires both --anchor-channel and --anchor-message-ts');
  }
  return {
    channelId: opts.anchorChannel,
    messageTs: opts.anchorMessageTs,
    ...(opts.anchorThreadTs ? { threadTs: opts.anchorThreadTs } : {}),
  };
}

function printReminderResult(verb: 'scheduled' | 'cancelled' | 'snoozed', reminder: Reminder): void {
  const next = reminder.nextDueAt ? `, next=${truncateToMinutes(reminder.nextDueAt)}` : '';
  const title = reminder.title ? `, title=${reminder.title}` : '';
  console.log(`${verb} successfully. reminder_id=${reminder.reminderId}${title}${next}.`);
}

function reminderLine(reminder: Reminder): string {
  const next = reminder.nextDueAt ? ` next=${truncateToMinutes(reminder.nextDueAt)}` : '';
  const repeat = reminder.schedule.kind === 'once' ? '' : ` repeat=${reminder.schedule.repeatRule}`;
  return `${reminder.reminderId} [${reminder.status}]${next}${repeat} ${reminder.title}`;
}

function reminderStatuses(opts: ListOptions): ReminderStatus[] | undefined {
  if (!opts.status) return ['scheduled'];
  const statuses = opts.status
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of statuses) {
    if (!isReminderStatus(item)) throw new Error(`Invalid reminder status: ${item}. Valid values: scheduled, fired, cancelled`);
  }
  return statuses as ReminderStatus[];
}

function isReminderStatus(value: string): value is ReminderStatus {
  return value === 'scheduled' || value === 'fired' || value === 'cancelled';
}

function defaultReminderTitle(instructions: string): string {
  const title = instructions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/g, ' ')
    .slice(0, 80);
  return title || 'Reminder';
}

function resolveReminderAgentId(opts: { agent?: string }): string {
  const id = resolveAgentIdFrom(opts.agent);
  if (!id) throw new Error('Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.');
  return id;
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function truncateToMinutes(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toISOString().slice(0, 16) + 'Z';
}
