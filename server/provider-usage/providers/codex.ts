import { join } from 'node:path';

import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  decodeJwtPayload,
  homePath,
  numberValue,
  readJsonFile,
  record,
  stringValue,
  windowFromUsedPercent,
} from './common.js';

const CODEX_USAGE_API = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

interface CodexCredentials {
  account?: string;
  accessToken: string;
}

export async function fetchCodexUsage(input: { configDir?: string } = {}): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const credentials = await readCodexCredentials(input.configDir);
  if (!credentials) {
    return unavailable(usageError('not_configured', 'Codex login token not found. Run `codex login` to authenticate.'));
  }

  let activeCredentials = credentials;
  let result = await fetchCodexUsageWithToken(activeCredentials.accessToken);
  if (result.error?.type === 'unauthorized') {
    // Codex is the only owner of its OAuth refresh and of auth.json. Usage only
    // reads: it adopts a token Codex rotated meanwhile, and never refreshes or
    // writes, which could race Codex's own rotation and sign it out.
    const latestCredentials = await readCodexCredentials(input.configDir);
    if (latestCredentials && latestCredentials.accessToken !== activeCredentials.accessToken) {
      activeCredentials = latestCredentials;
      result = await fetchCodexUsageWithToken(activeCredentials.accessToken);
    }
  }

  if (result.error) return unavailable(result.error, activeCredentials.account);
  const parsed = parseCodexUsageResponse(result.data);
  if (parsed.error) return unavailable(parsed.error, activeCredentials.account);
  return available(parsed.windows, parsed.extras, activeCredentials.account);
}

export function parseCodexUsageResponse(
  data: unknown,
): { error?: ReturnType<typeof usageError>; extras: ProviderUsageExtra[]; windows: ProviderUsageWindow[] } {
  const root = record(data);
  if (!root) return { error: usageError('parse_error', 'Codex usage response is not an object'), extras: [], windows: [] };

  const rateLimit = record(root.rate_limit);
  // Labels derive from the window's own duration (limit_window_seconds), not
  // its slot: when Codex drops a limit, the remaining window can move into
  // primary_window, and the positional fallback would mislabel Weekly as 5h.
  const primary = codexWindow('5h', record(rateLimit?.primary_window));
  const secondary = codexWindow('Weekly', record(rateLimit?.secondary_window));
  const windows = [primary, secondary].filter((window): window is ProviderUsageWindow => Boolean(window));

  const codeReview = codexWindow('Code Review', record(record(root.code_review_rate_limit)?.primary_window), false);
  if (codeReview) windows.push(codeReview);
  if (windows.length === 0) {
    return { error: usageError('parse_error', 'Codex usage response did not include rate limit windows'), extras: [], windows: [] };
  }

  const extras: ProviderUsageExtra[] = [];
  const plan = stringValue(root.plan_type);
  if (plan) extras.push({ label: 'Plan', balance: plan });
  const credits = record(root.credits);
  if (credits) {
    extras.push({
      balance: stringValue(credits.balance) ?? '0',
      label: 'Credits',
      unlimited: credits.unlimited === true,
    });
  }

  return { extras, windows };
}

async function readCodexCredentials(configDir?: string): Promise<CodexCredentials | undefined> {
  const path = configDir ? join(configDir, 'auth.json') : homePath('.codex', 'auth.json');
  const auth = record(await readJsonFile(path));
  const tokens = record(auth?.tokens);
  const accessToken = stringValue(tokens?.access_token);
  if (!auth || !accessToken) return undefined;
  const account = codexAccount(tokens, auth);
  return { ...(account ? { account } : {}), accessToken };
}

/**
 * Human identity for the Providers panel. ChatGPT OAuth puts email under the
 * OpenAI profile claim (and often as a top-level auth.json field), not
 * `claims.email`. Falling through to tokens.account_id alone surfaces opaque
 * `org-…` ids, which are not useful as a display name.
 */
export function codexAccount(
  tokens: Record<string, unknown> | undefined,
  auth: Record<string, unknown> | undefined = undefined,
): string | undefined {
  const claims = record(
    decodeJwtPayload(stringValue(tokens?.id_token) ?? stringValue(tokens?.access_token) ?? ''),
  );
  const profile = record(claims?.['https://api.openai.com/profile']);
  return (
    stringValue(claims?.email)
    ?? stringValue(profile?.email)
    ?? stringValue(auth?.email)
    ?? stringValue(profile?.name)
    ?? nonOrgAccountId(stringValue(tokens?.account_id))
  );
}

function nonOrgAccountId(accountId: string | undefined): string | undefined {
  if (!accountId || /^org-/i.test(accountId)) return undefined;
  return accountId;
}

async function fetchCodexUsageWithToken(token: string): ReturnType<typeof fetchJson> {
  return fetchJson({
    headers: { ...CODEX_HEADERS, Authorization: bearer(token) },
    telemetryLabel: 'codex-cli',
    url: CODEX_USAGE_API,
  });
}

function codexWindow(
  fallbackLabel: string,
  value: Record<string, unknown> | undefined,
  deriveLabel = true,
): ProviderUsageWindow | undefined {
  const usedPercent = numberValue(value?.used_percent);
  const windowSeconds = numberValue(value?.limit_window_seconds);
  const label = deriveLabel ? codexWindowLabel(windowSeconds, fallbackLabel) : fallbackLabel;
  return windowFromUsedPercent(label, usedPercent, {
    resetAfterSeconds: numberValue(value?.reset_after_seconds),
    windowSeconds,
  });
}

/** Human label for a rate-limit window from its duration; fallback keeps the
 * positional label when the response omits limit_window_seconds. */
function codexWindowLabel(windowSeconds: number | undefined, fallback: string): string {
  if (!windowSeconds || windowSeconds <= 0) return fallback;
  const hours = windowSeconds / 3600;
  const days = hours / 24;
  if (days >= 27 && days <= 32) return 'Monthly';
  if (days >= 6.5 && days <= 8) return 'Weekly';
  if (days >= 1.5) return `${Math.round(days)}d`;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.max(1, Math.round(windowSeconds / 60))}m`;
}
