import { join } from 'node:path';

import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { bearer, fetchJson } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  clampPercent,
  homePath,
  numberValue,
  readJsonFile,
  record,
  resetAtFromSeconds,
  resetAtFromValue,
  stringValue,
} from './common.js';

const KIMI_USAGE_API = 'https://api.kimi.com/coding/v1/usages';
const KIMI_CREDENTIALS_PATH = ['.kimi', 'credentials', 'kimi-code.json'];
const KIMI_OPENCODE_AUTH_PATH = ['.local', 'share', 'opencode', 'auth.json'];

export async function fetchKimiUsage(): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const token = await readKimiToken();
  if (!token) {
    return unavailable(usageError('not_configured', 'Kimi Code token not found. Run `kimi login` to authenticate.'));
  }
  const result = await fetchJson({
    headers: { Accept: 'application/json', Authorization: bearer(token) },
    url: KIMI_USAGE_API,
  });
  if (result.error) return unavailable(result.error);
  const parsed = parseKimiUsageResponse(result.data);
  if (parsed.error) return unavailable(parsed.error);
  return available(parsed.windows, parsed.extras);
}

export function parseKimiUsageResponse(
  data: unknown,
): { error?: ReturnType<typeof usageError>; extras: ProviderUsageExtra[]; windows: ProviderUsageWindow[] } {
  const root = record(data);
  if (!root) return { error: usageError('parse_error', 'Kimi usage response is not an object'), extras: [], windows: [] };

  const windows: ProviderUsageWindow[] = [];
  const summary = kimiUsageWindow('Weekly', record(root.usage));
  if (summary) windows.push(summary);

  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const [index, rawLimit] of limits.entries()) {
    const limit = record(rawLimit);
    const detail = record(limit?.detail) ?? limit;
    const window = record(limit?.window);
    const parsed = kimiUsageWindow(kimiLimitLabel(limit, detail, window, index), detail);
    if (parsed) windows.push(parsed);
  }

  if (windows.length === 0) {
    return { error: usageError('parse_error', 'Kimi usage response did not include usage windows'), extras: [], windows: [] };
  }

  const extras: ProviderUsageExtra[] = [];
  const subType = stringValue(root.subType);
  if (subType) extras.push({ label: 'Plan', balance: subType });
  const totalQuota = numberValue(root.totalQuota);
  if (totalQuota !== undefined) extras.push({ label: 'Total Quota', limit: totalQuota });
  return { extras, windows };
}

async function readKimiToken(): Promise<string | undefined> {
  const native = record(await readJsonFile(kimiCredentialsPath()));
  const nativeToken = stringValue(native?.access_token);
  if (nativeToken) return nativeToken;
  const opencode = record(await readJsonFile(homePath(...KIMI_OPENCODE_AUTH_PATH)));
  return stringValue(record(opencode?.['kimi-for-coding'])?.key) ?? stringValue(record(opencode?.['kimi-for-coding'])?.access);
}

function kimiCredentialsPath(): string {
  const shareDir = process.env.KIMI_SHARE_DIR?.trim();
  return shareDir ? join(shareDir, 'credentials', 'kimi-code.json') : homePath(...KIMI_CREDENTIALS_PATH);
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
