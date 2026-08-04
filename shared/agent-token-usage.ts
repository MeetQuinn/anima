// Provider-reported token accounting. This is deliberately content-free:
// prompts, responses, tool arguments, paths, and credentials never enter the
// usage ledger or its API representation.

export interface ProviderUsageInput {
  /** Stable within one provider session/turn. The bridge scopes it to agent + item. */
  sourceId: string;
  occurredAt?: string;
  model?: string;
  accountId?: string;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  /** A detail dimension already included in outputTokens; never added to totals. */
  reasoningOutputTokens?: number;
  /** Provider-authoritative total when available. */
  totalTokens?: number;
}

export interface TokenUsageTotals {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface AgentTokenUsageDay extends TokenUsageTotals {
  date: string;
  reportedRuns: number;
  unknownRuns: number;
}

export interface AgentTokenUsageSummary extends TokenUsageTotals {
  agentId: string;
  agentName: string;
  avatarUrl?: string;
  coverageStartedAt?: string;
  days: AgentTokenUsageDay[];
  reportedRuns: number;
  unknownRuns: number;
}

export interface AgentTokenUsageReport extends TokenUsageTotals {
  agents: AgentTokenUsageSummary[];
  from: string;
  through: string;
  timezone: string;
  reportedRuns: number;
  unknownRuns: number;
}

export const EMPTY_TOKEN_USAGE_TOTALS: TokenUsageTotals = {
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};
