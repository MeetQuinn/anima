import { z } from 'zod';

import { ProviderUsageKind } from './provider-usage.js';

export const ProviderCliInstallSource = z.enum([
  'claude-native',
  'codex-npm-global',
  'kimi-native',
  'grok-native',
  'unknown',
]);
export type ProviderCliInstallSource = z.infer<typeof ProviderCliInstallSource>;

export const ProviderCliCheckError = z.object({
  message: z.string(),
  type: z.enum(['network', 'parse', 'unknown']),
});
export type ProviderCliCheckError = z.infer<typeof ProviderCliCheckError>;

export const ProviderCliAgentImpact = z.object({
  enabled: z.boolean(),
  id: z.string(),
  name: z.string(),
  runningSince: z.string().optional(),
  runningVersion: z.string().optional(),
});
export type ProviderCliAgentImpact = z.infer<typeof ProviderCliAgentImpact>;

export const ProviderCliUpgradeOperation = z.object({
  completedAt: z.string().optional(),
  error: z.string().optional(),
  previousVersion: z.string().optional(),
  provider: ProviderUsageKind.optional(),
  restoreCommand: z.string().optional(),
  startedAt: z.string().optional(),
  status: z.enum(['idle', 'running', 'succeeded', 'failed']),
  targetVersion: z.string().optional(),
});
export type ProviderCliUpgradeOperation = z.infer<typeof ProviderCliUpgradeOperation>;

export const ProviderCliRow = z.object({
  agents: z.array(ProviderCliAgentImpact),
  autoUpdateChannel: z.string().optional(),
  autoUpdatesEnabled: z.boolean().optional(),
  binaryPath: z.string().optional(),
  checkError: ProviderCliCheckError.optional(),
  checkedAt: z.string().optional(),
  installSource: ProviderCliInstallSource,
  installedVersion: z.string().optional(),
  label: z.string(),
  latestVersion: z.string().optional(),
  manualCommand: z.string().optional(),
  operation: ProviderCliUpgradeOperation,
  provider: ProviderUsageKind,
  realPath: z.string().optional(),
  sourceDetail: z.string().optional(),
  state: z.enum(['not_installed', 'not_checked', 'current', 'available', 'error', 'manual', 'unknown']),
  updateAvailable: z.boolean(),
  updateMode: z.enum(['managed', 'manual', 'unavailable']),
});
export type ProviderCliRow = z.infer<typeof ProviderCliRow>;

export const ProviderCliStatusResponse = z.object({
  operation: ProviderCliUpgradeOperation,
  providers: z.array(ProviderCliRow),
  upgradeLocked: z.boolean(),
});
export type ProviderCliStatusResponse = z.infer<typeof ProviderCliStatusResponse>;

export const ProviderCliApplyResponse = z.object({
  installedVersion: z.string(),
  ok: z.literal(true),
  previousVersion: z.string(),
  provider: ProviderUsageKind,
  targetVersion: z.string(),
});
export type ProviderCliApplyResponse = z.infer<typeof ProviderCliApplyResponse>;
