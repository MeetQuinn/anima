import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';
import { fetchServerInfo, fetchProviderUsage, fetchProviderUsageProvider, pingHealth } from '@/api/system';
import { shortIso, formatUptime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import RestartButton from './RestartButton';
import RuntimeUpgradeRow from './RuntimeUpgrade';
import type { ProviderUsageKind, ProviderUsageResponse, ProviderUsageRow, ProviderUsageWindow, ProviderUsageExtra } from '@shared/provider-usage';

interface Props {
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Provider usage helpers
// ---------------------------------------------------------------------------

/** "1h 26m", "5d", "3m" from an ISO reset timestamp */
function formatReset(resetsAt: string, now: Date): string {
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
function formatAgo(checkedAt: string, now: Date): string {
  const s = Math.round((now.getTime() - new Date(checkedAt).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Bar fill color based on remaining percent */
function barColor(pct: number): string {
  if (pct >= 50) return 'bg-health-ok';
  if (pct >= 20) return 'bg-health-warn';
  return 'bg-health-error';
}

/** Format a single extra row value */
function extraValue(e: ProviderUsageExtra): string {
  if (e.unlimited) return '∞';
  if (e.balance !== undefined) {
    if (e.label.toLowerCase() === 'plan') {
      return planLabel(e.balance);
    }
    return e.currency ? `${e.balance} ${e.currency}` : String(e.balance);
  }
  if (e.limit !== undefined && e.used !== undefined) {
    const remaining = e.limit - e.used;
    return e.currency ? `${remaining} ${e.currency}` : String(remaining);
  }
  if (e.limit !== undefined) return e.currency ? `${e.limit} ${e.currency}` : String(e.limit);
  return '—';
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

function providerUsageErrorMessage(row: ProviderUsageRow): string | null {
  if (!row.error || row.error.type === 'unknown') return null;
  if (row.error.type === 'network_error') {
    return `Usage check could not reach ${row.label}. Refresh to try again.`;
  }
  return row.error.message;
}

function WindowRow({ w, now }: { w: ProviderUsageWindow; now: Date }) {
  const pct = Math.round(w.remainingPercent);
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-sans text-[11px] text-text-subtle">{w.label}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`font-mono text-[11px] ${
              pct < 20
                ? 'text-health-error'
                : pct < 50
                  ? 'text-health-warn'
                  : 'text-text-muted'
            }`}
          >
            {pct}%
          </span>
          {w.resetsAt && (
            <span className="font-sans text-[10px] text-text-subtle">
              {formatReset(w.resetsAt, now)}
            </span>
          )}
        </div>
      </div>
      {/* Remaining bar */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-elevated">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${barColor(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ProviderBlock({
  isRefreshing = false,
  now,
  onRefresh,
  row,
}: {
  isRefreshing?: boolean;
  now: Date;
  onRefresh?: () => void;
  row: ProviderUsageRow;
}) {
  const isAvailable = row.status === 'available';
  const errorMessage = providerUsageErrorMessage(row);
  return (
    <div className={isAvailable ? '' : 'opacity-50'}>
      {/* Name + best-effort badge */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-sans text-[12px] font-medium text-text">{row.label}</span>
          {row.source === 'private-api' && (
            <span
              className="rounded border border-text-subtle/20 px-1 font-mono text-[9px] text-text-subtle"
              title="Data scraped from private API — best-effort"
            >
              ≈
            </span>
          )}
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
            aria-label={`Refresh ${row.label} usage`}
            title={`Refresh ${row.label}`}
          >
            <RefreshCw className={`h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {isAvailable ? (
        <div className="space-y-2.5">
          {row.windows.map((w, i) => (
            <WindowRow key={i} w={w} now={now} />
          ))}
          {row.extras.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              {row.extras.map((e, i) => (
                <div key={i} className="flex items-baseline gap-1">
                  <span className="font-sans text-[10px] text-text-subtle">{e.label}</span>
                  <span className="font-serif text-[12px] text-text-muted">
                    {extraValue(e)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-0.5">
          <span className="font-sans text-[12px] text-text-muted">
            {row.error?.type === 'not_configured'
              ? 'Not configured'
              : row.error?.type === 'unauthorized'
                ? 'Auth expired'
                : row.error?.type === 'network_error'
                  ? 'Unreachable'
                  : 'Unavailable'}
          </span>
          {errorMessage && (
              <p className="font-mono text-[10px] text-text-subtle leading-relaxed">
                {errorMessage}
              </p>
            )}
        </div>
      )}
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      <div className="h-3 w-20 rounded bg-surface-elevated" />
      <div className="h-1 w-full rounded-full bg-surface-elevated" />
      <div className="h-1 w-2/3 rounded-full bg-surface-elevated" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServerPanel
// ---------------------------------------------------------------------------

/**
 * Server panel — four blocks in one scrollable card, ordered by glance priority:
 *   1. Status         — health + folded-in uptime (Restart is the section action)
 *   2. Provider Usage — rate-limit windows + extras per provider (collapsed + lazy);
 *                       sits under Status so "healthy?" / "near limits?" read together
 *   3. Version        — track · version (embeds the commit SHA) + the update check
 *   4. Home           — the ANIMA_HOME path; a location fact, kept apart from Version
 *
 * Each block is a PanelSection for a consistent, extensible layout. Port, Commit,
 * and the Docs link were cut as redundant/navigation (see #server-panel IA pass).
 *
 * Mobile:   full-screen, z-50 (above MobileTopBar/BottomNav at z-40), bg-page,
 *           safe-area bottom inset, no backdrop.
 * Desktop:  left-anchored popover, max-w-[22rem], Esc/click-out to close.
 *           NB: if content grows substantially, this may need to graduate to a
 *           wider drawer — noted for post-launch.
 */
export default function ServerPanel({ onClose }: Props) {
  const [providerUsageOpen, setProviderUsageOpen] = useState(false);
  const [refreshingProvider, setRefreshingProvider] = useState<ProviderUsageKind | null>(null);
  const queryClient = useQueryClient();

  // --- Server info ---
  const { data: healthOk } = useQuery({
    queryKey: queryKeys.health(),
    queryFn: pingHealth,
    staleTime: 5_000,
  });
  const { data: info } = useQuery({
    queryKey: queryKeys.serverInfo(),
    queryFn: fetchServerInfo,
    staleTime: 60_000,
  });
  const health: 'loading' | 'ok' | 'error' =
    healthOk === undefined ? 'loading' : healthOk ? 'ok' : 'error';

  // --- Provider usage ---
  const {
    data: usageData,
    isLoading: usageLoading,
    isFetching: usageFetching,
    refetch: refetchUsage,
  } = useQuery({
    queryKey: queryKeys.providerUsage(),
    queryFn: fetchProviderUsage,
    enabled: providerUsageOpen,
    staleTime: 60_000,
  });

  // Ticks every minute — keeps uptime, reset countdowns, and "updated X ago" current.
  const now = useNow();

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Desktop: backdrop click closes. Mobile: full-screen sheet, no backdrop.
  // Trigger button toggles open/close in the parent; no special handling needed here.
  const panelRef = useRef<HTMLDivElement>(null);

  const healthColor =
    health === 'loading'
      ? 'var(--color-health-idle)'
      : health === 'ok'
        ? 'var(--color-health-ok)'
        : 'var(--color-health-error)';
  const healthLabel =
    health === 'loading' ? 'Checking…' : health === 'ok' ? 'Healthy' : 'Unreachable';

  // One "which build" line: track folded in front of the version, which already
  // embeds the commit SHA (so no separate Commit row). e.g. "canary · 0.1.1-canary.75.1.80810fb".
  const version = info?.version && info.version !== '0.0.0' ? info.version : null;
  const buildLine = version
    ? info?.track
      ? `${info.track} · ${version}`
      : version
    : (info?.track ?? null);

  // Wait for both health and server info before revealing the card.
  const isReady = healthOk !== undefined && !!info;

  const usageCheckedAt = usageData?.providers.reduce<string | undefined>((latest, row) => {
    if (!latest) return row.checkedAt;
    return row.checkedAt > latest ? row.checkedAt : latest;
  }, undefined);

  async function refreshOneProvider(provider: ProviderUsageKind): Promise<void> {
    if (refreshingProvider) return;
    setRefreshingProvider(provider);
    try {
      const row = await fetchProviderUsageProvider(provider);
      queryClient.setQueryData<ProviderUsageResponse>(queryKeys.providerUsage(), (current) => {
        const providers = current?.providers ?? [];
        const found = providers.some((candidate) => candidate.provider === row.provider);
        return {
          providers: found
            ? providers.map((candidate) => candidate.provider === row.provider ? row : candidate)
            : [...providers, row],
        };
      });
    } finally {
      setRefreshingProvider((current) => current === provider ? null : current);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Desktop backdrop — click to close */}
      <div
        className="hidden md:block fixed inset-0 bg-page/70 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Server"
        className={[
          'relative flex h-full w-full flex-col bg-surface',
          'md:absolute md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2',
          'md:h-auto md:max-h-[calc(100dvh-4rem)] md:max-w-xl md:rounded-sm md:border md:border-border-soft md:shadow-deep',
          'transition-[opacity,transform] duration-150 ease-out',
          isReady ? 'opacity-100 scale-100' : 'opacity-0 md:scale-95',
        ].join(' ')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* ── Panel header ── */}
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-soft px-3">
          <span className="caps text-text">Server</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            aria-label="Close server panel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* ── Scrollable body — add sections here as needed ── */}
        {/* divide-y puts a border between each PanelSection without doubling at the top */}
        <div className="flex-1 overflow-y-auto divide-y divide-border-soft">

          {/* Section 1: Status — health + folded-in uptime; Restart is the section action */}
          <PanelSection title="Status" action={<RestartButton compact />}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: healthColor }}
                />
                <span className="font-serif text-[14px] text-text">{healthLabel}</span>
              </span>
              {info?.startedAt && (
                <span
                  className="font-sans text-[11px] tracking-wide text-text-subtle"
                  title={shortIso(info.startedAt)}
                >
                  · up {formatUptime(info.startedAt, now)}
                </span>
              )}
            </div>
          </PanelSection>

          {/* Section 2: Provider Usage */}
          <PanelSection
            title="Provider Usage"
            open={providerUsageOpen}
            onOpenChange={setProviderUsageOpen}
            action={
              providerUsageOpen ? (
                <div className="flex items-center gap-2">
                  {usageCheckedAt && (
                    <span className="font-sans text-[10px] text-text-subtle">
                      {formatAgo(usageCheckedAt, now)}
                    </span>
                  )}
                  <button
                    onClick={() => refetchUsage()}
                    disabled={usageFetching}
                    className="flex h-5 w-5 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
                    aria-label="Refresh provider usage"
                    title="Refresh"
                  >
                    <RefreshCw className={`h-3 w-3 ${usageFetching ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              ) : undefined
            }
          >
            {usageLoading ? (
              <div className="space-y-5">
                <UsageSkeleton />
                <UsageSkeleton />
                <UsageSkeleton />
              </div>
            ) : (
              (() => {
                const visible = usageData?.providers.filter((r) => r.error?.type !== 'not_configured') ?? [];
                return visible.length > 0 ? (
                  <div className="space-y-5">
                    {visible.map((row) => (
                      <ProviderBlock
                        key={row.provider}
                        isRefreshing={refreshingProvider === row.provider}
                        now={now}
                        onRefresh={() => void refreshOneProvider(row.provider)}
                        row={row}
                      />
                    ))}
                    {visible.some((r) => r.source === 'private-api') && (
                      <p className="font-mono text-[9px] text-text-subtle opacity-50">
                        ≈ best-effort (private API)
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="font-serif italic text-[13px] text-text-subtle">
                    No providers configured.
                  </p>
                );
              })()
            )}
          </PanelSection>

          {/* Section 3: Version — which build you're on + the update check.
              Track is folded in front; the version already embeds the commit SHA. */}
          <PanelSection title="Version">
            <div className="space-y-4">
              {buildLine && (
                <div className="min-w-0 break-all font-mono text-[12px] text-text">
                  {buildLine}
                </div>
              )}
              <RuntimeUpgradeRow />
            </div>
          </PanelSection>

          {/* Section 4: Home — where your data lives. A location fact, kept apart
              from Version so the two concerns don't read as one. */}
          {info && (
            <PanelSection title="Home">
              <div
                className="min-w-0 break-all font-mono text-[12px] text-text"
                title={info.animaHome}
              >
                {info.animaHome}
              </div>
            </PanelSection>
          )}

        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

/**
 * PanelSection — consistent container for each section in the panel.
 * Dividers between sections come from the parent's `divide-y divide-border-soft`.
 * To add a third section: <PanelSection title="…">…</PanelSection>
 */
function PanelSection({
  title,
  action,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isCollapsible = open !== undefined && !!onOpenChange;
  return (
    <div className="px-4 py-4 md:px-6 md:py-5">
        {/* Section sub-header */}
        <div className={`${!isCollapsible || open ? 'mb-3' : ''} flex items-center justify-between gap-2`}>
          {isCollapsible ? (
            <button
              type="button"
              onClick={() => onOpenChange(!open)}
              aria-expanded={open}
              className="-ml-1 flex min-h-[24px] items-center gap-1 rounded-sm px-1 font-sans text-[10px] font-medium uppercase tracking-widest text-text-subtle hover:bg-surface-elevated hover:text-text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {open ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <span>{title}</span>
            </button>
          ) : (
            <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-text-subtle">
              {title}
            </span>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {(!isCollapsible || open) && children}
      </div>
  );
}
