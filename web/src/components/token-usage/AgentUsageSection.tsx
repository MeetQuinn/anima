import { useQuery } from '@tanstack/react-query';

import { currentTokenUsageRange, fetchAgentTokenUsage, localDate } from '@/api/token-usage';
import { formatTokens } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { UsageHeatmap, formatUsageDate, hasCoverageRule } from './UsageHeatmap';
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
            Tokens · Past 52 weeks
          </div>
        </div>
        <TrackingNote coverageStartedAt={usage.coverageStartedAt} from={range.from} />
      </div>
      <UsageHeatmap
        coverageStartedAt={usage.coverageStartedAt}
        days={usage.days}
        from={range.from}
        through={range.through}
      />
      <UsageTotals totals={usage} />
      <p className="font-sans text-[11px] leading-relaxed text-text-muted">
        Provider-reported totals only. Output includes reasoning tokens.
      </p>
    </div>
  );
}

function TrackingNote({ coverageStartedAt, from }: { coverageStartedAt?: string; from: string }) {
  if (!coverageStartedAt) {
    return (
      <span className="max-w-xs font-sans text-[11px] leading-relaxed text-text-muted">
        Exact tracking begins the next time this agent starts.
      </span>
    );
  }
  if (hasCoverageRule(coverageStartedAt, from)) return null;
  return (
    <span className="max-w-xs text-right font-sans text-[11px] leading-relaxed text-text-muted">
      Exact since {formatUsageDate(localDate(new Date(coverageStartedAt)), { includeYear: true })}
    </span>
  );
}
