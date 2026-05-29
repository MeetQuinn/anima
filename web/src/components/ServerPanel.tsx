import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { RefreshCw, X } from 'lucide-react';
import { fetchServerInfo, fetchProviderUsage, pingHealth } from '@/api/system';
import { shortIso, formatUptime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import RestartButton from './RestartButton';
import RuntimeUpgradeRow from './RuntimeUpgrade';
import type { ProviderUsageRow, ProviderUsageWindow, ProviderUsageExtra } from '@shared/provider-usage';

interface Props {
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Provider usage helpers
// ---------------------------------------------------------------------------

/** "1h 26m", "5d", "3m" from an ISO reset timestamp */
function formatReset(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
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
  if (e.balance !== undefined) return e.currency ? `${e.balance} ${e.currency}` : String(e.balance);
  if (e.limit !== undefined && e.used !== undefined) return String(e.limit - e.used);
  if (e.limit !== undefined) return String(e.limit);
  return '—';
}

function WindowRow({ w }: { w: ProviderUsageWindow }) {
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
              {formatReset(w.resetsAt)}
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

function ProviderBlock({ row }: { row: ProviderUsageRow }) {
  const isAvailable = row.status === 'available';
  return (
    <div className={isAvailable ? '' : 'opacity-50'}>
      {/* Name + best-effort badge */}
      <div className="mb-2 flex items-center gap-1.5">
        <span className="font-sans text-[12px] font-medium text-text">{row.label}</span>
        {row.source === 'private-api' && (
          <span
            className="rounded border border-text-subtle/20 px-1 font-mono text-[9px] text-text-subtle"
            title="Data scraped from private API — best-effort"
          >
            ≈
          </span>
        )}
      </div>

      {isAvailable ? (
        <div className="space-y-2.5">
          {row.windows.map((w, i) => (
            <WindowRow key={i} w={w} />
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
          {row.error?.message &&
            row.error.type !== 'network_error' &&
            row.error.type !== 'unknown' && (
              <p className="font-mono text-[10px] text-text-subtle leading-relaxed">
                {row.error.message}
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
 * Server panel — two sections in one scrollable card:
 *   1. System    — health / home / port / uptime / commit
 *   2. Provider Usage — rate-limit windows + extras per provider (Claude, Codex, Kimi)
 *
 * Both sections use the PanelSection container for a consistent, extensible
 * layout. Adding a third section = drop another PanelSection in the body.
 *
 * Mobile:   full-screen, z-50 (above MobileTopBar/BottomNav at z-40), bg-page,
 *           safe-area bottom inset, no backdrop.
 * Desktop:  left-anchored popover, max-w-[22rem], Esc/click-out to close.
 *           NB: if content grows substantially, this may need to graduate to a
 *           wider drawer — noted for post-launch.
 */
export default function ServerPanel({ onClose }: Props) {
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
    staleTime: 60_000,
  });

  // Ticks every minute — keeps uptime, reset countdowns, and "updated X ago" current.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

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

  // Wait for both health and server info before revealing the card.
  const isReady = healthOk !== undefined && !!info;

  const usageCheckedAt = usageData?.providers[0]?.checkedAt;

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

          {/* Section 1: System infra */}
          <PanelSection title="System" action={<RestartButton compact />}>
            <div className="space-y-4">
              <LabelRow label="Health">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: healthColor }}
                  />
                  <span className="font-serif text-[14px] text-text">{healthLabel}</span>
                </span>
              </LabelRow>

              {info && (
                <LabelRow label="Home">
                  <span
                    className="min-w-0 break-all font-mono text-[12px] text-text"
                    title={info.animaHome}
                  >
                    {info.animaHome}
                  </span>
                </LabelRow>
              )}

              {info && (
                <LabelRow label="Port">
                  <span className="font-serif text-[14px] text-text">
                    {info.dashboardPort}
                  </span>
                </LabelRow>
              )}

              {info?.startedAt && (
                <LabelRow label="Started">
                  <span className="font-serif text-[14px] text-text">
                    {shortIso(info.startedAt)}
                  </span>
                  <span className="font-sans text-[11px] tracking-wide text-text-subtle">
                    up {formatUptime(info.startedAt, now)}
                  </span>
                </LabelRow>
              )}

              {info?.commit && (
                <LabelRow label="Commit">
                  <span className="font-mono text-[12px] text-text">{info.commit}</span>
                </LabelRow>
              )}

              {info?.version && info.version !== '0.0.0' && (
                <LabelRow label="Version">
                  <span className="font-serif text-[14px] text-text">{info.version}</span>
                </LabelRow>
              )}

              <RuntimeUpgradeRow />
            </div>
          </PanelSection>

          {/* Section 2: Provider Usage */}
          <PanelSection
            title="Provider Usage"
            action={
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
                      <ProviderBlock key={row.provider} row={row} />
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
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-4 md:px-6 md:py-5">
        {/* Section sub-header */}
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="font-sans text-[10px] font-medium uppercase tracking-widest text-text-subtle">
            {title}
          </span>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {children}
      </div>
  );
}

/**
 * LabelRow — fixed-width label column + value(s) + optional inline action.
 * Serif for readable values; mono only for code tokens.
 */
function LabelRow({
  label,
  children,
  action,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 font-sans text-[11px] text-text-subtle">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
