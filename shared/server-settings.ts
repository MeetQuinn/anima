import { z } from 'zod';

export const SidebarOrder = z.object({
  agents: z.array(z.string()).optional(),
  kbs: z.array(z.string()).optional(),
});
export type SidebarOrder = z.infer<typeof SidebarOrder>;

export const ReleaseTrack = z.enum(['stable', 'canary']);
export type ReleaseTrack = z.infer<typeof ReleaseTrack>;

export const ServerTrack = z.enum(['dev', 'canary', 'stable']);
export type ServerTrack = z.infer<typeof ServerTrack>;

export const WorkspacePlatform = z.enum(['slack', 'feishu']);
export type WorkspacePlatform = z.infer<typeof WorkspacePlatform>;

export const DashboardAuth = z.object({
  enabled: z.boolean().optional(),
  passwordHash: z.string().min(1).optional(),
  sessionSecret: z.string().min(16).optional(),
  sessionTtlHours: z.number().int().positive().max(24 * 365).optional(),
}).strict();
export type DashboardAuth = z.infer<typeof DashboardAuth>;
