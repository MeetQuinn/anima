import { z } from 'zod';

export const ServicesRestartResult = z.object({
  completedAt: z.string(),
  fallbackToIdle: z.boolean(),
  mode: z.enum(['idle', 'drain-active']),
  requestedCount: z.number(),
  resumedCount: z.number(),
});
export type ServicesRestartResult = z.infer<typeof ServicesRestartResult>;

export const LastServicesRestart = ServicesRestartResult.extend({
  logPath: z.string().optional(),
});
export type LastServicesRestart = z.infer<typeof LastServicesRestart>;

export const ServerInfo = z.object({
  animaHome: z.string(),
  commit: z.string().optional(),
  dashboardPort: z.number(),
  env: z.enum(['dev', 'prod', 'custom']),
  lastRestart: LastServicesRestart.optional(),
  ok: z.literal(true),
  startedAt: z.string(),
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
