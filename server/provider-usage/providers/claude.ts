import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';

import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  clampPercent,
  expiresSoon,
  homePath,
  numberValue,
  readJsonFile,
  record,
  resetAtFromValue,
  stringValue,
  windowFromUsedPercent,
  writeJsonFile,
} from './common.js';

const execFileAsync = promisify(execFile);
const CLAUDE_USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_REFRESH_TOKEN_API = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_CREDENTIALS_PATH = ['.claude', '.credentials.json'];
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';

interface ClaudeCredentials {
  account?: string;
  accessToken: string;
  expiresAt?: number;
  payload: Record<string, unknown>;
  rateLimitTier?: string;
  refreshToken?: string;
  source: { kind: 'file'; path: string } | { account: string; kind: 'keychain' };
  subscriptionType?: string;
}

export async function fetchClaudeUsage(): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const credentials = await readClaudeCredentials();
  if (!credentials) {
    return unavailable(usageError('not_configured', 'Claude Code OAuth token not found. Run `claude` to authenticate.'));
  }

  let activeCredentials = credentials;
  if (expiresSoon(activeCredentials.expiresAt) && activeCredentials.refreshToken) {
    const refreshed = await refreshClaudeCredentials(activeCredentials);
    if (refreshed.error) return unavailable(refreshed.error, activeCredentials.account);
    activeCredentials = refreshed.credentials;
  }

  let result = await fetchClaudeUsageWithToken(activeCredentials.accessToken);
  if (result.error?.type === 'unauthorized' && activeCredentials.refreshToken) {
    const latestCredentials = await readClaudeCredentials();
    if (latestCredentials && latestCredentials.accessToken !== activeCredentials.accessToken) {
      activeCredentials = latestCredentials;
    } else {
      const refreshed = await refreshClaudeCredentials(activeCredentials);
      if (refreshed.error) return unavailable(refreshed.error, activeCredentials.account);
      activeCredentials = refreshed.credentials;
    }
    result = await fetchClaudeUsageWithToken(activeCredentials.accessToken);
  }

  if (result.error) return unavailable(result.error, activeCredentials.account);
  const parsed = parseClaudeUsageResponse(result.data, activeCredentials);
  if (parsed.error) return unavailable(parsed.error, activeCredentials.account);
  return available(parsed.windows, parsed.extras, activeCredentials.account);
}

export function parseClaudeUsageResponse(
  data: unknown,
  credentials: Pick<ClaudeCredentials, 'rateLimitTier' | 'subscriptionType'> = {},
): { error?: ReturnType<typeof usageError>; extras: ProviderUsageExtra[]; windows: ProviderUsageWindow[] } {
  const root = record(data);
  if (!root) return { error: usageError('parse_error', 'Claude usage response is not an object'), extras: [], windows: [] };

  const windows = dedupeWindowsByLabel([
    claudeWindow('5h', root.five_hour),
    claudeWindow('Weekly', root.seven_day),
    ...claudeScopedWeeklyWindows(root.limits),
  ].filter((window): window is ProviderUsageWindow => Boolean(window)));

  if (windows.length === 0) {
    return { error: usageError('parse_error', 'Claude usage response did not include quota windows'), extras: [], windows: [] };
  }

  const extras: ProviderUsageExtra[] = [];
  const extra = record(root.extra_usage);
  if (extra?.is_enabled === true) {
    const limit = numberValue(extra.monthly_limit);
    const used = numberValue(extra.used_credits);
    extras.push({
      currency: stringValue(extra.currency)?.toUpperCase() ?? 'USD',
      label: 'Extra Usage',
      ...(limit !== undefined ? { limit: limit / 100 } : {}),
      ...(used !== undefined ? { used: used / 100 } : {}),
    });
  }
  const plan = inferPlan(credentials.rateLimitTier, credentials.subscriptionType);
  if (plan) extras.unshift({ label: 'Plan', balance: plan });

  return { extras, windows };
}

async function readClaudeCredentials(): Promise<ClaudeCredentials | undefined> {
  const account = await readClaudeAccount();
  const filePath = homePath(...CLAUDE_CREDENTIALS_PATH);
  const fileCredentials = extractClaudeCredentials(await readJsonFile(filePath), { kind: 'file', path: filePath }, account);
  if (fileCredentials) return fileCredentials;
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return extractClaudeCredentials(parseJsonOrHex(stdout), { account: userInfo().username, kind: 'keychain' }, account);
  } catch {
    return undefined;
  }
}

async function readClaudeAccount(): Promise<string | undefined> {
  const config = record(await readJsonFile(homePath('.claude.json')));
  const account = record(config?.oauthAccount);
  return stringValue(account?.emailAddress) ?? stringValue(account?.displayName);
}

function extractClaudeCredentials(
  value: unknown,
  source: ClaudeCredentials['source'],
  account?: string,
): ClaudeCredentials | undefined {
  const payload = record(value);
  const oauth = record(record(value)?.claudeAiOauth);
  const accessToken = stringValue(oauth?.accessToken);
  if (!payload || !accessToken) return undefined;
  return {
    ...(account ? { account } : {}),
    accessToken: accessToken.toLowerCase().startsWith('bearer ') ? accessToken.slice(7).trim() : accessToken,
    expiresAt: numberValue(oauth?.expiresAt) ?? numberValue(oauth?.expires_at),
    payload,
    rateLimitTier: stringValue(oauth?.rateLimitTier) ?? stringValue(oauth?.rate_limit_tier),
    refreshToken: stringValue(oauth?.refreshToken) ?? stringValue(oauth?.refresh_token),
    source,
    subscriptionType: stringValue(oauth?.subscriptionType) ?? stringValue(oauth?.subscription_type),
  };
}

