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

export const Reminder = z.object({
  cancelledAt: z.string().optional(),
  createdAt: z.string(),
  firedCount: z.number(),
  instructions: z.string(),
  lastFiredAt: z.string().optional(),
  nextDueAt: z.string().optional(),
  provenance: ReminderProvenance.optional(),
  reminderId: z.string(),
  schedule: ReminderSchedule,
  status: ReminderStatus,
  title: z.string(),
  updatedAt: z.string(),
});

export type Reminder = z.infer<typeof Reminder>;
