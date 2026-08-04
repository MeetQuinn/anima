import { constants } from 'node:os';
import type { Command } from 'commander';
import { z } from 'zod';

import { resolveAnimaHome } from '../anima-home.js';
import { resolveAgentHomePath } from '../agents/agent-config-ops.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import type { Reminder, ReminderProvenance, ReminderStatus } from '../../shared/reminder.js';
import { reminderServiceForAgent } from './reminder.service.js';
import { parseDurationMs, scheduleDisplayRule } from './reminder.helper.js';
import {
  formatReminderInspection,
  inspectReminder,
} from './reminder.inspection.js';
import {
  REMINDER_BODY_MAX_CHARS,
  runPreflightCommand,
  type PreflightExecutionResult,
} from './preflight.js';

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
  window: z.string().optional(),
  preflight: z.string().optional(),
  preflightTimeout: z.string().optional(),
});

const PreflightSchema = z.object({
  command: z.string().min(1, 'Missing --command'),
  timeout: z.string().optional(),
});

const ListSchema = SharedFlags.extend({
  json: z.boolean().optional(),
  status: z.string().optional(),
});

const ShowSchema = SharedFlags.extend({
  id: z.string().min(1, 'Missing reminder id'),
  json: z.boolean().optional(),
});

const ShowInputSchema = SharedFlags.extend({
  id: z.string().optional(),
  json: z.boolean().optional(),
  positionalId: z.string().optional(),
}).superRefine((input, context) => {
  if (input.id && input.positionalId && input.id !== input.positionalId) {
    context.addIssue({
      code: 'custom',
      message: 'Reminder id must match when passed both positionally and with --id',
    });
  }
});

const CancelSchema = SharedFlags.extend({
  id: z.string().min(1, 'Missing --id'),
});

const SnoozeSchema = SharedFlags.extend({
  by: z.string().min(1, 'Missing --by'),
  id: z.string().min(1, 'Missing --id'),
});

type ScheduleOptions = z.infer<typeof ScheduleSchema>;
type PreflightOptions = z.infer<typeof PreflightSchema>;
type ListOptions = z.infer<typeof ListSchema>;
type ShowOptions = z.infer<typeof ShowSchema>;
type CancelOptions = z.infer<typeof CancelSchema>;
type SnoozeOptions = z.infer<typeof SnoozeSchema>;

export const REMINDER_PREFLIGHT_SCHEDULE_EXAMPLE = [
  '--repeat', 'every:15m', '--title', 'Usage check',
  '--instructions', 'review the usage alert', '--preflight', './scripts/check-usage.sh',
  '--preflight-timeout', '2m',
] as const;

export const REMINDER_SCHEDULE_EXAMPLES = [
  ['--in', '1h', '--title', 'check deploy', '--instructions', 'verify prod is healthy'],
  [
    '--fire-at', '2026-05-24T09:00:00Z', '--repeat', 'daily@09:00',
    '--timezone', 'Asia/Shanghai', '--title', 'standup', '--instructions', 'post the async standup',
  ],
  [
    '--repeat', 'every:30m', '--window', 'mon-fri@08:00-18:30',
    '--timezone', 'America/New_York', '--title', 'Work-hours poll',
    '--instructions', 'poll the work queue during business hours',
  ],
  REMINDER_PREFLIGHT_SCHEDULE_EXAMPLE,
] as const;

export function reminderScheduleExampleCommand(args: readonly string[]): string {
  return ['anima', 'reminder', 'schedule', ...args].map(readableShellArg).join(' ');
}

function preflightWorkflowHelp(): string {
  return [
    "  anima reminder preflight --command './scripts/check-usage.sh' --timeout 2m",
    `  ${reminderScheduleExampleCommand(REMINDER_PREFLIGHT_SCHEDULE_EXAMPLE)}`,
  ].join('\n');
}

