import { z } from 'zod';

export const RuntimeReleaseTrack = z.enum(['stable', 'canary']);
export type RuntimeReleaseTrack = z.infer<typeof RuntimeReleaseTrack>;

export const RuntimeUpgradeGateBlocker = z.object({
  agentId: z.string(),
  itemId: z.string(),
  since: z.string(),
  status: z.enum(['queued', 'running']),
  summary: z.string().optional(),
});
export type RuntimeUpgradeGateBlocker = z.infer<typeof RuntimeUpgradeGateBlocker>;

export const RuntimeUpgradeGate = z.object({
  blockers: z.array(RuntimeUpgradeGateBlocker),
  state: z.enum(['idle', 'busy']),
});
export type RuntimeUpgradeGate = z.infer<typeof RuntimeUpgradeGate>;

export const RuntimeUpgradeCheckError = z.object({
  message: z.string(),
  type: z.enum(['network', 'parse', 'unknown']),
});
export type RuntimeUpgradeCheckError = z.infer<typeof RuntimeUpgradeCheckError>;

export const RuntimeUpgradeOperation = z.object({
  completedAt: z.string().optional(),
  currentVersion: z.string().optional(),
  error: z.string().optional(),
  logPath: z.string().optional(),
  previousVersion: z.string().optional(),
  rollback: z.enum(['not_needed', 'succeeded', 'failed']).optional(),
  restart: z.object({
    fallbackToIdle: z.boolean(),
    mode: z.enum(['idle', 'drain-active']),
    requestedCount: z.number(),
    resumedCount: z.number(),
  }).optional(),
  scheduledAt: z.string().optional(),
  startedAt: z.string().optional(),
  status: z.enum(['idle', 'scheduled', 'running', 'succeeded', 'failed']),
  targetVersion: z.string().optional(),
});
export type RuntimeUpgradeOperation = z.infer<typeof RuntimeUpgradeOperation>;

export const RuntimeUpgradeStatusResponse = z.object({
  checkedAt: z.string(),
  checkError: RuntimeUpgradeCheckError.optional(),
  currentVersion: z.string(),
  gate: RuntimeUpgradeGate,
  latestOnTrack: z.string().optional(),
  operation: RuntimeUpgradeOperation,
  releaseTrack: RuntimeReleaseTrack,
  state: z.enum(['current', 'available', 'error']),
  updateAvailable: z.boolean(),
});
export type RuntimeUpgradeStatusResponse = z.infer<typeof RuntimeUpgradeStatusResponse>;

export const RuntimeUpgradeApplyResponse = z.object({
  animaHome: z.string(),
  currentVersion: z.string(),
  delayMs: z.number(),
  latestOnTrack: z.string(),
  logPath: z.string(),
  ok: z.literal(true),
  releaseTrack: RuntimeReleaseTrack,
  scheduled: z.literal(true),
});
export type RuntimeUpgradeApplyResponse = z.infer<typeof RuntimeUpgradeApplyResponse>;
