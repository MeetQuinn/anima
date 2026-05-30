import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  clampPercent,
  homePath,
  numberValue,
  readJsonFile,
  record,
  resetAtFromValue,
  stringValue,
} from './common.js';

const execFileAsync = promisify(execFile);
const CLAUDE_USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CREDENTIALS_PATH = ['.claude', '.credentials.json'];
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';

interface ClaudeCredentials {
  accessToken: string;
  rateLimitTier?: string;
  subscriptionType?: string;
}

export async function fetchClaudeUsage(): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const credentials = await readClaudeCredentials();
  if (!credentials) {
    return unavailable(usageError('not_configured', 'Claude Code OAuth token not found. Run `claude` to authenticate.'));
  }

  const result = await fetchJson({
    headers: {
      Accept: 'application/json',
      Authorization: bearer(credentials.accessToken),
      'Content-Type': 'application/json',
      'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
    },
    url: CLAUDE_USAGE_API,
  });
  if (result.error) return unavailable(result.error);
  const parsed = parseClaudeUsageResponse(result.data, credentials);
  if (parsed.error) return unavailable(parsed.error);
  return available(parsed.windows, parsed.extras);
}

export function parseClaudeUsageResponse(
  data: unknown,
  credentials: Pick<ClaudeCredentials, 'rateLimitTier' | 'subscriptionType'> = {},
): { error?: ReturnType<typeof usageError>; extras: ProviderUsageExtra[]; windows: ProviderUsageWindow[] } {
  const root = record(data);
  if (!root) return { error: usageError('parse_error', 'Claude usage response is not an object'), extras: [], windows: [] };

  const windows = [
    claudeWindow('5h', root.five_hour),
    claudeWindow('Weekly', root.seven_day),
    claudeWindow('Weekly Sonnet', root.seven_day_sonnet),
    claudeWindow('Weekly Opus', root.seven_day_opus),
  ].filter((window): window is ProviderUsageWindow => Boolean(window));

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
  const fileCredentials = extractClaudeCredentials(await readJsonFile(homePath(...CLAUDE_CREDENTIALS_PATH)));
  if (fileCredentials) return fileCredentials;
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return extractClaudeCredentials(parseJsonOrHex(stdout));
  } catch {
    return undefined;
  }
}

function extractClaudeCredentials(value: unknown): ClaudeCredentials | undefined {
  const oauth = record(record(value)?.claudeAiOauth);
  const accessToken = stringValue(oauth?.accessToken);
  if (!accessToken) return undefined;
  return {
    accessToken: accessToken.toLowerCase().startsWith('bearer ') ? accessToken.slice(7).trim() : accessToken,
    rateLimitTier: stringValue(oauth?.rateLimitTier) ?? stringValue(oauth?.rate_limit_tier),
    subscriptionType: stringValue(oauth?.subscriptionType) ?? stringValue(oauth?.subscription_type),
  };
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
