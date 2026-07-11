import { readFile } from 'node:fs/promises';
import { arch, hostname, release, type, version } from 'node:os';
import { join } from 'node:path';

import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  clampPercent,
  decodeJwtPayload,
  expiresSoon,
  homePath,
  numberValue,
  readJsonFile,
  record,
  resetAtFromSeconds,
  resetAtFromValue,
  stringValue,
  writeJsonFile,
} from './common.js';

const KIMI_USAGE_API = 'https://api.kimi.com/coding/v1/usages';
const KIMI_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_HEADER_VERSION = '0.23.1';
const KIMI_CODE_CREDENTIALS_PATH = ['.kimi-code', 'credentials', 'kimi-code.json'];
const KIMI_LEGACY_CREDENTIALS_PATH = ['.kimi', 'credentials', 'kimi-code.json'];
const KIMI_OPENCODE_AUTH_PATH = ['.local', 'share', 'opencode', 'auth.json'];

interface KimiCredentials {
  account?: string;
  accessToken: string;
  path?: string;
  raw?: Record<string, unknown>;
  refreshToken?: string;
}

export async function fetchKimiUsage(): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const credentials = await readKimiCredentials();
  if (!credentials) {
    return unavailable(usageError('not_configured', 'Kimi Code token not found. Run `kimi login` to authenticate.'));
  }

  let activeCredentials = credentials;
  if (activeCredentials.path && expiresSoon(activeCredentials.raw?.expires_at) && activeCredentials.refreshToken) {
    const refreshed = await refreshKimiCredentials(activeCredentials);
    if (refreshed.error) return unavailable(refreshed.error, activeCredentials.account);
    activeCredentials = refreshed.credentials;
  }

  let result = await fetchKimiUsageWithToken(activeCredentials.accessToken);
  if (result.error?.type === 'unauthorized' && activeCredentials.refreshToken) {
    const latestCredentials = await readKimiCredentials();
    if (latestCredentials && latestCredentials.accessToken !== activeCredentials.accessToken) {
      activeCredentials = latestCredentials;
    } else if (activeCredentials.path) {
      const refreshed = await refreshKimiCredentials(activeCredentials);
      if (refreshed.error) return unavailable(refreshed.error, activeCredentials.account);
      activeCredentials = refreshed.credentials;
    }
    result = await fetchKimiUsageWithToken(activeCredentials.accessToken);
  }

  if (result.error) return unavailable(result.error, activeCredentials.account);
  const parsed = parseKimiUsageResponse(result.data);
  if (parsed.error) return unavailable(parsed.error, activeCredentials.account);
  return available(parsed.windows, parsed.extras, parsed.account ?? activeCredentials.account);
}

export function parseKimiUsageResponse(
  data: unknown,
): { account?: string; error?: ReturnType<typeof usageError>; extras: ProviderUsageExtra[]; windows: ProviderUsageWindow[] } {
  const root = record(data);
  if (!root) return { error: usageError('parse_error', 'Kimi usage response is not an object'), extras: [], windows: [] };

  const summary = kimiUsageWindow('Weekly', record(root.usage));
  const windows: ProviderUsageWindow[] = [];

  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const [index, rawLimit] of limits.entries()) {
    const limit = record(rawLimit);
    const detail = record(limit?.detail) ?? limit;
    const window = record(limit?.window);
    const parsed = kimiUsageWindow(kimiLimitLabel(limit, detail, window, index), detail);
    if (parsed) windows.push(parsed);
  }
  if (summary) windows.push(summary);

  if (windows.length === 0) {
    return { error: usageError('parse_error', 'Kimi usage response did not include usage windows'), extras: [], windows: [] };
  }

  const extras: ProviderUsageExtra[] = [];
  const subType = stringValue(root.subType);
  if (subType) extras.push({ label: 'Plan', balance: subType });
  const totalQuota = numberValue(root.totalQuota);
  if (totalQuota !== undefined) extras.push({ label: 'Total Quota', limit: totalQuota });
  const account = stringValue(record(root.user)?.userId);
  return { ...(account ? { account } : {}), extras, windows };
}

async function readKimiCredentials(): Promise<KimiCredentials | undefined> {
  for (const path of kimiCredentialPaths()) {
    const native = record(await readJsonFile(path));
    const nativeToken = stringValue(native?.access_token);
    if (nativeToken) {
      const account = kimiAccount(nativeToken);
      return {
        ...(account ? { account } : {}),
        accessToken: nativeToken,
        path,
        raw: native,
        refreshToken: stringValue(native?.refresh_token),
      };
    }
  }
  const opencode = record(await readJsonFile(homePath(...KIMI_OPENCODE_AUTH_PATH)));
  const opencodeToken = stringValue(record(opencode?.['kimi-for-coding'])?.key)
    ?? stringValue(record(opencode?.['kimi-for-coding'])?.access);
  if (!opencodeToken) return undefined;
  const account = kimiAccount(opencodeToken);
  return { ...(account ? { account } : {}), accessToken: opencodeToken };
}

function kimiAccount(accessToken: string): string | undefined {
  const claims = record(decodeJwtPayload(accessToken));
  return stringValue(claims?.email) ?? stringValue(claims?.user_id) ?? stringValue(claims?.sub);
}

function kimiCredentialPaths(): string[] {
  const shareDir = process.env.KIMI_SHARE_DIR?.trim();
  return [
    ...(shareDir ? [join(shareDir, 'credentials', 'kimi-code.json')] : []),
    homePath(...KIMI_CODE_CREDENTIALS_PATH),
    homePath(...KIMI_LEGACY_CREDENTIALS_PATH),
  ];
}

async function fetchKimiUsageWithToken(token: string): ReturnType<typeof fetchJson> {
  return fetchJson({
    headers: { Accept: 'application/json', Authorization: bearer(token) },
    url: KIMI_USAGE_API,
  });
}

