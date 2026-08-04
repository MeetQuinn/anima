import { useQuery } from '@tanstack/react-query';

import { currentTokenUsageRange, fetchAgentTokenUsage } from '@/api/token-usage';
import { queryKeys } from '@/lib/query-keys';
import { UsageHeatmap, formatTokens } from './UsageHeatmap';
import { UsageTotals } from './UsageTotals';

export function AgentUsageSection({ agentId }: { agentId: string }) {
  const range = currentTokenUsageRange();
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.agentTokenUsage(agentId, range.from, range.through, range.timezone),
    queryFn: () => fetchAgentTokenUsage(range, agentId),
    refetchInterval: 30_000,
  });
  const usage = data?.agents[0];

  if (isLoading) return <div className="h-36 animate-pulse rounded-sm bg-surface-elevated" />;
  if (isError || !usage) {
    return <p className="font-serif text-[13px] text-text-muted">Token usage is unavailable right now.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-serif text-[28px] tabular-nums leading-none text-text">
            {formatTokens(usage.totalTokens)}
          </div>
          <div className="mt-1 font-sans text-[11px] uppercase tracking-[0.11em] text-text-subtle">
            Tokens processed · 52 weeks
          </div>
        </div>
        <TrackingNote coverageStartedAt={usage.coverageStartedAt} unknownRuns={usage.unknownRuns} />
      </div>
      <UsageHeatmap
        coverageStartedAt={usage.coverageStartedAt}
        days={usage.days}
        from={range.from}
        through={range.through}
      />
      <UsageTotals totals={usage} />
      <p className="font-sans text-[11px] leading-relaxed text-text-subtle">
        Provider-reported tokens only. Reasoning tokens are included in output and are never counted twice.
      </p>
    </div>
  );
}

function TrackingNote({ coverageStartedAt, unknownRuns }: { coverageStartedAt?: string; unknownRuns: number }) {
  if (!coverageStartedAt) {
    return (
      <span className="max-w-xs font-sans text-[11px] leading-relaxed text-text-subtle">
        Exact tracking starts when this agent runtime next starts.
      </span>
    );
  }
  return (
    <span className="max-w-xs text-right font-sans text-[11px] leading-relaxed text-text-subtle">
      Exact since {new Date(coverageStartedAt).toLocaleDateString()}
      {unknownRuns > 0 ? ` · ${unknownRuns} run${unknownRuns === 1 ? '' : 's'} had no provider usage` : ''}
    </span>
  );
}
