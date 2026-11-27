import type { AntigravityCliAgentProviderConfig } from './contract.js';

/** agy 1.5.15+ reads where to compact a conversation from this variable. */
export const ANTIGRAVITY_AUTO_COMPACT_ENV = 'AGY_CLI_AUTO_COMPACT_OVERRIDE';

/**
 * Where Anima has agy compact a conversation, in tokens. Without the variable agy
 * compacts where its server decides, and a Gemini conversation can grow toward the
 * model's 1M-token window, resending all of it on every turn. Claude Code under
 * Anima's default `CLAUDE_CODE_AUTO_COMPACT_WINDOW=272000` compacts at about 239K,
 * so agents on either CLI carry about the same context. For a model whose window is
 * smaller (GPT-OSS 120B has 131K), agy ignores the value and keeps its own point.
 */
export const ANTIGRAVITY_DEFAULT_AUTO_COMPACT_TOKENS = 240_000;

/** The agent's Launch env, with Anima's compaction point unless the agent sets its own. */
export function antigravityProviderEnv(config: AntigravityCliAgentProviderConfig): Record<string, string> {
  return {
    [ANTIGRAVITY_AUTO_COMPACT_ENV]: String(ANTIGRAVITY_DEFAULT_AUTO_COMPACT_TOKENS),
    ...(config.env ?? {}),
  };
}

/**
 * The token count agy compacts at under this Launch env, for the context gauge. agy
 * takes a count (`240000`) or a K/M shorthand (`240K`, `0.25M`, either case). A
 * percentage depends on the model's window, and an empty or unreadable value leaves
 * the point to agy, so those give undefined.
 */
export function antigravityAutoCompactTokensFor(
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
): number | undefined {
  if (runtimeKind !== 'antigravity-cli') return undefined;
  const configured = runtimeEnv?.[ANTIGRAVITY_AUTO_COMPACT_ENV];
  if (configured === undefined) return ANTIGRAVITY_DEFAULT_AUTO_COMPACT_TOKENS;
  const match = /^(?:(\d+)|(\d+(?:\.\d+)?)([km]))$/i.exec(configured.trim());
  if (!match) return undefined;
  const value = match[1] !== undefined
    ? Number(match[1])
    : Math.round(Number(match[2]) * (match[3]!.toLowerCase() === 'k' ? 1_000 : 1_000_000));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