async function refreshKimiCredentials(
  credentials: KimiCredentials,
): Promise<{ credentials: KimiCredentials; error?: never } | { credentials?: never; error: NonNullable<Awaited<ReturnType<typeof fetchJson>>['error']> }> {
  if (!credentials.path || !credentials.raw || !credentials.refreshToken) {
    return { error: usageError('unauthorized', 'Kimi refresh token not found. Run `kimi login` to authenticate again.') };
  }

  const body = new URLSearchParams({
    client_id: KIMI_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
  });
  const result = await fetchJson({
    body: body.toString(),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(await kimiOauthHeaders()),
    },
    method: 'POST',
    url: `${kimiOauthHost()}/api/oauth/token`,
  });
  if (result.error) return { error: result.error };

  const response = record(result.data);
  const accessToken = stringValue(response?.access_token);
  const refreshToken = stringValue(response?.refresh_token);
  if (!accessToken || !refreshToken) {
    return { error: usageError('parse_error', 'Kimi refresh response did not include a complete token pair.') };
  }

  const expiresIn = numberValue(response?.expires_in);
  const raw = {
    ...credentials.raw,
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresIn !== undefined ? { expires_at: Math.floor(Date.now() / 1000) + expiresIn, expires_in: expiresIn } : {}),
    ...(stringValue(response?.scope) ? { scope: stringValue(response?.scope) } : {}),
    ...(stringValue(response?.token_type) ? { token_type: stringValue(response?.token_type) } : {}),
  };
  try {
    await writeJsonFile(credentials.path, raw);
  } catch {
    return { error: usageError('unknown', 'Kimi token refreshed but could not be saved. Check Kimi credential file permissions.') };
  }
  const account = kimiAccount(accessToken) ?? credentials.account;
  return {
    credentials: {
      ...(account ? { account } : {}),
      accessToken,
      path: credentials.path,
      raw,
      refreshToken,
    },
  };
}

function kimiOauthHost(): string {
  return (process.env.KIMI_CODE_OAUTH_HOST?.trim() || process.env.KIMI_OAUTH_HOST?.trim() || KIMI_OAUTH_HOST).replace(/\/+$/, '');
}

async function kimiOauthHeaders(): Promise<Record<string, string>> {
  return {
    'X-Msh-Device-Id': await readKimiDeviceId(),
    'X-Msh-Device-Model': `${type()} ${release()} ${arch()}`,
    'X-Msh-Device-Name': hostname() || 'localhost',
    'X-Msh-Os-Version': version(),
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': process.env.KIMI_CODE_VERSION?.trim() || KIMI_HEADER_VERSION,
  };
}

async function readKimiDeviceId(): Promise<string> {
  for (const path of kimiDeviceIdPaths()) {
    try {
      const deviceId = stringValue(await readFile(path, 'utf8'));
      if (deviceId) return deviceId;
    } catch {
      // Try the next known Kimi share path.
    }
  }
  return 'anima-provider-usage';
}

function kimiDeviceIdPaths(): string[] {
  const shareDir = process.env.KIMI_SHARE_DIR?.trim();
  return [
    ...(shareDir ? [join(shareDir, 'device_id')] : []),
    homePath('.kimi-code', 'device_id'),
    homePath('.kimi', 'device_id'),
  ];
}

function kimiUsageWindow(label: string, data: Record<string, unknown> | undefined): ProviderUsageWindow | undefined {
  if (!data) return undefined;
  const limit = numberValue(data?.limit);
  const used = numberValue(data?.used);
  const remaining = numberValue(data?.remaining);
  const remainingPercent = limit && remaining !== undefined
    ? (remaining / limit) * 100
    : limit && used !== undefined
      ? ((limit - used) / limit) * 100
      : undefined;
  if (remainingPercent === undefined) return undefined;
  const resetAfterSeconds = numberValue(data?.reset_in) ?? numberValue(data?.resetIn) ?? numberValue(data?.ttl);
  return {
    label,
    remainingPercent: clampPercent(remainingPercent),
    ...(resetAt(data, resetAfterSeconds) ? { resetsAt: resetAt(data, resetAfterSeconds) } : {}),
    ...(limit && used !== undefined ? { usedPercent: clampPercent((used / limit) * 100) } : {}),
  };
}

function resetAt(data: Record<string, unknown>, resetAfterSeconds: number | undefined): string | undefined {
  return resetAtFromValue(data.resetTime)
    ?? resetAtFromValue(data.reset_at)
    ?? resetAtFromValue(data.resetAt)
    ?? resetAtFromValue(data.reset_time)
    ?? (resetAfterSeconds !== undefined ? resetAtFromSeconds(resetAfterSeconds) : undefined);
}

function kimiLimitLabel(
  item: Record<string, unknown> | undefined,
  detail: Record<string, unknown> | undefined,
  window: Record<string, unknown> | undefined,
  index: number,
): string {
  const named = stringValue(item?.name)
    ?? stringValue(item?.title)
    ?? stringValue(item?.scope)
    ?? stringValue(detail?.name)
    ?? stringValue(detail?.title)
    ?? stringValue(detail?.scope);
  if (named) return named;
  const duration = numberValue(window?.duration) ?? numberValue(item?.duration) ?? numberValue(detail?.duration);
  const unit = (stringValue(window?.timeUnit) ?? stringValue(item?.timeUnit) ?? stringValue(detail?.timeUnit) ?? '').toUpperCase();
  if (duration) {
    if (unit.includes('HOUR')) return `${duration}h`;
    if (unit.includes('DAY')) return `${duration}d`;
    if (unit.includes('MINUTE')) return duration >= 60 && duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
  }
  return `Limit ${index + 1}`;
}
