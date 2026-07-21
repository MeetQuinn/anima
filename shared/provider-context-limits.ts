import { z } from 'zod';

export const ProviderContextLimitProvider = z.enum(['grok-cli', 'kimi-cli']);
export type ProviderContextLimitProvider = z.infer<
  typeof ProviderContextLimitProvider
>;

export const PROVIDER_CONTEXT_LIMIT_PRESETS = {
  'grok-cli': [131_072, 200_000],
  'kimi-cli': [131_072, 262_144],
} as const satisfies Record<ProviderContextLimitProvider, readonly number[]>;

export const PROVIDER_CONTEXT_LIMIT_RECOMMENDED = {
  'grok-cli': 200_000,
  'kimi-cli': 262_144,
} as const satisfies Record<ProviderContextLimitProvider, number>;

export const ProviderContextLimitsConfig = z
  .object({
    'grok-cli': z.number().int().positive().optional(),
    'kimi-cli': z.number().int().positive().optional(),
  })
  .strict();
export type ProviderContextLimitsConfig = z.infer<
  typeof ProviderContextLimitsConfig
>;

export const ProviderContextLimitRequest = z
  .object({
    maxTokens: z.number().int().positive().nullable(),
    provider: ProviderContextLimitProvider,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxTokens === null) return;
    const presets: readonly number[] =
      PROVIDER_CONTEXT_LIMIT_PRESETS[value.provider];
    if (!presets.includes(value.maxTokens)) {
      context.addIssue({
        code: 'custom',
        message: `Unsupported context limit for ${value.provider}`,
        path: ['maxTokens'],
      });
    }
  });
export type ProviderContextLimitRequest = z.infer<
  typeof ProviderContextLimitRequest
>;

export const ProviderContextLimitRow = z.object({
  maxTokens: z.number().int().positive().nullable(),
  presets: z.array(z.number().int().positive()),
  provider: ProviderContextLimitProvider,
  recommended: z.number().int().positive(),
});
export type ProviderContextLimitRow = z.infer<typeof ProviderContextLimitRow>;

export const ProviderContextLimitsResponse = z.object({
  providers: z.array(ProviderContextLimitRow),
});
export type ProviderContextLimitsResponse = z.infer<
  typeof ProviderContextLimitsResponse
>;
