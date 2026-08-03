import { z } from 'zod';

export const ReminderStatus = z.enum(['scheduled', 'fired', 'cancelled']);

export type ReminderStatus = z.infer<typeof ReminderStatus>;

export const ReminderProvenance = z.object({
  channelId: z.string(),
  messageTs: z.string(),
  threadTs: z.string().optional(),
});

export type ReminderProvenance = z.infer<typeof ReminderProvenance>;

export const ReminderSchedule = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
  }),
  z.object({
    phaseAnchorAt: z.string().optional(),
    intervalMs: z.number(),
    kind: z.literal('interval'),
    repeatRule: z.string(),
  }),
  z.object({
    kind: z.literal('daily'),
    repeatRule: z.string(),
    time: z.string(),
    timezone: z.string(),
  }),
  z.object({
    kind: z.literal('weekly'),
    repeatRule: z.string(),
    time: z.string(),
    timezone: z.string(),
    weekdays: z.array(z.string()),
  }),
  // every:* interval constrained to local weekdays + inclusive wall-clock window.
  // Only valid with every:*; legacy once/interval/daily/weekly records unchanged.
  z.object({
    intervalMs: z.number(),
    kind: z.literal('windowed_interval'),
    repeatRule: z.string(),
    timezone: z.string(),
    weekdays: z.array(z.string()),
    windowEnd: z.string(),
    windowRule: z.string(),
    windowStart: z.string(),
  }),
]);

export type ReminderSchedule = z.infer<typeof ReminderSchedule>;

/** Optional gate: run a shell command before waking the agent. Product: "Run only when". */
export const ReminderPreflight = z.object({
  command: z.string().min(1),
  /** Default 30m; v1 hard cap 24h. */
  timeoutMs: z.number().positive().optional(),
});

export type ReminderPreflight = z.infer<typeof ReminderPreflight>;

export const ReminderPreflightResultStatus = z.enum(['succeeded', 'declined', 'errored']);
export type ReminderPreflightResultStatus = z.infer<typeof ReminderPreflightResultStatus>;

export const ReminderPreflightLastResult = z.object({
  durationMs: z.number(),
  endedAt: z.string(),
  exitCode: z.number().optional(),
  scheduledAt: z.string(),
  signal: z.string().optional(),
  startedAt: z.string(),
  status: ReminderPreflightResultStatus,
  stderr: z.string().optional(),
  stderrTruncated: z.boolean().optional(),
  stdout: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
  timedOut: z.boolean().optional(),
});

export type ReminderPreflightLastResult = z.infer<typeof ReminderPreflightLastResult>;

/** Persistent attention while the last preflight outcome is errored. */
export const ReminderPreflightErrorState = z.object({
  attentionKey: z.string(),
  lastNotifiedAt: z.string().optional(),
  since: z.string(),
});

export type ReminderPreflightErrorState = z.infer<typeof ReminderPreflightErrorState>;

export const Reminder = z.object({
  cancelledAt: z.string().optional(),
  createdAt: z.string(),
  firedCount: z.number(),
  instructions: z.string(),
  lastFiredAt: z.string().optional(),
  nextDueAt: z.string().optional(),
  preflight: ReminderPreflight.optional(),
  preflightError: ReminderPreflightErrorState.optional(),
  preflightLastResult: ReminderPreflightLastResult.optional(),
  provenance: ReminderProvenance.optional(),
  reminderId: z.string(),
  schedule: ReminderSchedule,
  status: ReminderStatus,
  title: z.string(),
  updatedAt: z.string(),
});

export type Reminder = z.infer<typeof Reminder>;
