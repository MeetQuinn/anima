import { randomBytes } from 'node:crypto';

import type { PublicUrlCheck } from '../../shared/public-url.js';
import { defaultDashboardAuthService } from './dashboard-auth.service.js';
import { defaultServerSettingsService } from './settings.service.js';

const PROBE_TTL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;
const probes = new Map<string, number>();

function createProbe(now = Date.now()): string {
  for (const [nonce, expiresAt] of probes) if (expiresAt <= now) probes.delete(nonce);
  const nonce = randomBytes(18).toString('base64url');
  probes.set(nonce, now + PROBE_TTL_MS);
  return nonce;
}

/** Answers a probe this process issued and has not expired. */
export function answerProbe(nonce: string, now = Date.now()): boolean {
  const expiresAt = probes.get(nonce);
  return expiresAt !== undefined && expiresAt > now;
}

/**
 * Fetches a one-time probe through the public address. Only this dashboard
 * echoes the nonce, so a success proves that requests through the address,
 * gateways and tunnels included, arrive at this dashboard. It says nothing
 * about the runtime's Linear receiver, which runs only with a connected agent.
 */
export async function checkPublicUrl(fetcher: typeof fetch = fetch): Promise<PublicUrlCheck> {
  const [{ publicUrl }, auth] = await Promise.all([
    defaultServerSettingsService.getPublicUrl(),
    defaultDashboardAuthService.status(),
  ]);
  const base = { publicUrl, passwordSet: auth.enabled, checkedAt: new Date().toISOString() };
  if (!publicUrl) return { ...base, reachable: false, failure: 'not_configured' };
  const nonce = createProbe();
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
    if (echoed) return { ...base, reachable: true, status };
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
