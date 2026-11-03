import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { PublicUrlCheck } from '../../shared/public-url.js';
import { defaultDashboardAuthService } from './dashboard-auth.service.js';
import { defaultServerSettingsService } from './settings.service.js';

const PROBE_TTL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;
interface Probe { expiresAt: number; publicHost: string; namedPublicHost?: boolean }
const probes = new Map<string, Probe>();

function createProbe(publicHost: string, now = Date.now()): string {
  for (const [nonce, probe] of probes) if (probe.expiresAt <= now) probes.delete(nonce);
  const nonce = randomBytes(18).toString('base64url');
  probes.set(nonce, { expiresAt: now + PROBE_TTL_MS, publicHost });
  return nonce;
}

/**
 * Answers a probe this process issued and has not expired, noting whether the
 * request still named the public host after the proxy.
 */
export function answerProbe(nonce: string, headers: IncomingHttpHeaders, now = Date.now()): boolean {
  const probe = probes.get(nonce);
  if (!probe || probe.expiresAt <= now) return false;
  probe.namedPublicHost = requestNamesHost(headers, probe.publicHost);
  return true;
}

/**
 * Tunnels pass the public hostname on as Host (cloudflared does by default) or
 * X-Forwarded-Host. A proxy that replaces both hides the public address.
 */
export function requestNamesHost(headers: IncomingHttpHeaders, publicHost: string): boolean {
  const forwarded = headers['x-forwarded-host'];
  const candidates = [headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded])]
    .flatMap((value) => (value ?? '').split(','));
  return candidates.some((value) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    try { return new URL(`http://${trimmed}`).hostname === publicHost; } catch { return false; }
  });
}

/**
 * Fetches a one-time probe through the public address. Only this dashboard
 * echoes the nonce, so a success proves the address reaches this Anima the way
 * Linear will, gateways and tunnels included.
 */
export async function checkPublicUrl(fetcher: typeof fetch = fetch): Promise<PublicUrlCheck> {
  const [{ publicUrl }, auth] = await Promise.all([
    defaultServerSettingsService.getPublicUrl(),
    defaultDashboardAuthService.status(),
  ]);
  const base = { publicUrl, passwordSet: auth.enabled, checkedAt: new Date().toISOString() };
  if (!publicUrl) return { ...base, reachable: false, failure: 'not_configured' };
  const nonce = createProbe(new URL(publicUrl).hostname);
  try {
    const response = await fetcher(`${publicUrl}/webhooks/probe/${nonce}`, {
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const status = response.status;
    let echoed = false;
    if (status === 200) {
      const body = await response.text().catch(() => '');
      try { echoed = (JSON.parse(body) as { probe?: unknown }).probe === nonce; } catch { /* not this Anima */ }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    if (echoed) return { ...base, reachable: true, status, hostRecognized: probes.get(nonce)?.namedPublicHost === true };
    // Cloudflare answers 502, 523 and 530 when the tunnel or its origin is down.
    const failure = (status >= 300 && status < 400) || status === 401 || status === 403 ? 'gateway'
      : status >= 500 ? 'unreachable' : 'elsewhere';
    return { ...base, reachable: false, failure, status };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ...base, reachable: false, failure: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    probes.delete(nonce);
  }
}
