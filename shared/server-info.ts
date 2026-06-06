import { z } from 'zod';

import { ServerTrack } from './server-settings.js';

export const ServicesRestartBlocker = z.object({
  agentId: z.string(),
  itemId: z.string(),
  since: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  summary: z.string().optional(),
  workerId: z.string().optional(),
});
export type ServicesRestartBlocker = z.infer<typeof ServicesRestartBlocker>;

export const ServicesRestartSucceededResult = z.object({
  completedAt: z.string(),
  fallbackToIdle: z.boolean(),
  interruptedCount: z.number().optional(),
  mode: z.enum(['idle', 'drain-active']),
  requestedCount: z.number(),
  resumedCount: z.number(),
  status: z.literal('succeeded').default('succeeded'),
});
export type ServicesRestartSucceededResult = z.infer<typeof ServicesRestartSucceededResult>;

export const ServicesRestartBlockedResult = z.object({
  blockers: z.array(ServicesRestartBlocker),
  completedAt: z.string(),
  message: z.string(),
  reason: z.enum(['became_busy', 'drain_timeout', 'idle_timeout']),
  status: z.literal('blocked'),
});
export type ServicesRestartBlockedResult = z.infer<typeof ServicesRestartBlockedResult>;

export const ServicesRestartResult = z.union([
  ServicesRestartBlockedResult,
  ServicesRestartSucceededResult,
]);
export type ServicesRestartResult = z.infer<typeof ServicesRestartResult>;

export const LastServicesRestart = z.union([
  ServicesRestartBlockedResult.extend({ logPath: z.string().optional() }),
  ServicesRestartSucceededResult.extend({ logPath: z.string().optional() }),
]);
export type LastServicesRestart = z.infer<typeof LastServicesRestart>;

export const ServerInfo = z.object({
  animaHome: z.string(),
  commit: z.string().optional(),
  dashboardPort: z.number(),
  docsUrl: z.string().url().optional(),
  lastRestart: LastServicesRestart.optional(),
  ok: z.literal(true),
  startedAt: z.string(),
  track: ServerTrack,
  uptimeSeconds: z.number(),
  version: z.string(),
});
export type ServerInfo = z.infer<typeof ServerInfo>;

export const ServicesRestartResponse = z.object({
  ok: z.literal(true),
  animaHome: z.string(),
  delayMs: z.number(),
  logPath: z.string(),
  scheduled: z.literal(true),
});
export type ServicesRestartResponse = z.infer<typeof ServicesRestartResponse>;
