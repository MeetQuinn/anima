import { z } from 'zod';

export const ProviderAccountId = z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export type ProviderAccountId = z.infer<typeof ProviderAccountId>;

export const ClaudeCodeAccountConfig = z.object({
  configDir: z.string().trim().min(1).optional(),
  id: ProviderAccountId,
  label: z.string().trim().min(1).max(80),
}).strict();
export type ClaudeCodeAccountConfig = z.infer<typeof ClaudeCodeAccountConfig>;

export const ProviderAccountRestartRequest = z.object({
  agentId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
}).strict();
export type ProviderAccountRestartRequest = z.infer<typeof ProviderAccountRestartRequest>;

export const ClaudeCodeAccountSwitch = z.object({
  accountId: ProviderAccountId,
  agentIds: z.array(z.string().trim().min(1)).optional(),
  failedAgentIds: z.array(z.string().trim().min(1)).optional(),
  requestedAt: z.string().datetime(),
  restarts: z.array(ProviderAccountRestartRequest),
}).strict();
export type ClaudeCodeAccountSwitch = z.infer<typeof ClaudeCodeAccountSwitch>;

export const ClaudeCodeAccountRegistry = z.object({
  accounts: z.array(ClaudeCodeAccountConfig).min(1),
  activeAccountId: ProviderAccountId,
  switch: ClaudeCodeAccountSwitch.optional(),
}).strict();
export type ClaudeCodeAccountRegistry = z.infer<typeof ClaudeCodeAccountRegistry>;

export const ProviderAccountsConfig = z.object({
  claudeCode: ClaudeCodeAccountRegistry.optional(),
}).strict();
export type ProviderAccountsConfig = z.infer<typeof ProviderAccountsConfig>;

export const ProviderAccountSummary = z.object({
  account: z.string().max(320).optional(),
  id: ProviderAccountId,
  label: z.string(),
  profile: z.enum(['default', 'isolated']),
  selected: z.boolean(),
  status: z.enum(['available', 'not_configured']),
}).strict();
export type ProviderAccountSummary = z.infer<typeof ProviderAccountSummary>;

export const ClaudeCodeAccountState = z.object({
  accounts: z.array(ProviderAccountSummary),
  activeAccountId: ProviderAccountId,
  errorAgentIds: z.array(z.string()),
  pendingAgentIds: z.array(z.string()),
  provider: z.literal('claude-code'),
  status: z.enum(['active', 'switching', 'error']),
}).strict();
export type ClaudeCodeAccountState = z.infer<typeof ClaudeCodeAccountState>;

export const ProviderAccountsResponse = z.object({
  providers: z.array(ClaudeCodeAccountState),
}).strict();
export type ProviderAccountsResponse = z.infer<typeof ProviderAccountsResponse>;

export const SelectProviderAccountRequest = z.object({
  accountId: ProviderAccountId,
}).strict();
export type SelectProviderAccountRequest = z.infer<typeof SelectProviderAccountRequest>;

export const ClaudeAccountLoginStartRequest = z.object({
  accountId: ProviderAccountId.optional(),
  email: z.string().trim().email().max(320).optional(),
}).strict();
export type ClaudeAccountLoginStartRequest = z.infer<typeof ClaudeAccountLoginStartRequest>;

export const ClaudeAccountLoginCodeRequest = z.object({
  code: z.string().trim().min(1).max(4_096),
}).strict();
export type ClaudeAccountLoginCodeRequest = z.infer<typeof ClaudeAccountLoginCodeRequest>;

export const ClaudeAccountLoginOperation = z.object({
  account: z.string().max(320).optional(),
  accountId: ProviderAccountId.optional(),
  createdAt: z.string().datetime(),
  error: z.string().optional(),
  id: z.string().uuid(),
  loginUrl: z.string().url().optional(),
  status: z.enum(['starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled']),
  updatedAt: z.string().datetime(),
}).strict();
export type ClaudeAccountLoginOperation = z.infer<typeof ClaudeAccountLoginOperation>;
