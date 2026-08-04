import type { ProviderUsageInput } from '../../shared/agent-token-usage.js';
import { numberField, stringField } from '../json.js';

/** Convert a provider's already-sanitized stats payload into ledger input. */
export function providerUsageFromStats(
  sourceId: string,
  stats: Record<string, unknown> | undefined,
  fallback: { accountId?: string; model?: string } = {},
): ProviderUsageInput {
  const model = stringField(stats, 'model') ?? fallback.model;
  return {
    ...(fallback.accountId ? { accountId: fallback.accountId } : {}),
    cacheCreationInputTokens:
      numberField(stats, 'cacheCreationInputTokens') ?? numberField(stats, 'cacheWriteInputTokens'),
    cacheReadInputTokens: numberField(stats, 'cacheReadInputTokens'),
    inputTokens: numberField(stats, 'inputTokens'),
    ...(model ? { model } : {}),
    outputTokens: numberField(stats, 'outputTokens'),
    reasoningOutputTokens:
      numberField(stats, 'reasoningOutputTokens') ?? numberField(stats, 'reasoningTokens'),
    sourceId,
    // Context occupancy is a point-in-time gauge, not tokens processed by this
    // provider call. Never substitute it for missing usage.
    totalTokens: numberField(stats, 'totalTokens'),
  };
}
