import { join } from 'node:path';

import type { ProviderUsageExtra, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { providerUsageNetworkErrorMessage } from '../http.js';
import { available, unavailable, usageError } from '../result.js';
import {
  clampPercent,
  expiresSoon,
  homePath,
  providerHome,
  readJsonFile,
  record,
  stringValue,
  writeJsonFile,
} from './common.js';

/** Same endpoint Raycast Agent Usage uses for SuperGrok / Grok Build credits. */
const GROK_BILLING_API = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const GROK_OIDC_ISSUER_DEFAULT = 'https://auth.x.ai';
const GROK_AUTH_SCOPE_PREFIX = 'https://auth.x.ai::';
/** Empty gRPC-Web request frame (flags=0, length=0). */
const EMPTY_GRPC_WEB_BODY = new Uint8Array([0, 0, 0, 0, 0]);
const BILLING_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 15_000;

interface GrokCredentials {
  accessToken: string;
  account?: string;
  expiresAt?: string;
  oidcClientId?: string;
  oidcIssuer: string;
  refreshToken?: string;
  scope: string;
  sourcePath: string;
  teamId?: string;
}

export async function fetchGrokUsage(): Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>> {
  const credentials = await readGrokCredentials();
  if (!credentials) {
    return unavailable(usageError('not_configured', 'Grok Build credentials not found. Run `grok login` to authenticate.'));
  }

  let active = credentials;
  if (grokExpiresSoon(active.expiresAt) && active.refreshToken && active.oidcClientId) {
    const refreshed = await refreshGrokCredentials(active);
    if (refreshed.error) return unavailable(refreshed.error, active.account);
    active = refreshed.credentials;
  }

  let result = await fetchGrokBilling(active.accessToken);
  if (result.error?.type === 'unauthorized' && active.refreshToken && active.oidcClientId) {
    const refreshed = await refreshGrokCredentials(active);
    if (refreshed.error) return unavailable(refreshed.error, active.account);
    active = refreshed.credentials;
    result = await fetchGrokBilling(active.accessToken);
  }

  if (result.error) return unavailable(result.error, active.account);
  if (!result.snapshot) {
    return unavailable(usageError('unknown', 'Grok billing response did not include usage data'), active.account);
  }

  const windows = grokWindows(result.snapshot);
  if (windows.length === 0) {
    return unavailable(usageError('parse_error', 'Grok billing response did not include quota windows'), active.account);
  }

  const extras: ProviderUsageExtra[] = [];
  // Plan name is not always present in auth.json; SuperGrok/Heavy are account-side labels.
  if (active.teamId) extras.push({ label: 'Team', balance: active.teamId });

  return available(windows, extras, active.account);
}

export function parseGrokBillingBytes(
  body: Uint8Array,
  nowMs: number = Date.now(),
): { error?: ReturnType<typeof usageError>; snapshot?: GrokBillingSnapshot } {
  try {
    const payload = firstGrpcWebPayload(body);
    if (!payload || payload.length === 0) {
      return { error: usageError('parse_error', 'Grok billing response had no protobuf payload') };
    }
    const fields = scanProtobuf(payload);
    const usedPercent = firstUsagePercent(fields);
    if (usedPercent === undefined) {
      return { error: usageError('parse_error', 'Grok billing response did not include used percent') };
    }
    const resetsAt = firstFutureTimestamp(fields, nowMs);
    return {
      snapshot: {
        resetsAt,
        usedPercent: clampPercent(usedPercent),
      },
    };
  } catch (error) {
    return {
      error: usageError(
        'parse_error',
        error instanceof Error ? error.message : 'Could not parse Grok billing usage',
      ),
    };
  }
}

interface GrokBillingSnapshot {
  resetsAt?: string;
  usedPercent: number;
}

async function readGrokCredentials(): Promise<GrokCredentials | undefined> {
  const sourcePath = grokAuthPath();
  const root = record(await readJsonFile(sourcePath));
  if (!root) return undefined;

  for (const [scope, value] of Object.entries(root)) {
    const entry = record(value);
    // CLI stores the access token as `key` (Raycast Agent Usage reads the same field).
    const accessToken = stringValue(entry?.key) ?? stringValue(entry?.accessToken) ?? stringValue(entry?.access_token);
    if (!accessToken) continue;
    const email = stringValue(entry?.email);
    return {
      accessToken,
      ...(email ? { account: email } : {}),
      expiresAt: stringValue(entry?.expires_at) ?? stringValue(entry?.expiresAt),
      oidcClientId: stringValue(entry?.oidc_client_id)
        ?? stringValue(entry?.oidcClientId)
        ?? clientIdFromScope(scope),
      oidcIssuer: stringValue(entry?.oidc_issuer) ?? stringValue(entry?.oidcIssuer) ?? GROK_OIDC_ISSUER_DEFAULT,
      refreshToken: stringValue(entry?.refresh_token) ?? stringValue(entry?.refreshToken),
      scope,
      sourcePath,
      teamId: stringValue(entry?.team_id) ?? stringValue(entry?.teamId),
    };
  }
  return undefined;
}

async function refreshGrokCredentials(
  credentials: GrokCredentials,
): Promise<
  | { credentials: GrokCredentials; error?: never }
  | { credentials?: never; error: NonNullable<ReturnType<typeof usageError>> }
> {
  if (!credentials.refreshToken || !credentials.oidcClientId) {
    return {
      error: usageError('unauthorized', 'Grok refresh token not found. Run `grok login` to authenticate again.'),
    };
  }

  try {
    const tokenUrl = await discoverTokenEndpoint(credentials.oidcIssuer);
    const body = new URLSearchParams({
      client_id: credentials.oidcClientId,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        body: body.toString(),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      return {
        error: usageError('unauthorized', 'Grok session expired or invalid. Run `grok login` to refresh credentials.'),
      };
    }
    if (!response.ok) {
      return {
        error: usageError('unknown', `Grok token refresh failed with HTTP ${response.status}`),
      };
    }

    const data = record(await response.json());
    const accessToken = stringValue(data?.access_token);
    if (!accessToken) {
      return { error: usageError('parse_error', 'Grok refresh response did not include an access token.') };
    }
    const refreshToken = stringValue(data?.refresh_token) ?? credentials.refreshToken;
    const expiresIn = typeof data?.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? data.expires_in
      : numberFromUnknown(data?.expires_in);
    const expiresAt = expiresIn !== undefined && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : credentials.expiresAt;

    await writeGrokAccessToken(credentials, {
      accessToken,
      ...(expiresAt ? { expiresAt } : {}),
      refreshToken,
    });

    return {
      credentials: {
        ...credentials,
        accessToken,
        ...(expiresAt ? { expiresAt } : {}),
        refreshToken,
      },
    };
  } catch (error) {
    return {
      error: usageError(
        'network_error',
        error instanceof Error && error.name === 'AbortError'
          ? 'Provider usage request timed out.'
          : providerUsageNetworkErrorMessage(error),
      ),
    };
  }
}

async function writeGrokAccessToken(
  credentials: GrokCredentials,
  next: { accessToken: string; expiresAt?: string; refreshToken: string },
): Promise<void> {
  const root = record(await readJsonFile(credentials.sourcePath)) ?? {};
  const entry = record(root[credentials.scope]) ?? {};
  root[credentials.scope] = {
    ...entry,
    key: next.accessToken,
    refresh_token: next.refreshToken,
    ...(next.expiresAt ? { expires_at: next.expiresAt } : {}),
  };
  await writeJsonFile(credentials.sourcePath, root);
}

async function fetchGrokBilling(
  accessToken: string,
): Promise<{ error?: ReturnType<typeof usageError>; snapshot?: GrokBillingSnapshot }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BILLING_TIMEOUT_MS);
  try {
    const response = await fetch(GROK_BILLING_API, {
      body: EMPTY_GRPC_WEB_BODY,
      headers: {
        Accept: '*/*',
        Authorization: accessToken.toLowerCase().startsWith('bearer ') ? accessToken : `Bearer ${accessToken}`,
        'Content-Type': 'application/grpc-web+proto',
        Origin: 'https://grok.com',
        Referer: 'https://grok.com/?_s=usage',
        'User-Agent': 'Anima/provider-usage',
        'x-grpc-web': '1',
        'x-user-agent': 'connect-es/2.1.1',
      },
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.status === 401 || response.status === 403) {
      return {
        error: usageError('unauthorized', 'Grok session expired or invalid. Run `grok login` to refresh credentials.'),
      };
    }
    if (!response.ok) {
      return {
        error: usageError('unknown', `Grok billing request failed with HTTP ${response.status}`),
      };
    }

    const headerStatus = response.headers.get('grpc-status');
    if (headerStatus && headerStatus !== '0') {
      const message = response.headers.get('grpc-message') ?? '';
      if (headerStatus === '16' || headerStatus === '7') {
        return {
          error: usageError(
            'unauthorized',
            message
              ? `Grok session rejected (${headerStatus}): ${message}`
              : 'Grok session expired or invalid. Run `grok login` to refresh credentials.',
          ),
        };
      }
      return {
        error: usageError('unknown', message ? `gRPC status ${headerStatus}: ${message}` : `gRPC status ${headerStatus}`),
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return parseGrokBillingBytes(bytes);
  } catch (error) {
    clearTimeout(timeout);
    return {
      error: usageError(
        'network_error',
        error instanceof Error && error.name === 'AbortError'
          ? 'Provider usage request timed out.'
          : providerUsageNetworkErrorMessage(error),
      ),
    };
  }
}

function grokWindows(snapshot: GrokBillingSnapshot): ProviderUsageWindow[] {
  const used = snapshot.usedPercent;
  const remaining = clampPercent(100 - used);
  const label = windowLabel(snapshot.resetsAt);
  return [{
    label,
    remainingPercent: remaining,
    ...(snapshot.resetsAt ? { resetsAt: snapshot.resetsAt } : {}),
    usedPercent: used,
  }];
}

function windowLabel(resetsAt: string | undefined, nowMs: number = Date.now()): string {
  if (!resetsAt) return 'Credits';
  const ms = Date.parse(resetsAt) - nowMs;
  if (!Number.isFinite(ms) || ms <= 3_600_000) return 'Credits';
  const days = Math.round(ms / 86_400_000);
  if (days >= 4 && days <= 12) return 'Weekly';
  if (days >= 20 && days <= 45) return 'Monthly';
  return 'Credits';
}

function grokAuthPath(): string {
  const grokHome = process.env.GROK_HOME?.trim();
  if (grokHome) {
    if (grokHome === '~') return join(providerHome(), 'auth.json');
    if (grokHome.startsWith('~/') || grokHome.startsWith('~\\')) {
      return join(providerHome(), grokHome.slice(2), 'auth.json');
    }
    return join(grokHome, 'auth.json');
  }
  return homePath('.grok', 'auth.json');
}

function clientIdFromScope(scope: string): string | undefined {
  if (!scope.startsWith(GROK_AUTH_SCOPE_PREFIX)) return undefined;
  const id = scope.slice(GROK_AUTH_SCOPE_PREFIX.length).trim();
  return id || undefined;
}

/** Grok stores `expires_at` as ISO-8601; shared expiresSoon only handles numeric epochs. */
function grokExpiresSoon(expiresAt: string | undefined, skewMs = 60_000, nowMs: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (Number.isFinite(parsed)) return parsed <= nowMs + skewMs;
  return expiresSoon(expiresAt, skewMs / 1000, nowMs);
}

async function discoverTokenEndpoint(issuer: string): Promise<string> {
  const base = issuer.replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      // Fallback used by the CLI / Raycast when discovery is unavailable.
      return `${base}/oauth/token`;
    }
    const data = record(await response.json());
    return stringValue(data?.token_endpoint) ?? `${base}/oauth/token`;
  } catch {
    return `${base}/oauth/token`;
  } finally {
    clearTimeout(timeout);
  }
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

// --- gRPC-Web + protobuf (minimal scan; mirrors Raycast Agent Usage) ---

function firstGrpcWebPayload(body: Uint8Array): Uint8Array | undefined {
  let offset = 0;
  while (offset + 5 <= body.length) {
    const flags = body[offset] ?? 0;
    const length = (body[offset + 1]! << 24)
      | (body[offset + 2]! << 16)
      | (body[offset + 3]! << 8)
      | body[offset + 4]!;
    offset += 5;
    if (length < 0 || offset + length > body.length) break;
    const frame = body.subarray(offset, offset + length);
    offset += length;
    // Trailers frame (MSB of flags) is not a message payload.
    if ((flags & 0x80) !== 0) continue;
    if (frame.length > 0) return frame;
  }
  // Some servers return raw protobuf without framing.
  return body.length > 0 ? body : undefined;
}

interface ProtoScan {
  fixed32: Array<{ path: number[]; value: number }>;
  varint: Array<{ path: number[]; value: number }>;
}

function scanProtobuf(buf: Uint8Array, depth = 0, path: number[] = []): ProtoScan {
  const out: ProtoScan = { fixed32: [], varint: [] };
  let i = 0;
  while (i < buf.length) {
    const start = i;
    const key = readVarint(buf, { value: i });
    if (key === null) break;
    i = key.next;
    if (key.value === 0) {
      i = start + 1;
      continue;
    }
    const field = key.value >>> 3;
    const wire = key.value & 7;
    const nextPath = [...path, field];
    if (wire === 0) {
      const v = readVarint(buf, { value: i });
      if (v === null) break;
      i = v.next;
      out.varint.push({ path: nextPath, value: v.value });
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 2) {
      const len = readVarint(buf, { value: i });
      if (len === null || len.value > buf.length - len.next) break;
      const startSub = len.next;
      const endSub = startSub + len.value;
      i = endSub;
      if (depth < 4) {
        const nested = scanProtobuf(buf.subarray(startSub, endSub), depth + 1, nextPath);
        out.fixed32.push(...nested.fixed32);
        out.varint.push(...nested.varint);
      }
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      const view = new DataView(buf.buffer, buf.byteOffset + i, 4);
      out.fixed32.push({ path: nextPath, value: view.getFloat32(0, true) });
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

function readVarint(buf: Uint8Array, cursor: { value: number }): { next: number; value: number } | null {
  let result = 0;
  let shift = 0;
  let i = cursor.value;
  while (i < buf.length && shift < 35) {
    const byte = buf[i]!;
    i += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      cursor.value = i;
      return { next: i, value: result >>> 0 };
    }
    shift += 7;
  }
  return null;
}

function firstUsagePercent(fields: ProtoScan): number | undefined {
  // Prefer field-number-1 floats in 0..100 (Raycast selects path ending in 1).
  const candidates = fields.fixed32
    .filter((f) => f.path[f.path.length - 1] === 1 && Number.isFinite(f.value) && f.value >= 0 && f.value <= 100)
    .sort((a, b) => a.path.length - b.path.length || 0);
  if (candidates[0]) return candidates[0].value;
  const any = fields.fixed32.find((f) => Number.isFinite(f.value) && f.value >= 0 && f.value <= 100);
  return any?.value;
}

function firstFutureTimestamp(fields: ProtoScan, nowMs: number): string | undefined {
  const nowSec = nowMs / 1000;
  // Prefer path (1, 5, 1) when present (Raycast's primary reset field).
  const preferred = fields.varint
    .filter((f) => f.path.length === 3 && f.path[0] === 1 && f.path[1] === 5 && f.path[2] === 1)
    .map((f) => f.value)
    .filter((v) => v > nowSec && v < 2.1e9);
  const all = fields.varint
    .map((f) => f.value)
    .filter((v) => v > nowSec && v < 2.1e9 && v > 1.7e9);
  const pick = preferred.sort((a, b) => a - b)[0] ?? all.sort((a, b) => a - b)[0];
  return pick !== undefined ? new Date(pick * 1000).toISOString() : undefined;
}
