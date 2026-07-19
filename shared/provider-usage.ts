import { z } from 'zod';

export const ProviderUsageKind = z.enum(['claude-code', 'codex-cli', 'kimi-cli', 'grok-cli']);
export type ProviderUsageKind = z.infer<typeof ProviderUsageKind>;

export const ProviderUsageErrorType = z.enum([
  'network_error',
  'not_configured',
  'parse_error',
  'unauthorized',
  'unknown',
]);
export type ProviderUsageErrorType = z.infer<typeof ProviderUsageErrorType>;

export const ProviderUsageWindow = z.object({
  label: z.string(),
  remainingPercent: z.number().min(0).max(100),
  resetsAt: z.string().optional(),
  usedPercent: z.number().min(0).max(100).optional(),
  windowSeconds: z.number().int().positive().optional(),
});
export type ProviderUsageWindow = z.infer<typeof ProviderUsageWindow>;

export const ProviderUsageExtra = z.object({
  balance: z.string().optional(),
  currency: z.string().optional(),
  label: z.string(),
  limit: z.number().optional(),
  unlimited: z.boolean().optional(),
  used: z.number().optional(),
});
export type ProviderUsageExtra = z.infer<typeof ProviderUsageExtra>;

export const ProviderUsageError = z.object({
  message: z.string(),
  type: ProviderUsageErrorType,
});
export type ProviderUsageError = z.infer<typeof ProviderUsageError>;

export const ProviderUsageRow = z.object({
  account: z.string().max(320).optional(),
  accountId: z.string().optional(),
  active: z.boolean().optional(),
  checkedAt: z.string(),
  error: ProviderUsageError.optional(),
  extras: z.array(ProviderUsageExtra),
  label: z.string(),
  provider: ProviderUsageKind,
  source: z.enum(['native', 'private-api']),
  status: z.enum(['available', 'unavailable']),
  windows: z.array(ProviderUsageWindow),
});
export type ProviderUsageRow = z.infer<typeof ProviderUsageRow>;

export const ProviderUsageResponse = z.object({
  providers: z.array(ProviderUsageRow),
});
export type ProviderUsageResponse = z.infer<typeof ProviderUsageResponse>;
