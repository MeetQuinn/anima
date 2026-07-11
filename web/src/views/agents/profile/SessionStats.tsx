import { formatTokens, formatUptime, shortIso } from '@/lib/format';
import type { AgentSessionSummary, ProviderSessionStatsSummary } from '@shared/snapshot';

// Context occupancy gauge — % to compact (claude) or % full (codex).
export function ContextOccupancy({ stats }: { stats?: ProviderSessionStatsSummary }) {
  if (!stats || stats.currentContextTokens === undefined) {
    // Only show a hint when stats exist but context is pending (e.g. between
    // compactions). When there are no stats at all the agent hasn't run yet —
    // show a plain dash with no confusing provider message.
    const hint =
      stats?.autoCompactWindow && stats.autoCompactWindow > 0 ? 'awaiting next item' : null;
    return (
      <div className="min-w-0">
        <span className="font-serif italic text-[14px] text-text-subtle">—</span>
        {hint && (
          <div className="font-sans mt-1 text-[11px] tracking-wide text-text-subtle">{hint}</div>
        )}
      </div>
    );
  }
  const used = stats.currentContextTokens;
  const compactWindow = stats.autoCompactWindow;
  const modelWindow = stats.contextWindow;
  const gauge =
    compactWindow && compactWindow > 0
      ? {
          denom: compactWindow,
          label: 'to compact',
          detail: [
            `${formatTokens(used)} / ${formatTokens(compactWindow)}`,
            modelWindow ? `model window ${formatTokens(modelWindow)}` : null,
            'as of latest activity',
          ]
            .filter(Boolean)
            .join(' · '),
        }
      : modelWindow && modelWindow > 0
        ? {
            denom: modelWindow,
            label: 'full',
            detail: `${formatTokens(used)} / ${formatTokens(modelWindow)} model window · as of latest activity`,
          }
        : null;
  if (gauge) {
    const pct = Math.min(100, Math.round((used / gauge.denom) * 100));
    const fill = pct >= 90 ? 'bg-health-error' : pct >= 75 ? 'bg-health-warn' : 'bg-accent';
    return (
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="font-serif text-[18px] leading-none text-text">{pct}%</span>
          <span className="font-sans text-[11px] tracking-wide text-text-muted">{gauge.label}</span>
        </div>
        <div className="mt-2 h-1 w-44 max-w-full overflow-hidden rounded-full bg-border-soft">
          <span className={`block h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="font-sans mt-1.5 text-[11px] tracking-wide text-text-subtle">
          {gauge.detail}
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <div className="font-mono text-[13px] text-text">{formatTokens(used)} tokens</div>
      <div className="font-sans mt-1 text-[11px] tracking-wide text-text-subtle">
        as of latest activity
      </div>
    </div>
  );
}

// ── This Session block ───────────────────────────────────────────────────────

// Eyebrow label for one vital in the strip.
function VitalLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="chrome mb-1.5 text-[10px] uppercase tracking-[0.1em] text-text-subtle">
      {children}
    </div>
  );
}

// Session vitals as one horizontal strip (wraps on narrow screens): the
// context gauge is the star, compactions and uptime read alongside it.
// These are the most-glanced facts on the page, so they sit high - right
// under the Setup ledger, above the transport sections.
export function SessionSection({
  stats,
  session,
  now,
}: {
  stats?: ProviderSessionStatsSummary;
  session?: AgentSessionSummary;
  now: Date;
}) {
  const startedAt = session?.currentStartedAt ?? session?.createdAt;
  return (
    <div className="flex flex-wrap items-start gap-x-10 gap-y-4 py-1">
      <div className="min-w-0">
        <VitalLabel>Context</VitalLabel>
        <ContextOccupancy stats={stats} />
      </div>
      <div>
        <VitalLabel>Compactions</VitalLabel>
        {stats?.sessionCompactionCount !== undefined ? (
          <span className="font-mono text-[15px] leading-none text-text">
            {stats.sessionCompactionCount}
          </span>
        ) : (
          <span className="font-serif italic text-[14px] text-text-subtle">—</span>
        )}
      </div>
      <div>
        <VitalLabel>Started</VitalLabel>
        {startedAt ? (
          <div className="min-w-0">
            <span className="font-serif text-[15px] leading-none text-text">
              {shortIso(startedAt)}
            </span>
            <span className="font-sans ml-2 text-[11px] tracking-wide text-text-subtle">
              up {formatUptime(startedAt, now)}
            </span>
          </div>
        ) : (
          <span className="font-serif italic text-[14px] text-text-subtle">—</span>
        )}
      </div>
    </div>
  );
}
