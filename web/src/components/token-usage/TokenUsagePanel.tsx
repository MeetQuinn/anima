import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { currentTokenUsageRange, fetchAgentTokenUsage } from '@/api/token-usage';
import { agentColor, initialOf } from '@/lib/avatars';
import { queryKeys } from '@/lib/query-keys';
import {
  UsageHeatmap,
  formatTokens,
  mergeUsageDays,
  usageScaleMax,
} from './UsageHeatmap';
import { UsageTotals } from './UsageTotals';

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
  const sharedScale = usageScaleMax(data?.agents.flatMap((agent) => agent.days) ?? []);
  const aggregateCoverage = commonCoverageStart(data?.agents.map((agent) => agent.coverageStartedAt) ?? []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-page/55 backdrop-blur-[2px]" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Token usage"
        className="flex h-full w-full max-w-[960px] flex-col border-l border-border-soft bg-surface shadow-deep"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between border-b border-border-soft px-5 py-4 md:px-8 md:py-6">
          <div>
            <h2 className="display text-[24px] font-semibold text-text md:text-[28px]">Token usage</h2>
            <p className="mt-1 font-sans text-[11px] uppercase tracking-[0.12em] text-text-subtle">
              Provider reported · grouped in {range.timezone}
            </p>
          </div>
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
            <div className="space-y-9">
              <section className="space-y-5">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <div className="font-serif text-[38px] tabular-nums leading-none text-text">
                      {formatTokens(data.totalTokens)}
                    </div>
                    <div className="mt-1 font-sans text-[11px] uppercase tracking-[0.11em] text-text-subtle">
                      Tokens processed · all agents
                    </div>
                  </div>
                  <div className="max-w-sm text-right font-sans text-[11px] leading-relaxed text-text-subtle">
                    Measured usage is shown. All-agent totals become exact once every agent starts tracking;
                    earlier days stay unfilled, never estimated.
                  </div>
                </div>
                <UsageHeatmap
                  coverageStartedAt={aggregateCoverage}
                  days={aggregateDays}
                  from={range.from}
                  scaleMax={usageScaleMax(aggregateDays)}
                  through={range.through}
                />
                <UsageTotals totals={data} />
              </section>

              <section>
                <div className="mb-3 flex items-baseline justify-between border-b border-border-soft pb-2">
                  <h3 className="chrome text-[11px] uppercase tracking-[0.12em] text-text-muted">By agent</h3>
                  <span className="font-mono text-[10px] text-text-subtle">shared intensity scale</span>
                </div>
                <div className="divide-y divide-border-soft">
                  {data.agents.map((agent, index) => (
                    <button
                      key={agent.agentId}
                      type="button"
                      onClick={() => {
                        onClose();
                        navigate(`/agents/${encodeURIComponent(agent.agentId)}/profile`);
                      }}
                      className="group grid w-full gap-3 py-4 text-left hover:bg-surface-elevated/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent md:grid-cols-[minmax(150px,0.65fr)_minmax(390px,1.35fr)_90px_20px] md:items-center md:px-2"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        {agent.avatarUrl ? (
                          <img
                            src={agent.avatarUrl}
                            alt=""
                            className="h-8 w-8 shrink-0 rounded-lg object-cover ring-1 ring-border-soft"
                          />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-sans text-[11px] font-bold text-white ring-1 ring-border-soft"
                            style={{ background: agentColor(index) }}
                          >
                            {initialOf(agent.agentName)}
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-serif text-[15px] text-text">{agent.agentName}</div>
                        </div>
                      </div>
                      <UsageHeatmap
                        compact
                        coverageStartedAt={agent.coverageStartedAt}
                        days={agent.days}
                        from={range.from}
                        scaleMax={sharedScale}
                        through={range.through}
                      />
                      <div className="font-mono text-[12px] tabular-nums text-text-muted md:text-right">
                        {formatTokens(agent.totalTokens)}
                      </div>
                      <ArrowRight className="hidden h-3.5 w-3.5 text-text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-text md:block" />
                    </button>
                  ))}
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

export function commonCoverageStart(values: Array<string | undefined>): string | undefined {
  if (values.length === 0 || values.some((value) => !value)) return undefined;
  // The aggregate is exact only once every included agent is covered.
  return (values as string[]).sort().at(-1);
}
