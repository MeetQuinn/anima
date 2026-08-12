import type {
  ProviderUsageExtra,
  ProviderUsageRow,
  ProviderUsageWindow,
} from '@shared/provider-usage';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** "1h 26m", "5d", "3m" from an ISO reset timestamp */
export function formatReset(resetsAt: string, now: Date): string {
  const ms = new Date(resetsAt).getTime() - now.getTime();
  if (ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** "12s ago", "3m ago", "1h ago" */
export function formatAgo(checkedAt: string, now: Date): string {
  const s = Math.round((now.getTime() - new Date(checkedAt).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Meter fill color by remaining percent */
export function barColor(pct: number): string {
  if (pct >= 50) return 'bg-health-ok';
  if (pct >= 20) return 'bg-health-warn';
  return 'bg-health-error';
}

export function pctColor(pct: number): string {
  if (pct < 20) return 'text-health-error';
  if (pct < 50) return 'text-health-warn';
  return 'text-text-muted';
}

function planLabel(value: string): string {
  const labels: Record<string, string> = {
    TYPE_FREE: 'Free',
    TYPE_PURCHASE: 'Paid',
    TYPE_SUBSCRIPTION: 'Subscription',
    TYPE_TRIAL: 'Trial',
  };
  if (labels[value]) return labels[value];
  if (!value.startsWith('TYPE_')) return value;
  return value
    .replace(/^TYPE_/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/** Format a non-Plan extra row value (balances, credits, …) */
export function extraValue(e: ProviderUsageExtra): string {
  if (e.unlimited) return '∞';
  if (e.balance !== undefined) {
    return e.currency ? `${e.balance} ${e.currency}` : String(e.balance);
  }
  if (e.limit !== undefined && e.used !== undefined) {
    const remaining = e.limit - e.used;
    return e.currency ? `${remaining} ${e.currency}` : String(remaining);
  }
  if (e.limit !== undefined) return e.currency ? `${e.limit} ${e.currency}` : String(e.limit);
  return '—';
}

export function providerUsageErrorMessage(row: ProviderUsageRow): string | null {
  if (!row.error || row.error.type === 'unknown') return null;
  if (row.error.type === 'network_error') {
    return `Usage check could not reach ${row.label}. Refresh to try again.`;
  }
  return row.error.message;
}

/** The Plan extra becomes a chip next to the provider name; the rest stay rows. */
export function splitExtras(extras: ProviderUsageExtra[]): {
  plan: string | null;
  rest: ProviderUsageExtra[];
} {
  const planExtra = extras.find((e) => e.label.toLowerCase() === 'plan' && e.balance !== undefined);
  return {
    plan: planExtra?.balance !== undefined ? planLabel(planExtra.balance) : null,
    rest: extras.filter((e) => e !== planExtra),
  };
}

export function formatContextTokens(tokens: number): string {
  if (tokens % 1024 === 0) return `${tokens / 1024}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

function remainingOf(w: ProviderUsageWindow | undefined): number | undefined {
  if (!w || w.remainingPercent === undefined) return undefined;
  return Math.round(w.remainingPercent);
}

function windowSummary(windows: ProviderUsageWindow[], max = 2): string {
  const parts: string[] = [];
  for (const w of windows.slice(0, max)) {
    const pct = remainingOf(w);
    if (pct === undefined) continue;
    // Full labels (Weekly, not W) — width is the clarity budget (totoday 2026-08-01).
    parts.push(`${w.label} ${pct}%`);
  }
  return parts.join(' · ');
}

export function providerCollapsedSummary(usages: ProviderUsageRow[]): string {
  const active = usages.find((u) => u.active) ?? usages[0];
  if (!active) return 'Not configured';
  if (active.status !== 'available') {
    if (active.error?.type === 'unauthorized') return 'Auth expired';
    if (active.error?.type === 'not_configured') return 'Not configured';
    if (active.error?.type === 'network_error') return 'Unreachable';
    return 'Unavailable';
  }
  const sum = windowSummary(active.windows, 2);
  const n = usages.length;
  const summary = n > 1 ? (sum ? `${sum} · ${n} accounts` : `${n} accounts`) : (sum || 'Available');
  return active.stale ? `${summary} · cached` : summary;
}
