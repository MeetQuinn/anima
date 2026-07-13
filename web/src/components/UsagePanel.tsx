import { Fragment, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { ArrowUp, ChevronDown, Copy, RefreshCw, X } from 'lucide-react';
import {
  applyProviderCliUpdate,
  checkProviderClis,
  fetchProviderUsage,
  fetchProviderUsageProvider,
} from '@/api/system';
import { queryKeys } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import { useConfirm } from '@/hooks/useConfirm';
import { useProviderCliStatus } from '@/hooks/useProviderCliStatus';
import type { ProviderCliRow } from '@shared/provider-cli';
import type {
  ProviderUsageKind,
  ProviderUsageResponse,
  ProviderUsageRow,
  ProviderUsageWindow,
  ProviderUsageExtra,
} from '@shared/provider-usage';

interface Props {
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Formatting helpers
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

/** Meter fill color by remaining percent */
function barColor(pct: number): string {
  if (pct >= 50) return 'bg-health-ok';
  if (pct >= 20) return 'bg-health-warn';
  return 'bg-health-error';
}

function pctColor(pct: number): string {
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
function extraValue(e: ProviderUsageExtra): string {
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

function providerUsageErrorMessage(row: ProviderUsageRow): string | null {
  if (!row.error || row.error.type === 'unknown') return null;
  if (row.error.type === 'network_error') {
    return `Usage check could not reach ${row.label}. Refresh to try again.`;
  }
  return row.error.message;
}

/** The Plan extra becomes a chip next to the provider name; the rest stay rows. */
function splitExtras(extras: ProviderUsageExtra[]): {
  plan: string | null;
  rest: ProviderUsageExtra[];
} {
  const planExtra = extras.find((e) => e.label.toLowerCase() === 'plan' && e.balance !== undefined);
  return {
    plan: planExtra?.balance !== undefined ? planLabel(planExtra.balance) : null,
    rest: extras.filter((e) => e !== planExtra),
  };
}

function installSourceLabel(source: ProviderCliRow['installSource']): string {
  if (source === 'claude-native') return 'Native';
  if (source === 'codex-npm-global') return 'Global npm';
  if (source === 'kimi-native') return 'Native';
  if (source === 'grok-native') return 'Native';
  return 'Unknown source';
}

/** One quiet key/value line inside the Details disclosure. */
function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-20 shrink-0 font-sans text-[10px] text-text-subtle">{label}</span>
      <span
        className={`min-w-0 truncate text-[10px] text-text-muted ${mono ? 'font-mono' : 'font-sans'}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand marks — official simple-icons path data (24×24 viewBox), vendored so
// the glyphs cost no dependency. Kinds without a usable mark fall back to a
// letter tile.
// ---------------------------------------------------------------------------

const CLAUDE_PATH =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';

const OPENAI_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

const MOONSHOT_PATH =
  'm1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866';

const BRAND_MARKS: Partial<Record<ProviderUsageKind, { path: string; fill: string }>> = {
  // Claude keeps its brand terracotta; OpenAI and Moonshot take the text color.
  'claude-code': { path: CLAUDE_PATH, fill: '#D97757' },
  'codex-cli': { path: OPENAI_PATH, fill: 'currentColor' },
  'kimi-cli': { path: MOONSHOT_PATH, fill: 'currentColor' },
};

function BrandIcon({ provider, label }: { provider: ProviderUsageKind; label: string }) {
  const mark = BRAND_MARKS[provider];
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-elevated text-text ring-1 ring-border-soft"
    >
      {mark ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill={mark.fill}>
          <path d={mark.path} />
        </svg>
      ) : (
        <span className="font-mono text-[12px] font-semibold text-text-muted">{label.charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Provider unit
// ---------------------------------------------------------------------------

function WindowMeter({ w, now }: { w: ProviderUsageWindow; now: Date }) {
  const pct = Math.round(w.remainingPercent);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-sans text-[12px] text-text-muted">{w.label}</span>
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-[13px] tabular-nums ${pctColor(pct)}`}>{pct}%</span>
          {w.resetsAt && (
            <span className="font-sans text-[10px] text-text-subtle">resets in {formatReset(w.resetsAt, now)}</span>
          )}
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${barColor(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ProviderUnit({
  globallyLocked = false,
  management,
  isRefreshing = false,
  now,
  onApply,
  onCopyCommand,
  onRefresh,
  usage,
}: {
  globallyLocked?: boolean;
  management: ProviderCliRow;
  isRefreshing?: boolean;
  now: Date;
  onApply: () => void;
  onCopyCommand: () => void;
  onRefresh?: () => void;
  usage?: ProviderUsageRow;
}) {
  const isAvailable = usage?.status === 'available';
  const errorMessage = usage ? providerUsageErrorMessage(usage) : null;
  const { plan, rest } = splitExtras(usage?.extras ?? []);
  const operation = management.operation.provider === management.provider ? management.operation : undefined;
  const runningAgents = management.agents.filter((agent) => agent.runningVersion);
  const canApply = management.updateAvailable && management.updateMode === 'managed';
  const updateLocked = globallyLocked || management.operation.status === 'running';
  const installing = operation?.status === 'running';
  const manualUpdate = !installing && management.updateAvailable && management.updateMode === 'manual';
  const staleSessions =
    operation?.status === 'succeeded' &&
    runningAgents.some((agent) => agent.runningVersion !== management.installedVersion);
  const versionCheckFailed = management.state === 'error' || Boolean(management.checkError);
  const needsAttention = installing || operation?.status === 'failed' || manualUpdate || staleSessions;
  return (
    <div>
      {/* ── Identity row: who it is, what plan, which version. ── */}
      <div className="flex items-center gap-2.5">
        <BrandIcon provider={management.provider} label={management.label} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-serif text-[15px] font-semibold text-text">{management.label}</span>
            {plan && (
              <span className="shrink-0 rounded-full border border-border-soft px-1.5 py-px font-sans text-[9px] font-medium uppercase tracking-wider text-text-subtle">
                {plan}
              </span>
            )}
          </div>
          {usage?.account && (
            <div className="truncate font-mono text-[10px] text-text-subtle" title={usage.account}>
              {usage.account}
            </div>
          )}
        </div>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-subtle">
          {management.installedVersion ? `v${management.installedVersion}` : 'not installed'}
        </span>
        {canApply && (
          <button
            type="button"
            onClick={onApply}
            disabled={updateLocked}
            title={management.latestVersion ? `Update to v${management.latestVersion}` : 'Update'}
            className="flex h-7 items-center gap-1 rounded-sm bg-accent px-2 font-sans text-[10px] font-semibold text-white hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUp className="h-3 w-3" />
            Update
          </button>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
            aria-label={`Refresh ${management.label}`}
            title={`Refresh ${management.label}`}
          >
            <RefreshCw className={`h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {/* ── Attention strip: rendered only when the operator can act on it. ── */}
      {needsAttention && (
        <div className="mt-2.5 space-y-1.5 pl-[38px]">
          {installing && <p className="font-sans text-[11px] text-text-muted">Installing…</p>}
          {operation?.status === 'failed' && (
            <p className="font-sans text-[11px] leading-relaxed text-health-error">
              {operation.error ?? 'Update failed'}
            </p>
          )}
          {manualUpdate && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="shrink-0 font-sans text-[11px] text-health-warn">
                Update available{management.latestVersion ? ` ${management.latestVersion}` : ''}
              </span>
              {management.manualCommand && (
                <button
                  type="button"
                  onClick={onCopyCommand}
                  className="flex min-w-0 items-center gap-1.5 text-left font-mono text-[10px] text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  title="Copy update command"
                >
                  <Copy className="h-3 w-3 shrink-0" />
                  <span className="truncate">{management.manualCommand}</span>
                </button>
              )}
            </div>
          )}
          {staleSessions && (
            <p className="font-sans text-[11px] leading-relaxed text-text-muted">
              New sessions use v{management.installedVersion}. Existing sessions keep their current version until
              restart.
            </p>
          )}
        </div>
      )}

      {/* ── Usage meters: the reason this panel exists. ── */}
      {isAvailable && usage ? (
        <div className="mt-4 space-y-3 pl-[38px]">
          {usage.windows.map((w, i) => (
            <WindowMeter key={i} w={w} now={now} />
          ))}
          {rest.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              {rest.map((e, i) => (
                <div key={i} className="flex items-baseline gap-1.5">
                  <span className="font-sans text-[10px] text-text-subtle">{e.label}</span>
                  <span className="font-mono text-[11px] tabular-nums text-text-muted">{extraValue(e)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-0.5 pl-[38px] opacity-60">
          <span className="font-sans text-[12px] text-text-muted">
            {!usage || usage.error?.type === 'not_configured'
              ? 'Not configured'
              : usage.error?.type === 'unauthorized'
                ? 'Auth expired'
                : usage.error?.type === 'network_error'
                  ? 'Unreachable'
                  : 'Unavailable'}
          </span>
          {errorMessage && <p className="font-mono text-[10px] leading-relaxed text-text-subtle">{errorMessage}</p>}
        </div>
      )}

      {/* ── Details: install diagnostics, demoted out of the default view. ── */}
      <details className="group mt-3 pl-[38px]">
        <summary className="flex cursor-pointer list-none items-center gap-1 font-sans text-[10px] uppercase tracking-[0.08em] text-text-subtle hover:text-text-muted">
          <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
          Details
          {management.agents.length > 0 && (
            <span className="normal-case tracking-normal">
              · {management.agents.length} {management.agents.length === 1 ? 'agent' : 'agents'}
            </span>
          )}
        </summary>
        <div className="mt-2 space-y-1.5 border-l border-border-soft pl-3">
          {management.binaryPath && <DetailRow label="Binary" value={management.binaryPath} mono />}
          {management.binaryPath && <DetailRow label="Source" value={installSourceLabel(management.installSource)} />}
          {management.autoUpdatesEnabled !== undefined && (
            <DetailRow
              label="Auto-update"
              value={`${management.autoUpdatesEnabled ? 'on' : 'off'}${management.autoUpdateChannel ? ` · ${management.autoUpdateChannel}` : ''}`}
            />
          )}
          {management.sourceDetail && management.updateMode !== 'managed' && (
            <p className="font-sans text-[10px] leading-relaxed text-text-muted">{management.sourceDetail}</p>
          )}
          {versionCheckFailed && (
            <p className="font-sans text-[10px] leading-relaxed text-text-muted">
              Version check failed{management.checkError ? ` · ${management.checkError.message}` : ''}
            </p>
          )}
          {management.agents.length > 0 && (
            <div className="space-y-1 pt-0.5">
              {management.agents.map((agent) => (
                <div key={agent.id} className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="truncate font-sans text-[11px] text-text-muted">{agent.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-text-subtle">
                    {agent.runningVersion
                      ? `running v${agent.runningVersion}`
                      : agent.enabled
                        ? 'next session'
                        : 'disabled'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-md bg-surface-elevated" />
        <div className="h-3 w-24 rounded bg-surface-elevated" />
      </div>
      <div className="space-y-2 pl-[38px]">
        <div className="h-1.5 w-full rounded-full bg-surface-elevated" />
        <div className="h-1.5 w-2/3 rounded-full bg-surface-elevated" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UsagePanel
// ---------------------------------------------------------------------------

export default function UsagePanel({ onClose }: Props) {
  const [refreshingProvider, setRefreshingProvider] = useState<ProviderUsageKind | null>(null);
  const queryClient = useQueryClient();
  const { confirm, modal } = useConfirm();
  const { data: cliData, isLoading: cliLoading, isFetching: cliFetching } = useProviderCliStatus();

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

  // Ticks every minute — keeps reset countdowns and "updated X ago" current.
  const now = useNow();

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const usageCheckedAt = usageData?.providers.reduce<string | undefined>((latest, row) => {
    if (!latest) return row.checkedAt;
    return row.checkedAt > latest ? row.checkedAt : latest;
  }, undefined);

  async function refreshOneProvider(provider: ProviderUsageKind): Promise<void> {
    if (refreshingProvider) return;
    setRefreshingProvider(provider);
    try {
      const [row, status] = await Promise.all([fetchProviderUsageProvider(provider), checkProviderClis(provider)]);
      queryClient.setQueryData(queryKeys.providerCliStatus(), status);
      queryClient.setQueryData<ProviderUsageResponse>(queryKeys.providerUsage(), (current) => {
        const providers = current?.providers ?? [];
        const found = providers.some((candidate) => candidate.provider === row.provider);
        return {
          providers: found
            ? providers.map((candidate) => (candidate.provider === row.provider ? row : candidate))
            : [...providers, row],
        };
      });
    } finally {
      setRefreshingProvider((current) => (current === provider ? null : current));
    }
  }

  async function refreshAll(): Promise<void> {
    const [, status] = await Promise.all([refetchUsage(), checkProviderClis()]);
    queryClient.setQueryData(queryKeys.providerCliStatus(), status);
  }

  function requestApply(row: ProviderCliRow): void {
    const enabledAgents = row.agents.filter((agent) => agent.enabled);
    confirm({
      title: `Update ${row.label}?`,
      description: (
        <div className="space-y-2">
          <p>
            Update the machine-wide {row.label} binary from v{row.installedVersion} to v{row.latestVersion}. This
            affects {enabledAgents.length} {enabledAgents.length === 1 ? 'agent' : 'agents'}:{' '}
            {enabledAgents.map((agent) => agent.name).join(', ') || 'none'}.
          </p>
          <p>
            Running work is not interrupted. New versions take effect when each provider session next restarts. Login
            credentials and provider configuration are not changed.
          </p>
        </div>
      ),
      variant: 'warn',
      confirmVariant: 'default',
      confirmLabel: 'Update provider',
      busyLabel: 'Installing…',
      onConfirm: async () => {
        await applyProviderCliUpdate(row.provider);
        await queryClient.invalidateQueries({ queryKey: queryKeys.providerCliStatus() });
      },
    });
  }

  const usageByProvider = new Map(usageData?.providers.map((row) => [row.provider, row]) ?? []);
  const visible = cliData?.providers ?? [];
  const checkedAt = [usageCheckedAt, ...visible.map((row) => row.checkedAt)]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const fetching = usageFetching || cliFetching;

  return (
    <Fragment>
      {createPortal(
        <div className="fixed inset-0 z-50">
          {/* Desktop backdrop — click to close */}
          <div className="hidden md:block fixed inset-0 bg-page/70 backdrop-blur-sm" onClick={onClose} />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="Providers"
            className={[
              'relative flex h-full w-full flex-col bg-surface',
              'md:absolute md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2',
              'md:h-auto md:max-h-[calc(100dvh-4rem)] md:max-w-xl md:rounded-sm md:border md:border-border-soft md:shadow-deep',
            ].join(' ')}
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            {/* ── Panel header ── */}
            {/* Mobile full-screen pages share the home header height (h-14 / 56px);
            the desktop modal keeps its compact h-10 chrome. */}
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-soft px-3 md:h-10">
              <span className="caps text-text">Providers</span>
              <div className="flex items-center gap-2">
                {checkedAt && (
                  <span className="font-sans text-[10px] text-text-subtle">checked {formatAgo(checkedAt, now)}</span>
                )}
                <button
                  onClick={() => void refreshAll()}
                  disabled={fetching}
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
                  aria-label="Refresh providers"
                  title="Refresh"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={onClose}
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  aria-label="Close providers panel"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* ── Body ── */}
            <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
              {usageLoading || cliLoading ? (
                <div className="space-y-6">
                  <UsageSkeleton />
                  <UsageSkeleton />
                </div>
              ) : visible.length > 0 ? (
                <div className="divide-y divide-border-soft">
                  {visible.map((row, i) => (
                    <div key={row.provider} className={i === 0 ? 'pb-6' : 'py-6 last:pb-1'}>
                      <ProviderUnit
                        globallyLocked={cliData?.upgradeLocked}
                        management={row}
                        isRefreshing={refreshingProvider === row.provider}
                        now={now}
                        onApply={() => requestApply(row)}
                        onCopyCommand={() => {
                          if (row.manualCommand) void navigator.clipboard.writeText(row.manualCommand);
                        }}
                        onRefresh={() => void refreshOneProvider(row.provider)}
                        usage={usageByProvider.get(row.provider)}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="font-serif italic text-[13px] text-text-subtle">No provider CLIs found.</p>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {modal}
    </Fragment>
  );
}
