import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import { homePath, numberValue, readJsonFile, record, stringValue, windowFromUsedPercent } from './common.js';

const CODEX_USAGE_API = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_AUTH_PATH = ['.codex', 'auth.json'];
const CODEX_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export async function fetchCodexUsage(): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const token = await readCodexToken();
  if (!token) {
    return unavailable(usageError('not_configured', 'Codex login token not found. Run `codex login` to authenticate.'));
  }
  const result = await fetchJson({
    headers: { ...CODEX_HEADERS, Authorization: bearer(token) },
    url: CODEX_USAGE_API,
  });
  if (result.error) return unavailable(result.error);
  const parsed = parseCodexUsageResponse(result.data);
  if (parsed.error) return unavailable(parsed.error);
  return available(parsed.windows, parsed.extras);
}

export function parseCodexUsageResponse(
  data: unknown,
): { error?: ReturnType<typeof usageError>; extras: ProviderUsageExtra[]; windows: ProviderUsageWindow[] } {
  const root = record(data);
  if (!root) return { error: usageError('parse_error', 'Codex usage response is not an object'), extras: [], windows: [] };

  const rateLimit = record(root.rate_limit);
  const primary = codexWindow('5h', record(rateLimit?.primary_window));
  const secondary = codexWindow('Weekly', record(rateLimit?.secondary_window));
  const windows = [primary, secondary].filter((window): window is ProviderUsageWindow => Boolean(window));

  const codeReview = codexWindow('Code Review', record(record(root.code_review_rate_limit)?.primary_window));
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

async function readCodexToken(): Promise<string | undefined> {
  const auth = record(await readJsonFile(homePath(...CODEX_AUTH_PATH)));
  return stringValue(record(auth?.tokens)?.access_token);
}

function codexWindow(label: string, value: Record<string, unknown> | undefined): ProviderUsageWindow | undefined {
  const usedPercent = numberValue(value?.used_percent);
  return windowFromUsedPercent(label, usedPercent, {
    resetAfterSeconds: numberValue(value?.reset_after_seconds),
    windowSeconds: numberValue(value?.limit_window_seconds),
  });
}
