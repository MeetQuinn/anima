// API contract and disk schema for agent configuration. Consumed by server and web.

import { z } from 'zod';

import { defaultAgentHomePath } from './agent-home.js';
import {
  DEFAULT_PROVIDER_KIND,
  defaultModelForProvider,
  isSupportedReasoningEffort,
  isSupportedProviderKind,
  isSupportedProviderModel,
} from './provider-catalog.js';

export const PROVIDER_IDLE_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;
export const ANIMA_MANAGED_PROVIDER_ENV_KEYS = [
  'ANIMA_AGENT_ID',
  'ANIMA_HOME',
  'ANIMA_INBOX_ITEM_ID',
  'ANIMA_RUNTIME_HOME',
  'ANIMA_SLACK_BOT_TOKEN',
  'FEISHU_API_BASE_URL',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_BOT_OPEN_ID',
  'FEISHU_TENANT_ACCESS_TOKEN',
  'FEISHU_TENANT_ACCESS_TOKEN_EXPIRES_AT',
  'NO_COLOR',
  'SLACK_BOT_TOKEN',
] as const;

export function agentIdFromName(name: string): string {
  const normalized = name.normalize('NFKC').trim();
  const ascii = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii;

  const unicodeWordChars = Array.from(normalized).filter((char) => /[\p{L}\p{N}]/u.test(char));
  if (unicodeWordChars.length === 0) return '';

  const encoded = unicodeWordChars
    .slice(0, 8)
    .map((char) => char.codePointAt(0)?.toString(16))
    .filter((value): value is string => Boolean(value))
    .join('-');
  const suffix = unicodeWordChars.length > 8 ? `-${hashForAgentId(normalized)}` : '';
  return `u-${encoded}${suffix}`;
}