export function registerReminderCommands(program: Command): void {
  const reminder = program
    .command('reminder')
    .description('Schedule and manage agent wake-up reminders.')
    .addHelpText('after', '\nWrite → Run → Schedule:\n' +
      '  Write and debug the script in Agent Home.\n' +
      `${preflightWorkflowHelp()}\n`);

  reminder
    .command('preflight')
    .description('Run a reminder preflight once without scheduling it.')
    .requiredOption('--command <command>', 'shell command to run once (CWD = Agent Home)')
    .option('--timeout <duration>',
      'timeout (default 30m, hard cap 24h); format: <n><s|m|h|d>\n' +
      'on timeout the process group is killed')
    .addHelpText('after', '\nRun this from the target agent. It uses the same Agent Home and configured/managed\n' +
      'environment as hosted preflight. No message context is invented, and no reminder, wake,\n' +
      'or state is created. Exit 0 succeeds and would wake; exit 1 declines and would skip;\n' +
      'exit >=2, signal, or timeout errors and would report Needs attention.\n\n' +
      'Example (Write → Run → Schedule):\n' +
      `${preflightWorkflowHelp()}\n`)
    .action(async (_, command) => {
      const opts = PreflightSchema.parse(command.opts());
      await runPreflight(opts);
    });

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
    .option('--window <spec>',
      'restrict every:* to local weekdays + inclusive wall-clock hours\n' +
      'format: <days>@HH:MM-HH:MM  e.g. mon-fri@08:00-18:30 or mon,wed@09:00-17:00\n' +
      'only valid with --repeat every:*; not combinable with --fire-at or --in\n' +
      'interval must fit inside the same-day window span; overnight windows rejected (v1)')
    .option('--preflight <command>',
      'Run only when: shell command before the agent wakes (CWD = Agent Home)\n' +
      'exit 0 = wake, exit 1 = skip; exit >=2 / signal / timeout = errored (Needs attention)\n' +
      'do not inline secrets — the command is persisted and shown in list/show/UI')
    .option('--preflight-timeout <duration>',
      'preflight timeout (default 30m, hard cap 24h); format: <n><s|m|h|d>\n' +
      'e.g. 30m, 2h — on timeout the process group is killed')
    .option('--timezone <tz>',
      'IANA timezone name for --fire-at, --repeat, and --window interpretation\n' +
      'e.g. America/Los_Angeles, Asia/Shanghai\n' +
      'defaults to the host timezone if omitted')
    .option('--anchor-channel <id>',
      'Slack channel ID or name to return to when this reminder fires\n' +
      'requires --anchor-message-ts; together they set the reply context')
    .option('--anchor-message-ts <ts>', 'Slack message timestamp to anchor to (requires --anchor-channel)')
    .option('--anchor-thread-ts <ts>', 'thread root timestamp when anchoring inside a thread')
    .addHelpText('after', `\nWrite → Run → Schedule:\n${preflightWorkflowHelp()}\n\nExamples:\n${REMINDER_SCHEDULE_EXAMPLES
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
    .option('--json', 'print the stable public reminder representation as JSON')
    .option('--status <statuses>',
      'comma-separated status filter; values: scheduled, fired, cancelled\n' +
      'e.g. --status scheduled  or  --status scheduled,fired')
    .action(async (_, command) => {
      const opts = ListSchema.parse(command.optsWithGlobals());
      await runList(opts);
    });

  reminder
    .command('show [id]')
    .description('Show every persisted detail for one reminder.')
    .option('--id <id>', 'reminder ID (from reminder list output)')
    .option('--json', 'print the stable public reminder representation as JSON')
    .action(async (id: string | undefined, _, command) => {
      const raw = command.optsWithGlobals();
      const input = ShowInputSchema.parse({ ...raw, positionalId: id });
      const opts = ShowSchema.parse({ ...input, id: input.id ?? input.positionalId });
      await runShow(opts);
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

  const preflight = opts.preflight
    ? {
        command: opts.preflight,
        ...(opts.preflightTimeout
          ? { timeoutMs: parseDurationMs(opts.preflightTimeout) }
          : {}),
      }
    : undefined;
  if (opts.preflightTimeout && !opts.preflight) {
    throw new Error('--preflight-timeout requires --preflight');
  }
  const reminder = await reminderService.scheduleReminder({
    instructions,
    title: opts.title ?? defaultReminderTitle(instructions),
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    ...(opts.fireAt ? { fireAt: opts.fireAt } : {}),
    ...(opts.repeat ? { repeat: opts.repeat } : {}),
    ...(opts.timezone ? { timezone: opts.timezone } : {}),
    ...(opts.window ? { window: opts.window } : {}),
    ...(preflight ? { preflight } : {}),
    ...(provenance ? { provenance } : {}),
  });
  printReminderResult('scheduled', reminder);
}

async function runPreflight(opts: PreflightOptions): Promise<void> {
  const agentId = process.env.ANIMA_AGENT_ID?.trim();
  if (!agentId) {
    throw new Error('Run reminder preflight from the target agent; ANIMA_AGENT_ID is required.');
  }
  const animaHome = resolveAnimaHome();
  const store = new AgentStore(agentId);
  if (!store.exists()) throw new Error(`Agent not found: ${agentId}`);
  const agentHome = resolveAgentHomePath(await store.read());
  const { result } = await runPreflightCommand({
    agentId,
    animaHome,
    command: opts.command,
    cwd: agentHome,
    runtimeEnv: process.env as Record<string, string>,
    ...(opts.timeout ? { timeoutMs: parseDurationMs(opts.timeout) } : {}),
  });
  if (!result) throw new Error('Preflight did not produce a result.');
  printPreflightResult(result);
  process.exitCode = preflightExitCode(result);
}

function printPreflightResult(result: PreflightExecutionResult): void {
  printCapturedStream('stdout', result.stdout, result.stdoutTruncated);
  printCapturedStream('stderr', result.stderr, result.stderrTruncated);
  const execution = result.timedOut
    ? 'timeout'
    : result.signal
      ? `signal=${result.signal}`
      : `exit=${result.exitCode ?? 127}`;
  const meaning = result.status === 'succeeded'
    ? 'succeeds; hosted reminder would wake'
    : result.status === 'declined'
      ? 'declines; hosted reminder would skip'
      : 'errors; hosted reminder would report Needs attention';
  console.log(`result: ${meaning}`);
  console.log(`duration_ms=${result.durationMs} ${execution}`);
}

function printCapturedStream(
  name: 'stdout' | 'stderr',
  output: string | undefined,
  truncated: boolean | undefined,
): void {
  console.log(`${name}:`);
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  else console.log('(empty)');
  if (truncated) {
    console.log(`…[preflight ${name} truncated at ${REMINDER_BODY_MAX_CHARS} characters]`);
  }
}

function preflightExitCode(result: PreflightExecutionResult): number {
  if (result.timedOut) return 124;
  if (result.signal) return 128 + (constants.signals[result.signal as keyof typeof constants.signals] ?? 0);
  return result.exitCode ?? 127;
}

async function runList(opts: ListOptions): Promise<void> {
  const agentId = await resolveReminderAgentId(opts);
  const reminderService = reminderServiceForAgent(agentId);
  const statuses = reminderStatuses(opts);
  const reminders = await reminderService.listReminders({
    ...(statuses ? { statuses } : {}),
  });
  if (opts.json) {
    console.log(JSON.stringify(reminders.map(inspectReminder)));
    return;
  }
  if (reminders.length === 0) {
    console.log('No reminders.');
    return;
  }
  for (const reminder of reminders) {
    console.log(reminderLine(reminder));
  }
}

async function runShow(opts: ShowOptions): Promise<void> {
  const agentId = await resolveReminderAgentId(opts);
  const reminder = await reminderServiceForAgent(agentId).findReminder(opts.id);
  if (!reminder) throw new Error(`Reminder not found: ${opts.id}`);
  const inspection = inspectReminder(reminder);
  console.log(opts.json ? JSON.stringify(inspection) : formatReminderInspection(inspection));
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
  const display = scheduleDisplayRule(reminder.schedule);
  const repeat = display ? ` repeat=${display}` : '';
  const runOnly = reminder.preflight ? ' run_only_when' : '';
  const err = reminder.preflightError ? ' preflight-error' : '';
  const last = reminder.preflightLastResult ? ` preflight=${reminder.preflightLastResult.status}` : '';
  return `${reminder.reminderId} [${reminder.status}]${next}${repeat}${runOnly}${err}${last} ${reminder.title}`;
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
