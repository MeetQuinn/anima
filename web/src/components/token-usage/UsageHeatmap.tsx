import { useEffect, useRef } from 'react';

import type { AgentTokenUsageDay } from '@shared/agent-token-usage';
import { localDate } from '@/api/token-usage';

interface UsageHeatmapProps {
  compact?: boolean;
  coverageStartedAt?: string;
  days: AgentTokenUsageDay[];
  from: string;
  scaleMax?: number;
  through: string;
}

const LEVEL_CLASS = [
  'bg-surface-elevated',
  'bg-accent/20',
  'bg-accent/40',
  'bg-accent/65',
  'bg-accent',
] as const;

export function UsageHeatmap({
  compact = false,
  coverageStartedAt,
  days,
  from,
  scaleMax,
  through,
}: UsageHeatmapProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const coverageDate = coverageStartedAt ? localDate(new Date(coverageStartedAt)) : undefined;
  const weeks = usageWeeks(from, 52);
  const max = scaleMax ?? usageScaleMax(days);
  const gap = compact ? 'gap-px' : 'gap-[3px]';
  const cellSize = compact ? 'h-1.5 w-1.5 rounded-[1px]' : 'h-2.5 w-2.5 rounded-[2px]';

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth - element.clientWidth;
  }, [compact, from, through]);

  return (
    <div
      ref={scrollRef}
      className="overflow-x-auto pb-1"
      role="img"
      aria-label="Daily provider-reported token usage"
    >
      <div className={compact ? 'min-w-[363px]' : 'min-w-[704px]'}>
        {!compact && (
          <div className="mb-1.5 ml-7 flex gap-[3px]" aria-hidden>
            {weeks.map((week, index) => (
              <span key={week[0]} className="relative h-3 w-2.5 shrink-0">
                {monthLabel(week, weeks[index - 1]) && (
                  <span className="absolute left-0 top-0 whitespace-nowrap font-sans text-[9px] text-text-subtle">
                    {monthLabel(week, weeks[index - 1])}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-start">
          {!compact && (
            <div className="mr-2 grid grid-rows-7 gap-[3px] pt-0 font-mono text-[8px] leading-[10px] text-text-subtle" aria-hidden>
              <span />
              <span>M</span>
              <span />
              <span>W</span>
              <span />
              <span>F</span>
              <span />
            </div>
          )}
          <div className={`flex ${gap}`}>
            {weeks.map((week) => (
              <div key={week[0]} className={`grid grid-rows-7 ${gap}`}>
                {week.map((date) => {
                  const day = dayByDate.get(date);
                  const future = date > through;
                  const unknown = !future && (!coverageDate || date < coverageDate);
                  const missingUsage = !future && !unknown && (day?.unknownRuns ?? 0) > 0;
                  const level = day ? usageLevel(day.totalTokens, max) : 0;
                  const title = usageDayTitle(date, day, { future, unknown });
                  return (
                    <span
                      key={date}
                      title={title}
                      aria-label={title}
                      className={[
                        cellSize,
                        'block shrink-0 border transition-colors',
                        future
                          ? 'border-transparent bg-transparent'
                          : unknown
                            ? 'border-border-soft/70'
                            : missingUsage
                              ? `${level === 0 ? 'bg-health-warn-soft/60' : LEVEL_CLASS[level]} border-health-warn/60`
                              : `border-transparent ${LEVEL_CLASS[level]}`,
                      ].join(' ')}
                      style={unknown ? {
                        backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 2px, color-mix(in srgb, currentColor 10%, transparent) 2px 3px)',
                      } : undefined}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function usageScaleMax(days: AgentTokenUsageDay[]): number {
  const values = days.map((day) => day.totalTokens).filter((value) => value > 0).sort((a, b) => a - b);
  if (values.length === 0) return 1;
  return values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 1;
}

export function mergeUsageDays(groups: AgentTokenUsageDay[][]): AgentTokenUsageDay[] {
  const merged = new Map<string, AgentTokenUsageDay>();
  for (const days of groups) {
    for (const day of days) {
      const current = merged.get(day.date) ?? {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        date: day.date,
        inputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        reportedRuns: 0,
        totalTokens: 0,
        unknownRuns: 0,
      };
      current.cacheCreationInputTokens += day.cacheCreationInputTokens;
      current.cacheReadInputTokens += day.cacheReadInputTokens;
      current.inputTokens += day.inputTokens;
      current.outputTokens += day.outputTokens;
      current.reasoningOutputTokens += day.reasoningOutputTokens;
      current.reportedRuns += day.reportedRuns;
      current.totalTokens += day.totalTokens;
      current.unknownRuns += day.unknownRuns;
      merged.set(day.date, current);
    }
  }
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}K`;
  return value.toLocaleString();
}

function usageLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  const normalized = Math.log1p(Math.min(value, max)) / Math.log1p(Math.max(max, 1));
  return Math.max(1, Math.min(4, Math.ceil(normalized * 4))) as 1 | 2 | 3 | 4;
}

function usageWeeks(from: string, count: number): string[][] {
  const start = parseLocalDate(from);
  return Array.from({ length: count }, (_, weekIndex) =>
    Array.from({ length: 7 }, (_day, dayIndex) => {
      const date = new Date(start);
      date.setDate(start.getDate() + (weekIndex * 7) + dayIndex);
      return localDate(date);
    }),
  );
}

function monthLabel(week: string[], previous: string[] | undefined): string | undefined {
  const first = parseLocalDate(week[0]!);
  const previousFirst = previous ? parseLocalDate(previous[0]!) : undefined;
  if (previousFirst && first.getMonth() === previousFirst.getMonth()) return undefined;
  return first.toLocaleString(undefined, { month: 'short' });
}

function usageDayTitle(
  date: string,
  day: AgentTokenUsageDay | undefined,
  state: { future: boolean; unknown: boolean },
): string {
  const label = parseLocalDate(date).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  if (state.future) return `${label}: future`;
  if (state.unknown) return `${label}: before exact tracking began`;
  if (!day || (day.totalTokens === 0 && day.unknownRuns === 0)) return `${label}: 0 tokens`;
  const parts = [
    `${formatTokens(day.totalTokens)} tokens`,
    `${day.reportedRuns} reported run${day.reportedRuns === 1 ? '' : 's'}`,
  ];
  if (day.unknownRuns > 0) parts.push(`${day.unknownRuns} run${day.unknownRuns === 1 ? '' : 's'} without usage`);
  return `${label}: ${parts.join(' · ')}`;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!, 12);
}

function trimFixed(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}
