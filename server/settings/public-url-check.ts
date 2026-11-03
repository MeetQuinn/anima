import { randomBytes } from 'node:crypto';

import type { PublicUrlCheck } from '../../shared/public-url.js';
import { defaultDashboardAuthService } from './dashboard-auth.service.js';
import { defaultServerSettingsService } from './settings.service.js';

const PROBE_TTL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;

/**
 * Where each probe is answered. `webhooks` sits beside Linear's events, which pass
 * any sign-in gateway. `dashboard` is an ordinary dashboard API path: the dashboard
 * password guards it like every other `/api/` path, and a gateway that protects the
 * dashboard protects it too.
 */
export type ProbeKind = 'webhooks' | 'dashboard';
export const DASHBOARD_PROBE_PATH = '/api/settings/public-url/probe';
const PROBE_PATHS: Record<ProbeKind, string> = {
  webhooks: '/webhooks/probe',
  dashboard: DASHBOARD_PROBE_PATH,
};
const probes = new Map<string, { kind: ProbeKind; expiresAt: number }>();

function createProbe(kind: ProbeKind, now = Date.now()): string {
  for (const [nonce, probe] of probes) if (probe.expiresAt <= now) probes.delete(nonce);
  const nonce = randomBytes(18).toString('base64url');
  probes.set(nonce, { kind, expiresAt: now + PROBE_TTL_MS });
  return nonce;
}

/** Answers a probe of this kind that this process issued and has not expired. */
export function answerProbe(nonce: string, kind: ProbeKind, now = Date.now()): boolean {
  const probe = probes.get(nonce);
  return probe !== undefined && probe.kind === kind && probe.expiresAt > now;
}

type ProbeResult = { status: number; echoed: boolean } | { error: 'timeout' | 'unreachable' };

/** Fetches a one-time probe through the public address, without credentials. */
async function probe(fetcher: typeof fetch, publicUrl: string, kind: ProbeKind): Promise<ProbeResult> {
  const nonce = createProbe(kind);
  try {
    const response = await fetcher(`${publicUrl}${PROBE_PATHS[kind]}/${nonce}`, {
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
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
    return { status, echoed };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { error: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    probes.delete(nonce);
  }
}

/**
 * Probes the public address twice at once. Only this dashboard echoes a nonce it
 * issued, so the `/webhooks/` echo proves that requests through the address,
 * gateways and tunnels included, arrive at this dashboard. It says nothing about
 * the runtime's Linear receiver, which runs only with a connected agent. The
 * dashboard echo means anyone who can open the address gets the dashboard: no
 * gateway asked first and the dashboard has no password. The check only reports;
 * it never blocks a request.
 */
export async function checkPublicUrl(fetcher: typeof fetch = fetch): Promise<PublicUrlCheck> {
  const [{ publicUrl }, auth] = await Promise.all([
    defaultServerSettingsService.getPublicUrl(),
    defaultDashboardAuthService.status(),
  ]);
  const base = { publicUrl, passwordSet: auth.enabled, checkedAt: new Date().toISOString() };
  if (!publicUrl) return { ...base, reachable: false, failure: 'not_configured' };
  const [webhooks, dashboard] = await Promise.all([
    probe(fetcher, publicUrl, 'webhooks'),
    probe(fetcher, publicUrl, 'dashboard'),
  ]);
  const checked = 'status' in dashboard
    ? { ...base, dashboard: { open: dashboard.echoed, status: dashboard.status } }
    : base;
  if ('error' in webhooks) return { ...checked, reachable: false, failure: webhooks.error };
  const { status } = webhooks;
  if (webhooks.echoed) return { ...checked, reachable: true, status };
  // Cloudflare answers 502, 523 and 530 when the tunnel or its origin is down.
  const failure = (status >= 300 && status < 400) || status === 401 || status === 403 ? 'gateway'
    : status >= 500 ? 'unreachable' : 'elsewhere';
  return { ...checked, reachable: false, failure, status };
}
