import type { TokenUsageTotals } from '@shared/agent-token-usage';
import { formatTokens } from '@/lib/format';

export function UsageTotals({ totals, compact = false }: { totals: TokenUsageTotals; compact?: boolean }) {
  const rows = [
    ['Uncached input', totals.inputTokens],
    ['Cache read', totals.cacheReadInputTokens],
    ['Cache write', totals.cacheCreationInputTokens],
    ['Output', totals.outputTokens],
  ] as const;
  return (
    <div className={`grid ${compact ? 'grid-cols-2 gap-3 sm:grid-cols-4' : 'grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4'}`}>
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-subtle">{label}</div>
          <div className="mt-1 font-serif text-[17px] tabular-nums text-text">{formatTokens(value)}</div>
        </div>
      ))}
    </div>
  );
}
