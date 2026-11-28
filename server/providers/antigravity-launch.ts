import type { AntigravityCliAgentProviderConfig } from './contract.js';

/**
 * The context limit an `agy` conversation is kept under. `agy`'s own TUI compacts
 * at this point, but `agy acp` (1.5.18) ignores it, so under Anima the runtime
 * worker starts a new session once a conversation has reached it (see
 * `archiveProviderSessionAtContextLimit`). Anima still passes it to `agy`, so a
 * later `agy` that honors it in ACP compacts before Anima would start over.
 */
export const ANTIGRAVITY_CONTEXT_LIMIT_ENV = 'AGY_CLI_AUTO_COMPACT_OVERRIDE';

/**
 * Anima's default limit, in tokens. Without one, a Gemini conversation grows
 * toward the model's 1M-token window, resending all of it on every turn. Claude
 * Code under Anima's default `CLAUDE_CODE_AUTO_COMPACT_WINDOW=272000` compacts at
 * about 239K, so agents on either CLI carry about the same context. A model whose
 * window is smaller (GPT-OSS 120B has 131K) never reaches it and keeps `agy`'s own
 * handling.
 */
export const ANTIGRAVITY_DEFAULT_CONTEXT_LIMIT_TOKENS = 240_000;

/** The agent's Launch env, with Anima's context limit unless the agent sets its own. */
export function antigravityProviderEnv(config: AntigravityCliAgentProviderConfig): Record<string, string> {
  return {
    [ANTIGRAVITY_CONTEXT_LIMIT_ENV]: String(ANTIGRAVITY_DEFAULT_CONTEXT_LIMIT_TOKENS),
    ...(config.env ?? {}),
  };
}

/**
 * The context limit under this Launch env, in tokens, for the context gauge and
 * for starting a new session. The value is what `agy` takes: a count (`240000`), a
 * K/M shorthand (`240K`, `0.25M`, either case) or a percentage of the model's
 * window (`25%`), which needs `contextWindow`. `0`, an empty or an unreadable value
 * sets no limit, so those give undefined.
 */
export function antigravityContextLimitFor(
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
  contextWindow?: number,
): number | undefined {
  if (runtimeKind !== 'antigravity-cli') return undefined;
  const configured = runtimeEnv?.[ANTIGRAVITY_CONTEXT_LIMIT_ENV];
  if (configured === undefined) return ANTIGRAVITY_DEFAULT_CONTEXT_LIMIT_TOKENS;
  const match = /^(?:(\d+)|(\d+(?:\.\d+)?)([km%]))$/i.exec(configured.trim());
  if (!match) return undefined;
  const unit = match[3]?.toLowerCase();
  if (unit === '%') {
    const percent = Number(match[2]);
    if (!(percent > 0 && percent <= 100) || !contextWindow || contextWindow <= 0) return undefined;
    return Math.round((percent / 100) * contextWindow);
  }
  const value = match[1] !== undefined
    ? Number(match[1])
    : Math.round(Number(match[2]) * (unit === 'k' ? 1_000 : 1_000_000));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
