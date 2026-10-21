import { join } from 'node:path';

import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  clampPercent,
  decodeJwtPayload,
  homePath,
  numberValue,
  readJsonFile,
  record,
  resetAtFromSeconds,
  resetAtFromValue,
  stringValue,
} from './common.js';

const KIMI_USAGE_API = 'https://api.kimi.com/coding/v1/usages';
const KIMI_CODE_CREDENTIALS_PATH = ['.kimi-code', 'credentials', 'kimi-code.json'];
const KIMI_LEGACY_CREDENTIALS_PATH = ['.kimi', 'credentials', 'kimi-code.json'];
const KIMI_OPENCODE_AUTH_PATH = ['.local', 'share', 'opencode', 'auth.json'];

interface KimiCredentials {
  account?: string;
  accessToken: string;
}

export async function fetchKimiUsage(): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const credentials = await readKimiCredentials();
  if (!credentials) {
    return unavailable(usageError('not_configured', 'Kimi Code token not found. Run `kimi login` to authenticate.'));
  }

  let activeCredentials = credentials;
  let result = await fetchKimiUsageWithToken(activeCredentials.accessToken);
  if (result.error?.type === 'unauthorized') {
    // Kimi is the only owner of its OAuth refresh and credential file. Usage only
    // reads: it adopts a token Kimi rotated meanwhile, and never refreshes or
    // writes, which could race Kimi's own rotation and sign it out.
    const latestCredentials = await readKimiCredentials();
    if (latestCredentials && latestCredentials.accessToken !== activeCredentials.accessToken) {
      activeCredentials = latestCredentials;
      result = await fetchKimiUsageWithToken(activeCredentials.accessToken);
    }
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
  if (subType) extras.push({ label: 'Plan', balance: humanizeKimiSubType(subType) });
  const totalQuota = numberValue(root.totalQuota);
  if (totalQuota !== undefined) extras.push({ label: 'Total Quota', limit: totalQuota });
  // Prefer a human identity over opaque API userIds (e.g. d73omigl3dc3ms2e3oig).
  // Kimi's usage payload and JWT typically only carry userId/sub — no email today.
  const user = record(root.user);
  const account = kimiDisplayAccount({
    email: stringValue(user?.email) ?? stringValue(user?.emailAddress),
    name: stringValue(user?.name) ?? stringValue(user?.displayName),
    userId: stringValue(user?.userId) ?? stringValue(user?.user_id),
  });
  return { ...(account ? { account } : {}), extras, windows };
}

async function readKimiCredentials(): Promise<KimiCredentials | undefined> {
  for (const path of kimiCredentialPaths()) {
    const native = record(await readJsonFile(path));
    const nativeToken = stringValue(native?.access_token);
    if (nativeToken) {
      const account = kimiAccount(nativeToken);
      return { ...(account ? { account } : {}), accessToken: nativeToken };
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
  return kimiDisplayAccount({
    email: stringValue(claims?.email),
    name: stringValue(claims?.name) ?? stringValue(claims?.preferred_username),
    userId: stringValue(claims?.user_id) ?? stringValue(claims?.sub),
  });
}

/** Surface email/name when present; hide opaque id-only tokens from the UI. */
export function kimiDisplayAccount(parts: {
  email?: string;
  name?: string;
  userId?: string;
}): string | undefined {
  if (parts.email && parts.email.includes('@')) return parts.email;
  if (parts.name && !looksLikeOpaqueId(parts.name)) return parts.name;
  // Opaque userIds are not useful in the Providers panel identity slot.
  return undefined;
}

function humanizeKimiSubType(subType: string): string {
  const key = subType.trim().toUpperCase();
  const map: Record<string, string> = {
    TYPE_PURCHASE: 'Paid',
    TYPE_FREE: 'Free',
    TYPE_PRO: 'Pro',
    TYPE_ENTERPRISE: 'Enterprise',
    TYPE_MEMBERSHIP: 'Membership',
  };
  if (map[key]) return map[key];
  return subType
    .replace(/^TYPE_/i, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function looksLikeOpaqueId(value: string): boolean {
  const v = value.trim();
  if (!v || v.includes('@') || v.includes(' ')) return false;
  // UUIDs and long alnum ids (Kimi userId / JWT sub).
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  if (/^[a-z0-9]{16,}$/i.test(v)) return true;
  return false;
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
    telemetryLabel: 'kimi-cli',
    url: KIMI_USAGE_API,
  });
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
