import type { ProviderUsageWindow } from '@shared/provider-usage';
import { barColor, formatReset, pctColor } from './format';

/**
 * One aligned meter row: label · bar · % · resets-in. Every window gets the
 * same treatment — the reset time is part of the row, never dropped.
 */
export function WindowRow({ w, now }: { w: ProviderUsageWindow; now: Date }) {
  const pct = Math.round(w.remainingPercent);
  return (
    // Mobile: label · % · reset on one line, full-width bar below.
    // sm+: one aligned row — label | bar | % | reset.
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 sm:grid-cols-[5.75rem_minmax(0,1fr)_2.5rem_5.5rem] sm:gap-x-3">
      <span className="min-w-0 truncate font-sans text-[12px] font-medium text-text-muted" title={w.label}>
        {w.label}
      </span>
      <span className={`text-right font-mono text-[12px] tabular-nums sm:col-start-3 ${pctColor(pct)}`}>{pct}%</span>
      <span className="text-right font-sans text-[10px] tabular-nums text-text-subtle sm:col-start-4">
        {w.resetsAt ? `resets ${formatReset(w.resetsAt, now)}` : ''}
      </span>
      <span
        role="meter"
        aria-label={`${w.label} remaining`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="col-span-full h-1.5 min-w-0 overflow-hidden rounded-full bg-surface-elevated sm:col-span-1 sm:col-start-2 sm:row-start-1"
      >
        <span
          className={`block h-full rounded-full transition-[width] duration-300 ${barColor(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}
