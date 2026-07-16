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

/**
 * Known used-percent paths on GetGrokCreditsConfig (live fixture + Raycast).
 * Do not accept arbitrary fixed32 floats — that is not fail-closed.
 */
const USAGE_PERCENT_PATHS: readonly number[][] = [
  [1, 1], // credits config top-level used percent
  [1, 7, 2], // nested weekly window used percent
];

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

export async function fetchGrokUsage(): Promise<
  Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>
> {
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
    const framed = parseGrpcWebFrames(body);
    if (framed.error) {
      return { error: usageError('parse_error', framed.error) };
    }
    const trailerStatus = framed.trailers['grpc-status'];
    if (trailerStatus !== undefined && trailerStatus !== '0') {
      return { error: grpcStatusError(trailerStatus, framed.trailers['grpc-message']) };
    }

    const payload = framed.payload;
    if (!payload || payload.length === 0) {
      return { error: usageError('parse_error', 'Grok billing response had no protobuf payload') };
    }
    const fields = scanProtobuf(payload);
    const usedPercent = firstUsagePercent(fields);
    if (usedPercent === undefined) {
      // proto3 omits default 0.0 fixed32; a known quota shell without percent means unused.
      if (!isZeroUsageOmittedShape(fields, nowMs)) {
        return { error: usageError('parse_error', 'Grok billing response did not include used percent') };
      }
    }
    const resetsAt = firstFutureTimestamp(fields, nowMs);
    return {
      snapshot: {
        resetsAt,
        usedPercent: clampPercent(usedPercent ?? 0),
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
    const response = await fetchUntilBody(
      tokenUrl,
      {
        body: body.toString(),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      },
      REFRESH_TIMEOUT_MS,
    );

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

    const data = record(JSON.parse(response.bodyText));
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
  try {
    const response = await fetchUntilBody(
      GROK_BILLING_API,
      {
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
      },
      BILLING_TIMEOUT_MS,
    );

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
      return { error: grpcStatusError(headerStatus, response.headers.get('grpc-message') ?? undefined) };
    }

    return parseGrokBillingBytes(response.bodyBytes);
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

/**
 * Abort covers headers **and** body consumption. Clearing the timer after
 * `fetch()` resolves (headers only) leaves body stalls hanging forever.
 * Race body read against the abort signal because some runtimes do not reject
 * `arrayBuffer()` promptly when only the request signal aborts mid-stream.
 *
 * Exported so unit tests can exercise the timeout contract without changing
 * the production `fetchGrokUsage()` surface.
 */
export async function fetchUntilBody(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ bodyBytes: Uint8Array; bodyText: string; headers: Headers; status: number; ok: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bodyBytes = new Uint8Array(await readBodyWithAbort(response, controller.signal));
    return {
      bodyBytes,
      bodyText: new TextDecoder().decode(bodyBytes),
      headers: response.headers,
      ok: response.ok,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function readBodyWithAbort(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void response
      .arrayBuffer()
      .then((buffer) => {
        cleanup();
        if (signal.aborted) reject(abortError());
        else resolve(buffer);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function grpcStatusError(status: string, message?: string): ReturnType<typeof usageError> {
  if (status === '16' || status === '7') {
    return usageError(
      'unauthorized',
      message
        ? `Grok session rejected (${status}): ${message}`
        : 'Grok session expired or invalid. Run `grok login` to refresh credentials.',
    );
  }
  return usageError('unknown', message ? `gRPC status ${status}: ${message}` : `gRPC status ${status}`);
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
  try {
    const response = await fetchUntilBody(
      `${base}/.well-known/openid-configuration`,
      { headers: { Accept: 'application/json' }, method: 'GET' },
      REFRESH_TIMEOUT_MS,
    );
    if (!response.ok) {
      // Fallback used by the CLI / Raycast when discovery is unavailable.
      return `${base}/oauth/token`;
    }
    const data = record(JSON.parse(response.bodyText));
    return stringValue(data?.token_endpoint) ?? `${base}/oauth/token`;
  } catch {
    return `${base}/oauth/token`;
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

interface GrpcWebFrames {
  error?: string;
  payload?: Uint8Array;
  trailers: Record<string, string>;
}

/**
 * Parse every gRPC-Web frame so trailer `grpc-status` is never ignored.
 * Once framing is observed, any truncated frame length or residual tail bytes
 * is a hard parse error — never return a partial data payload as success.
 */
export function parseGrpcWebFrames(body: Uint8Array): GrpcWebFrames {
  let offset = 0;
  let payload: Uint8Array | undefined;
  let trailerText = '';
  let sawFrame = false;

  while (offset + 5 <= body.length) {
    const flags = body[offset] ?? 0;
    const length =
      ((body[offset + 1]! << 24) | (body[offset + 2]! << 16) | (body[offset + 3]! << 8) | body[offset + 4]!) >>> 0;
    offset += 5;
    if (offset + length > body.length) {
      return { error: 'truncated gRPC-Web frame', trailers: {} };
    }
    const frame = body.subarray(offset, offset + length);
    offset += length;
    sawFrame = true;
    if ((flags & 0x80) !== 0) {
      trailerText += new TextDecoder().decode(frame);
      continue;
    }
    if (frame.length > 0 && payload === undefined) payload = frame;
  }

  // Incomplete frame header (1–4 residual bytes) after complete frames.
  if (sawFrame && offset < body.length) {
    return { error: 'truncated gRPC-Web frame', trailers: {} };
  }

  const trailers: Record<string, string> = {};
  for (const line of trailerText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) trailers[key] = value;
  }

  // Unframed raw protobuf only when no gRPC-Web framing was present.
  if (!sawFrame && body.length > 0) {
    return { payload: body, trailers };
  }
  return { payload, trailers };
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

function pathEquals(a: number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isPercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function firstUsagePercent(fields: ProtoScan): number | undefined {
  for (const known of USAGE_PERCENT_PATHS) {
    const hit = fields.fixed32.find((f) => pathEquals(f.path, known) && isPercent(f.value));
    if (hit) return hit.value;
  }
  return undefined;
}

/**
 * Live schema (Raycast-aligned): future reset at [1,5,1] plus period at [1,8,1]
 * where 1=monthly and 2=weekly. When that shell is present but used-percent
 * fixed32 is omitted (proto3 default 0), treat as 0% rather than parse_error.
 * Stale/past resets and unknown period types must not invent a 0% window.
 */
function isZeroUsageOmittedShape(fields: ProtoScan, nowMs: number): boolean {
  const nowSec = nowMs / 1000;
  const hasFutureReset = fields.varint.some(
    (f) => pathEquals(f.path, [1, 5, 1]) && f.value > nowSec && f.value < 2.1e9,
  );
  const hasPeriod = fields.varint.some(
    (f) => pathEquals(f.path, [1, 8, 1]) && (f.value === 1 || f.value === 2),
  );
  return hasFutureReset && hasPeriod;
}

function firstFutureTimestamp(fields: ProtoScan, nowMs: number): string | undefined {
  const nowSec = nowMs / 1000;
  // Prefer path (1, 5, 1) when present (Raycast's primary reset field).
  const preferred = fields.varint
    .filter((f) => pathEquals(f.path, [1, 5, 1]))
    .map((f) => f.value)
    .filter((v) => v > nowSec && v < 2.1e9);
  const all = fields.varint
    .map((f) => f.value)
    .filter((v) => v > nowSec && v < 2.1e9 && v > 1.7e9);
  const pick = preferred.sort((a, b) => a - b)[0] ?? all.sort((a, b) => a - b)[0];
  return pick !== undefined ? new Date(pick * 1000).toISOString() : undefined;
}