async function fetchClaudeUsageWithToken(token: string): ReturnType<typeof fetchJson> {
  return fetchJson({
    headers: {
      Accept: 'application/json',
      Authorization: bearer(token),
      'Content-Type': 'application/json',
      'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
    },
    url: CLAUDE_USAGE_API,
  });
}

async function refreshClaudeCredentials(
  credentials: ClaudeCredentials,
): Promise<{ credentials: ClaudeCredentials; error?: never } | { credentials?: never; error: NonNullable<Awaited<ReturnType<typeof fetchJson>>['error']> }> {
  if (!credentials.refreshToken) {
    return { error: usageError('unauthorized', 'Claude Code refresh token not found. Run `claude` to authenticate again.') };
  }

  const result = await fetchJson({
    body: JSON.stringify({
      client_id: CLAUDE_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
    },
    method: 'POST',
    url: CLAUDE_REFRESH_TOKEN_API,
  });
  if (result.error) return { error: result.error };

  const response = record(result.data);
  const accessToken = stringValue(response?.access_token);
  if (!accessToken) {
    return { error: usageError('parse_error', 'Claude Code refresh response did not include an access token.') };
  }

  const nowMs = Date.now();
  const expiresIn = numberValue(response?.expires_in);
  const refreshTokenExpiresIn = numberValue(response?.refresh_token_expires_in);
  const oauth = {
    ...record(credentials.payload.claudeAiOauth),
    accessToken,
    ...(stringValue(response?.refresh_token) ? { refreshToken: stringValue(response?.refresh_token) } : {}),
    ...(expiresIn !== undefined ? { expiresAt: nowMs + expiresIn * 1000 } : {}),
    ...(refreshTokenExpiresIn !== undefined ? { refreshTokenExpiresAt: nowMs + refreshTokenExpiresIn * 1000 } : {}),
    ...(Array.isArray(response?.scope) ? { scopes: response.scope } : {}),
  };
  const payload = {
    ...credentials.payload,
    claudeAiOauth: oauth,
  };

  try {
    await writeClaudeCredentials(credentials.source, payload);
  } catch {
    return { error: usageError('unknown', 'Claude Code token refreshed but could not be saved. Check Claude credential storage permissions.') };
  }
  const refreshed = extractClaudeCredentials(payload, credentials.source, credentials.account);
  return refreshed
    ? { credentials: refreshed }
    : { error: usageError('parse_error', 'Claude Code refreshed credentials could not be parsed.') };
}

async function writeClaudeCredentials(source: ClaudeCredentials['source'], payload: Record<string, unknown>): Promise<void> {
  if (source.kind === 'file') {
    await writeJsonFile(source.path, payload);
    return;
  }

  await execFileAsync(
    'security',
    [
      'add-generic-password',
      '-a',
      source.account,
      '-s',
      CLAUDE_KEYCHAIN_SERVICE,
      '-w',
      JSON.stringify(payload),
      '-U',
    ],
    { timeout: 5_000 },
  );
}

function parseJsonOrHex(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const hex = text.trim().replace(/^0x/i, '');
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
    try {
      return JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
    } catch {
      return undefined;
    }
  }
}

// Model-scoped weekly quotas moved into the `limits` array; each entry carries the
// active model under scope.model.display_name (e.g. "Fable"). The legacy top-level
// seven_day_sonnet / seven_day_opus fields now return null, so read these here too.
function claudeScopedWeeklyWindows(value: unknown): ProviderUsageWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: ProviderUsageWindow[] = [];
  for (const entry of value) {
    const limit = record(entry);
    if (!limit || stringValue(limit.kind) !== 'weekly_scoped') continue;
    const modelName = stringValue(record(record(limit.scope)?.model)?.display_name);
    if (!modelName) continue;
    const window = windowFromUsedPercent(`Weekly ${modelName}`, numberValue(limit.percent), {
      ...(resetAtFromValue(limit.resets_at) ? { resetsAt: resetAtFromValue(limit.resets_at) } : {}),
    });
    if (window) windows.push(window);
  }
  return windows;
}

function dedupeWindowsByLabel(windows: ProviderUsageWindow[]): ProviderUsageWindow[] {
  const seen = new Set<string>();
  return windows.filter((window) => {
    if (seen.has(window.label)) return false;
    seen.add(window.label);
    return true;
  });
}

function claudeWindow(label: string, value: unknown): ProviderUsageWindow | undefined {
  const window = record(value);
  const utilization = numberValue(window?.utilization);
  if (utilization === undefined) return undefined;
  return {
    label,
    remainingPercent: clampPercent(100 - utilization),
    ...(resetAtFromValue(window?.resets_at) ? { resetsAt: resetAtFromValue(window?.resets_at) } : {}),
    usedPercent: clampPercent(utilization),
  };
}

function inferPlan(rateLimitTier?: string, subscriptionType?: string): string | undefined {
  const joined = `${rateLimitTier ?? ''} ${subscriptionType ?? ''}`.toLowerCase();
  if (!joined.trim()) return undefined;
  if (joined.includes('max')) return 'Claude Max';
  if (joined.includes('pro')) return 'Claude Pro';
  if (joined.includes('team')) return 'Claude Team';
  if (joined.includes('enterprise')) return 'Claude Enterprise';
  return undefined;
}
