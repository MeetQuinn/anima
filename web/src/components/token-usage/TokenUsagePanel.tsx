import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import type { AgentTokenUsageSummary } from '@shared/agent-token-usage';
import { currentTokenUsageRange, fetchAgentTokenUsage } from '@/api/token-usage';
import { agentColor, initialOf } from '@/lib/avatars';
import { queryKeys } from '@/lib/query-keys';
import {
  USAGE_RAMP,
  UsageHeatmap,
  formatTokens,
  formatUsageDate,
  mergeUsageDays,
  peakUsageDay,
} from './UsageHeatmap';

/**
 * How many agents the leaderboard draws. The list is cut and the heading says
 * so, which is the whole declaration a reader needs: each row's percentage is a
 * true share of the all-agent total whether or not the rows below it are drawn.
 * The remaining agents stay reachable from the sidebar, which lists every one.
 */
const VISIBLE_AGENTS = 10;

export default function TokenUsagePanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const range = currentTokenUsageRange();
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.tokenUsage(range.from, range.through, range.timezone),
    queryFn: () => fetchAgentTokenUsage(range),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const aggregateDays = mergeUsageDays(data?.agents.map((agent) => agent.days) ?? []);
  const aggregateCoverage = commonCoverageStart(data?.agents.map((agent) => agent.coverageStartedAt) ?? []);
  const busiest = peakUsageDay(aggregateDays);
  const ranked = rankAgents(data?.agents ?? []).slice(0, VISIBLE_AGENTS);
  const total = data?.totalTokens ?? 0;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-page/55 backdrop-blur-[2px]" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Token usage"
        className="flex h-full w-full max-w-[960px] flex-col border-l border-border-soft bg-surface shadow-deep"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border-soft px-5 py-4 md:px-8 md:py-5">
          <h2 className="display text-[24px] font-semibold text-text md:text-[26px]">Token usage</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close token usage"
            className="flex h-9 w-9 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8 md:py-8">
          {isLoading && <div className="h-64 animate-pulse rounded-sm bg-surface-elevated" />}
          {isError && <p className="font-serif text-[14px] text-text-muted">Token usage is unavailable right now.</p>}
          {data && (
            <div className="space-y-8">
              {/* Two numbers, no prose. The lifetime total, and the biggest
                  single day — the two facts people actually came for. The
                  per-kind cache breakdown that used to sit here answered a
                  question nobody was asking. */}
              <div className="flex flex-wrap items-end gap-x-14 gap-y-5">
                <div>
                  <div className="font-serif text-[40px] leading-none tabular-nums text-text">
                    {formatTokens(total)}
                  </div>
                  <div className="mt-1.5 font-sans text-[10px] uppercase tracking-[0.13em] text-text-subtle">
                    Lifetime
                  </div>
                </div>
                {busiest && (
                  <div>
                    <div className="font-serif text-[26px] leading-none tabular-nums text-text-muted">
                      {formatTokens(busiest.totalTokens)}
                    </div>
                    <div className="mt-1.5 font-sans text-[10px] uppercase tracking-[0.13em] text-text-subtle">
                      Busiest day · {formatUsageDate(busiest.date)}
                    </div>
                  </div>
                )}
              </div>

              {/* No legend row: the ramp reads on its own, and the one mark that
                  does not (the coverage rule) carries its own caption. */}
              <div className="pb-3">
                <UsageHeatmap
                  coverageStartedAt={aggregateCoverage}
                  days={aggregateDays}
                  from={range.from}
                  through={range.through}
                />
              </div>

              <section>
                <div className="mb-1 border-b border-border-soft pb-2 font-sans text-[10px] uppercase tracking-[0.13em] text-text-muted">
                  Top agents
                </div>
                <div className="divide-y divide-border-soft">
                  {ranked.map((agent, index) => {
                    const share = total > 0 ? (agent.totalTokens / total) * 100 : 0;
                    const peak = peakUsageDay(agent.days);
                    return (
                      <button
                        key={agent.agentId}
                        type="button"
                        onClick={() => {
                          onClose();
                          navigate(`/agents/${encodeURIComponent(agent.agentId)}/profile`);
                        }}
                        className="group grid w-full items-center gap-x-4 gap-y-2 py-3.5 text-left hover:bg-surface-elevated/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent md:grid-cols-[minmax(150px,0.5fr)_1fr_112px_16px] md:px-1"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="w-[12px] shrink-0 text-right font-mono text-[10px] tabular-nums text-text-subtle">
                            {index + 1}
                          </span>
                          {agent.avatarUrl ? (
                            <img
                              src={agent.avatarUrl}
                              alt=""
                              className="h-7 w-7 shrink-0 rounded-lg object-cover ring-1 ring-border-soft"
                            />
                          ) : (
                            <span
                              aria-hidden="true"
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-sans text-[10px] font-bold text-white"
                              style={{ background: agentColor(index) }}
                            >
                              {initialOf(agent.agentName)}
                            </span>
                          )}
                          <span className="truncate font-serif text-[15px] leading-tight text-text">
                            {agent.agentName}
                          </span>
                        </div>

                        {/* The bar is the only share encoding now, so it gets
                            the width the per-agent heatmap used to take.
                            Linear, against the all-agent total. */}
                        <div
                          className="h-[7px] w-full overflow-hidden rounded-full"
                          style={{ background: USAGE_RAMP[0] }}
                          aria-hidden
                        >
                          <div
                            className="h-full rounded-full"
                            style={{ background: USAGE_RAMP[4], width: `${Math.max(1, share)}%` }}
                          />
                        </div>

                        <div className="md:text-right">
                          <div className="font-mono text-[13px] tabular-nums text-text">
                            {formatTokens(agent.totalTokens)}
                          </div>
                          <div className="mt-0.5 font-mono text-[9px] tabular-nums text-text-subtle">
                            {formatShare(share)}%{peak ? ` · peak ${formatTokens(peak.totalTokens)}` : ''}
                          </div>
                        </div>
                        <ArrowRight className="hidden h-3.5 w-3.5 text-text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-text md:block" />
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/**
 * Registry order is not usage order, so the panel sorts. Ties break on name so
 * two idle agents do not swap places between refetches.
 */
export function rankAgents(agents: AgentTokenUsageSummary[]): AgentTokenUsageSummary[] {
  return [...agents].sort(
    (a, b) => b.totalTokens - a.totalTokens || a.agentName.localeCompare(b.agentName),
  );
}

/**
 * One rule for both ends of the range, so a rounded `0%` never appears next to
 * a `54%` and reads as "used nothing".
 */
export function formatShare(share: number): string {
  return share < 1 ? share.toFixed(1) : share.toFixed(0);
}

export function commonCoverageStart(values: Array<string | undefined>): string | undefined {
  if (values.length === 0 || values.some((value) => !value)) return undefined;
  // The aggregate is exact only once every included agent is covered.
  return (values as string[]).sort().at(-1);
}