function hashForAgentId(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const AgentProviderCreateRequest = z.object({
  kind: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).optional(),
}).strict().superRefine((provider, ctx) => {
  if (!isSupportedProviderKind(provider.kind)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unsupported provider kind ${provider.kind}`,
      path: ['kind'],
    });
    return;
  }
  if (!isSupportedProviderModel(provider.kind, provider.model)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unsupported model for ${provider.kind}: ${provider.model}`,
      path: ['model'],
    });
  }
  if (provider.reasoningEffort && !isSupportedReasoningEffort(provider.kind, provider.reasoningEffort)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unsupported reasoningEffort ${provider.reasoningEffort}`,
      path: ['reasoningEffort'],
    });
  }
});

const AgentProviderUpdateRequest = z.object({
  env: z.record(z.string(), z.string().nullable()).optional(),
  kind: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
}).strict();

export const AgentCreateRequest = z.object({
  name: z.string().trim().min(1).refine((name) => Boolean(agentIdFromName(name)), {
    message: 'name must include at least one URL-safe letter or number',
  }),
  homePath: z.string().trim().min(1),
  role: z.string().trim().min(1),
  provider: AgentProviderCreateRequest,
}).strict();

export type AgentCreateRequest = z.infer<typeof AgentCreateRequest>;

export const AgentUpdateHomeRequest = z.object({
  homePath: z.string().trim().min(1),
}).strict();

export type AgentUpdateHomeRequest = z.infer<typeof AgentUpdateHomeRequest>;

export const AgentUpdateProfileRequest = z.object({
  displayName: z.string().trim().min(1).optional(),
  role: z.string().trim().optional(),
}).strict().refine((profile) => profile.displayName !== undefined || profile.role !== undefined, {
  message: 'profile update requires displayName or role',
});

export type AgentUpdateProfileRequest = z.infer<typeof AgentUpdateProfileRequest>;

export const AgentUpdateProviderRequest = AgentProviderUpdateRequest;

export type AgentUpdateProviderRequest = z.infer<typeof AgentUpdateProviderRequest>;

export const AgentConnectSlackRequest = z.object({
  appToken: z.string().trim().min(1).refine((value) => value.startsWith('xapp-'), {
    message: 'appToken must start with xapp-',
  }),
  botToken: z.string().trim().min(1).refine((value) => value.startsWith('xoxb-'), {
    message: 'botToken must start with xoxb-',
  }),
}).strict();

export type AgentConnectSlackRequest = z.infer<typeof AgentConnectSlackRequest>;

export const AgentSlackValidateRequest = z.object({
  appToken: z.string().trim().optional(),
  botToken: z.string().trim().optional(),
}).strict();

export type AgentSlackValidateRequest = z.infer<typeof AgentSlackValidateRequest>;

export type SlackTokenKind = 'app' | 'bot' | 'unknown';

export type SlackTokenValidationReason =
  | 'missing_token'
  | 'wrong_token_type'
  | 'unknown_token_type'
  | 'invalid_token'
  | 'missing_connections_write'
  | 'not_bot_token'
  | 'slack_api_error';

export interface SlackTokenValidation {
  appId?: string;
  botAvatarUrl?: string;
  botName?: string;
  botUserId?: string;
  detected?: SlackTokenKind;
  expected: Exclude<SlackTokenKind, 'unknown'>;
  reason?: SlackTokenValidationReason;
  teamId?: string;
  valid: boolean;
  workspaceIconUrl?: string;
  workspaceName?: string;
}

export interface SlackConnectionValidation {
  appId?: string;
  botAvatarUrl?: string;
  botName?: string;
  botUserId?: string;
  reason?: 'incomplete' | 'app_mismatch';
  teamId?: string;
  valid: boolean;
  workspaceIconUrl?: string;
  workspaceName?: string;
}

export interface AgentSlackValidateResponse {
  app?: SlackTokenValidation;
  bot?: SlackTokenValidation;
  connection: SlackConnectionValidation;
}

export const AgentSetOwnerRequest = z.object({
  slackUserId: z.string().trim().min(1),
  openerNote: z.string().optional(),
  introduce: z.boolean().optional(),
}).strict();

export type AgentSetOwnerRequest = z.infer<typeof AgentSetOwnerRequest>;

export const SlackUserCandidate = z.object({
  slackUserId: z.string(),
  displayName: z.string(),
  handle: z.string().optional(),
  avatarUrl: z.string().optional(),
}).strict();

export type SlackUserCandidate = z.infer<typeof SlackUserCandidate>;

export const CodexCliAgentProviderConfig = z.object({
  env: z.record(z.string(), z.string()).optional(),
  idleTimeoutMs: z.number().optional(),
  kind: z.literal('codex-cli'),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  reasoningSummary: z.enum(['auto', 'concise', 'detailed', 'none']).optional(),
});

export type CodexCliAgentProviderConfig = z.infer<typeof CodexCliAgentProviderConfig>;

export const ClaudeCodeAgentProviderConfig = z.object({
  env: z.record(z.string(), z.string()).optional(),
  idleTimeoutMs: z.number().optional(),
  kind: z.literal('claude-code'),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

export type ClaudeCodeAgentProviderConfig = z.infer<typeof ClaudeCodeAgentProviderConfig>;

export const KimiCliAgentProviderConfig = z.object({
  env: z.record(z.string(), z.string()).optional(),
  idleTimeoutMs: z.number().optional(),
  kind: z.literal('kimi-cli'),
  model: z.string().optional(),
});

export type KimiCliAgentProviderConfig = z.infer<typeof KimiCliAgentProviderConfig>;

export const AgentProviderConfig = z.preprocess(
  (value) => {
    const input = isRecord(value) ? value : {};
    const rawKind = typeof input.kind === 'string' ? input.kind : undefined;
    const kind = rawKind && isSupportedProviderKind(rawKind) ? rawKind : DEFAULT_PROVIDER_KIND;
    return {
      ...input,
      ...(typeof input.idleTimeoutMs !== 'number' ? { idleTimeoutMs: PROVIDER_IDLE_TIMEOUT_MS_DEFAULT } : {}),
      kind,
      model: typeof input.model === 'string' ? input.model : defaultModelForProvider(kind),
    };
  },
  z.discriminatedUnion('kind', [
    CodexCliAgentProviderConfig,
    ClaudeCodeAgentProviderConfig,
    KimiCliAgentProviderConfig,
  ]),
);

export type AgentProviderConfig = z.infer<typeof AgentProviderConfig>;

export const SlackConfig = z.object({
  appId: z.string().optional(),
  appToken: z.string().default(''),
  avatarUrl: z.string().optional(),
  // ISO timestamp of the last bot display-info (avatar/name/icon) sync, used to
  // throttle the automatic refresh that runs while the agent handles messages.
  botProfileSyncedAt: z.string().optional(),
  botToken: z.string().default(''),
  connected: z.boolean().optional(),
  manifestVersion: z.number().int().nonnegative().default(0),
  teamId: z.string().default(''),
  workspaceIconUrl: z.string().default(''),
  workspaceName: z.string().default(''),
}).transform(({ appToken, botToken, connected: _connected, ...rest }) => ({
  ...rest,
  appToken,
  botToken,
  connected: Boolean(appToken && botToken),
}));

export type SlackConfig = z.infer<typeof SlackConfig>;

export const FeishuConfig = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  botOpenId: z.string().optional(),
  encryptKey: z.string().default(''),
  ownerGreetingChatId: z.string().optional(),
  ownerGreetingDeliveredAt: z.string().optional(),
  ownerGreetingMessageId: z.string().optional(),
  ownerGreetingPromptedAt: z.string().optional(),
  ownerOpenId: z.string().optional(),
  ownerTenantBrand: z.enum(['feishu', 'lark']).optional(),
  verificationToken: z.string().default(''),
  connected: z.boolean().optional(),
}).transform(({ appId, appSecret, connected: _connected, ...rest }) => ({
  ...rest,
  appId,
  appSecret,
  connected: Boolean(appId && appSecret),
}));

export type FeishuConfig = z.infer<typeof FeishuConfig>;

export const AgentConnectFeishuRequest = z.object({
  appId: z.string().trim().min(1),
  appSecret: z.string().trim().min(1),
  botOpenId: z.string().trim().optional(),
  encryptKey: z.string().trim().optional(),
  verificationToken: z.string().trim().optional(),
}).strict();

export type AgentConnectFeishuRequest = z.infer<typeof AgentConnectFeishuRequest>;

export const AgentFeishuRegisterAppRequest = z.object({
  botName: z.string().optional(),
}).strict();

export type AgentFeishuRegisterAppRequest = z.infer<typeof AgentFeishuRegisterAppRequest>;

export const AgentFeishuRegisterAppStatus = z.object({
  agent: z.unknown().optional(),
  error: z.object({
    code: z.string().optional(),
    description: z.string().optional(),
    message: z.string().optional(),
  }).optional(),
  expireIn: z.number().optional(),
  registrationId: z.string(),
  state: z.enum(['starting', 'waiting', 'slow_down', 'domain_switched', 'connected', 'failed']),
  verificationUrl: z.string().optional(),
}).strict();

export type AgentFeishuRegisterAppStatus = z.infer<typeof AgentFeishuRegisterAppStatus>;

export const AgentOwner = SlackUserCandidate.extend({
  onboardingPromptedAt: z.string().optional(),
}).strict();

export type AgentOwner = z.infer<typeof AgentOwner>;

const AgentProfileInput = z.preprocess((value) => {
  if (!isRecord(value)) return value;
  const next = { ...value };
  if (typeof next.role !== 'string' && typeof next.description === 'string') {
    next.role = next.description;
  }
  delete next.description;
  return next;
}, z.object({
  displayName: z.string().optional(),
  role: z.string().optional(),
}).strict().optional());

export const AgentProfileConfig = z.object({
  displayName: z.string(),
  role: z.string(),
});

export type AgentProfileConfig = z.infer<typeof AgentProfileConfig>;

export function agentConfigSchema(fallbackId: string) {
  return z.preprocess(
    (value) => {
      if (!isRecord(value)) return value;
      const next = { ...value };
      // Back-compat: `runtime` → `provider`
      if (next.provider === undefined && next.runtime !== undefined) {
        next.provider = next.runtime;
      }
      delete next.runtime;
      // Back-compat: `operator` → `owner`
      if (next.owner === undefined && next.operator !== undefined) {
        next.owner = next.operator;
      }
      delete next.operator;
      return next;
    },
    z.object({
      createdAt: z.string().optional(),
      enabled: z.boolean().optional(),
      id: z.string().optional(),
      profile: AgentProfileInput,
      owner: AgentOwner.optional(),
      provider: AgentProviderConfig.optional(),
      feishu: FeishuConfig.optional(),
      slack: SlackConfig.optional(),
      homePath: z.string().optional(),
    }).transform((raw) => {
      const id = raw.id ?? fallbackId;
      return {
        createdAt: raw.createdAt ?? new Date().toISOString(),
        enabled: raw.enabled ?? true,
        id,
        profile: {
          displayName: raw.profile?.displayName ?? titleFromId(id),
          role: raw.profile?.role ?? '',
        },
        ...(raw.owner ? { owner: raw.owner } : {}),
        provider: raw.provider ?? AgentProviderConfig.parse({}),
        feishu: raw.feishu ?? FeishuConfig.parse({}),
        slack: raw.slack ?? SlackConfig.parse({}),
        homePath: raw.homePath ?? defaultAgentHomePath(id),
      };
    }),
  );
}

export type AgentConfig = z.infer<ReturnType<typeof agentConfigSchema>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function titleFromId(id: string): string {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || id;
}
