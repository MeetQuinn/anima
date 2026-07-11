import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  decodeJwtPayload,
  homePath,
  jwtExpiresSoon,
  numberValue,
  readJsonFile,
  record,
  stringValue,
  windowFromUsedPercent,
  writeJsonFile,
} from './common.js';

const CODEX_USAGE_API = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_REFRESH_TOKEN_API = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTH_PATH = ['.codex', 'auth.json'];
const CODEX_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

interface CodexCredentials {
  account?: string;
  accessToken: string;
  auth: Record<string, unknown>;
  path: string;
  refreshToken?: string;
}

export async function fetchCodexUsage(): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const credentials = await readCodexCredentials();
  if (!credentials) {
    return unavailable(usageError('not_configured', 'Codex login token not found. Run `codex login` to authenticate.'));
  }

  let activeCredentials = credentials;
  if (jwtExpiresSoon(activeCredentials.accessToken) && activeCredentials.refreshToken) {
    const refreshed = await refreshCodexCredentials(activeCredentials);
    if (refreshed.error) return unavailable(refreshed.error, activeCredentials.account);
    activeCredentials = refreshed.credentials;
  }

  let result = await fetchCodexUsageWithToken(activeCredentials.accessToken);
  if (result.error?.type === 'unauthorized' && activeCredentials.refreshToken) {
    const latestCredentials = await readCodexCredentials();
    if (latestCredentials && latestCredentials.accessToken !== activeCredentials.accessToken) {
      activeCredentials = latestCredentials;
    } else {
      const refreshed = await refreshCodexCredentials(activeCredentials);
      if (refreshed.error) return unavailable(refreshed.error, activeCredentials.account);
      activeCredentials = refreshed.credentials;
    }
    result = await fetchCodexUsageWithToken(activeCredentials.accessToken);
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

async function readCodexCredentials(): Promise<CodexCredentials | undefined> {
  const path = homePath(...CODEX_AUTH_PATH);
  const auth = record(await readJsonFile(path));
  const tokens = record(auth?.tokens);
  const accessToken = stringValue(tokens?.access_token);
  if (!auth || !accessToken) return undefined;
  const account = codexAccount(tokens);
  return {
    ...(account ? { account } : {}),
    accessToken,
    auth,
    path,
    refreshToken: stringValue(tokens?.refresh_token),
  };
}

function codexAccount(tokens: Record<string, unknown> | undefined): string | undefined {
  const claims = record(decodeJwtPayload(stringValue(tokens?.id_token) ?? ''));
  return stringValue(claims?.email) ?? stringValue(tokens?.account_id);
}

async function fetchCodexUsageWithToken(token: string): ReturnType<typeof fetchJson> {
  return fetchJson({
    headers: { ...CODEX_HEADERS, Authorization: bearer(token) },
    url: CODEX_USAGE_API,
  });
}

async function refreshCodexCredentials(
  credentials: CodexCredentials,
): Promise<{ credentials: CodexCredentials; error?: never } | { credentials?: never; error: NonNullable<Awaited<ReturnType<typeof fetchJson>>['error']> }> {
  if (!credentials.refreshToken) {
    return { error: usageError('unauthorized', 'Codex refresh token not found. Run `codex login` to authenticate again.') };
  }

  const result = await fetchJson({
    body: JSON.stringify({
      client_id: process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID?.trim() || CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
    }),
    headers: { ...CODEX_HEADERS, 'Content-Type': 'application/json' },
    method: 'POST',
    url: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() || CODEX_REFRESH_TOKEN_API,
  });
  if (result.error) return { error: result.error };

  const response = record(result.data);
  const accessToken = stringValue(response?.access_token);
  if (!accessToken) {
    return { error: usageError('parse_error', 'Codex refresh response did not include an access token.') };
  }

  const tokens = {
    ...record(credentials.auth.tokens),
    access_token: accessToken,
    ...(stringValue(response?.id_token) ? { id_token: stringValue(response?.id_token) } : {}),
    ...(stringValue(response?.refresh_token) ? { refresh_token: stringValue(response?.refresh_token) } : {}),
  };
  const auth = {
    ...credentials.auth,
    tokens,
    last_refresh: new Date().toISOString(),
  };
  try {
    await writeJsonFile(credentials.path, auth);
  } catch {
    return { error: usageError('unknown', 'Codex token refreshed but could not be saved. Check ~/.codex/auth.json permissions.') };
  }
  const account = codexAccount(record(tokens)) ?? credentials.account;
  return {
    credentials: {
      ...(account ? { account } : {}),
      accessToken,
      auth,
      path: credentials.path,
      refreshToken: stringValue(tokens.refresh_token),
    },
  };
}

function codexWindow(label: string, value: Record<string, unknown> | undefined): ProviderUsageWindow | undefined {
  const usedPercent = numberValue(value?.used_percent);
  return windowFromUsedPercent(label, usedPercent, {
    resetAfterSeconds: numberValue(value?.reset_after_seconds),
    windowSeconds: numberValue(value?.limit_window_seconds),
  });
}
