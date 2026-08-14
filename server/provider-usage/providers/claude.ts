import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  claudeKeychainService,
  normalizedConfigDir,
} from './claude-credentials.js';
import {
  clampPercent,
  homePath,
  numberValue,
  readJsonFile,
  record,
  resetAtFromValue,
  stringValue,
  windowFromUsedPercent,
} from './common.js';

const execFileAsync = promisify(execFile);
const CLAUDE_USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';

interface ClaudeCredentials {
  account?: string;
  accessToken: string;
  organizationName?: string;
  organizationType?: string;
  rateLimitTier?: string;
  subscriptionType?: string;
}

const claudeUsageInFlight = new Map<
  string,
  Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>>
>();

export async function fetchClaudeUsage(
  input: { configDir?: string } = {},
): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const key = normalizedConfigDir(input.configDir) ?? homePath('.claude');
  const existing = claudeUsageInFlight.get(key);
  if (existing) return existing;
  const pending = fetchClaudeUsageOnce(input).finally(() => {
    if (claudeUsageInFlight.get(key) === pending) claudeUsageInFlight.delete(key);
  });
  claudeUsageInFlight.set(key, pending);
  return pending;
}

async function fetchClaudeUsageOnce(
  input: { configDir?: string },
): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const credentials = await readClaudeCredentials(input.configDir);
  if (!credentials) {
    return unavailable(usageError('not_configured', 'Claude Code OAuth token not found. Run `claude` to authenticate.'));
  }

  let activeCredentials = credentials;
  let result = await fetchClaudeUsageWithToken(activeCredentials.accessToken);
  if (result.error?.type === 'unauthorized') {
    // Claude Code is the sole owner of OAuth refresh and credential persistence.
    // Usage is an observational GET: it may adopt a token that Claude Code wrote
    // concurrently, but it must never rotate tokens or write the credential store.
    const latestCredentials = await readClaudeCredentials(input.configDir);
    if (latestCredentials && latestCredentials.accessToken !== activeCredentials.accessToken) {
      activeCredentials = latestCredentials;
      result = await fetchClaudeUsageWithToken(activeCredentials.accessToken);
    }
  }

  if (result.error) return unavailable(result.error, activeCredentials.account);
  const parsed = parseClaudeUsageResponse(result.data, activeCredentials);
  if (parsed.error) return unavailable(parsed.error, activeCredentials.account);
  return available(parsed.windows, parsed.extras, activeCredentials.account);
}

export function parseClaudeUsageResponse(
  data: unknown,
  credentials: Pick<
    ClaudeCredentials,
    'organizationName' | 'organizationType' | 'rateLimitTier' | 'subscriptionType'
  > = {},
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
  const plan = inferPlan(credentials);
  if (plan) extras.unshift({ label: 'Plan', balance: plan });

  return { extras, windows };
}

interface ClaudeAccountProfile {
  account?: string;
  organizationName?: string;
  organizationType?: string;
}

async function readClaudeCredentials(configDir?: string): Promise<ClaudeCredentials | undefined> {
  const normalizedDir = normalizedConfigDir(configDir);
  const profile = await readClaudeAccountProfile(normalizedDir);
  const filePath = normalizedDir
    ? join(normalizedDir, '.credentials.json')
    : homePath('.claude', '.credentials.json');
  const fileCredentials = extractClaudeCredentials(await readJsonFile(filePath), profile);
  if (fileCredentials) return fileCredentials;
  if (process.platform !== 'darwin') return undefined;
  const service = claudeKeychainService(normalizedDir);
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return extractClaudeCredentials(parseJsonOrHex(stdout), profile);
  } catch {
    return undefined;
  }
}

async function readClaudeAccountProfile(configDir?: string): Promise<ClaudeAccountProfile> {
  const config = record(await readJsonFile(configDir ? join(configDir, '.claude.json') : homePath('.claude.json')));
  const account = record(config?.oauthAccount);
  if (!account) return {};
  return {
    ...(stringValue(account.emailAddress) || stringValue(account.displayName)
      ? { account: stringValue(account.emailAddress) ?? stringValue(account.displayName) }
      : {}),
    ...(stringValue(account.organizationName) ? { organizationName: stringValue(account.organizationName) } : {}),
    ...(stringValue(account.organizationType) ? { organizationType: stringValue(account.organizationType) } : {}),
  };
}

function extractClaudeCredentials(
  value: unknown,
  profile: ClaudeAccountProfile = {},
): ClaudeCredentials | undefined {
  const payload = record(value);
  const oauth = record(record(value)?.claudeAiOauth);
  const accessToken = stringValue(oauth?.accessToken);
  if (!payload || !accessToken) return undefined;
  return {
    ...(profile.account ? { account: profile.account } : {}),
    accessToken: accessToken.toLowerCase().startsWith('bearer ') ? accessToken.slice(7).trim() : accessToken,
    ...(profile.organizationName ? { organizationName: profile.organizationName } : {}),
    ...(profile.organizationType ? { organizationType: profile.organizationType } : {}),
    rateLimitTier: stringValue(oauth?.rateLimitTier) ?? stringValue(oauth?.rate_limit_tier),
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
    telemetryLabel: 'claude-code',
    url: CLAUDE_USAGE_API,
  });
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

/**
 * Product family must prefer subscriptionType / organizationType over rateLimitTier.
 * Team seats often carry rate-limit ids like `default_claude_max_5x`; matching "max"
 * first mislabels them as personal Claude Max.
 */
function inferPlan(
  credentials: Pick<
    ClaudeCredentials,
    'organizationName' | 'organizationType' | 'rateLimitTier' | 'subscriptionType'
  > = {},
): string | undefined {
  const sub = (credentials.subscriptionType ?? '').toLowerCase();
  const orgType = (credentials.organizationType ?? '').toLowerCase();
  const tier = (credentials.rateLimitTier ?? '').toLowerCase();
  const family = `${sub} ${orgType}`.trim();

  let product: string | undefined;
  if (includesToken(family, 'team') || orgType.includes('claude_team')) product = 'Claude Team';
  else if (includesToken(family, 'enterprise') || orgType.includes('claude_enterprise')) product = 'Claude Enterprise';
  else if (includesToken(family, 'max') || orgType.includes('claude_max') || tier.includes('max')) product = 'Claude Max';
  else if (includesToken(family, 'pro') || orgType.includes('claude_pro') || tier.includes('pro')) product = 'Claude Pro';
  else return undefined;

  const parts = [product];
  const mult = tier.match(/(?:^|_)(\d+)x(?:_|$)/)?.[1];
  if (mult) parts.push(`${mult}x`);

  const orgName = credentials.organizationName?.trim();
  // Personal Max shells use auto names like "email's Organization"; skip those.
  if (product === 'Claude Team' && orgName && !/'s Organization$/i.test(orgName)) {
    parts.push(orgName);
  }
  return parts.join(' · ');
}

function includesToken(haystack: string, token: string): boolean {
  if (!haystack) return false;
  return new RegExp(`(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`).test(haystack);
}
