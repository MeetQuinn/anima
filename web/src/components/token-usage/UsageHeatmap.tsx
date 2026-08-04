import { useEffect, useRef } from 'react';

import type { AgentTokenUsageDay } from '@shared/agent-token-usage';
import { localDate } from '@/api/token-usage';

interface UsageHeatmapProps {
  coverageStartedAt?: string;
  days: AgentTokenUsageDay[];
  from: string;
  through: string;
}

/**
 * A year of daily token usage, one cell per day.
 *
 * Three things about this chart are deliberate and were previously the other
 * way round:
 *
 * 1. SCALE IS QUANTILE, NOT LOG-AGAINST-A-MAX. The old bucketing was
 *    `log1p(value) / log1p(scaleMax)` against a 95th-percentile max. Measured
 *    over real fixtures, that put every agent's peak day on level 4 and moved a
 *    34x difference in median day by a single level, so nearly every active cell
 *    landed on the same two colours. A chart whose cells are all one colour is a
 *    filled rectangle. Quantile cuts give each level roughly a quarter of the
 *    active days by construction, so the ramp is always fully used.
 *
 *    The honest tradeoff: colour is now relative to THIS series' own
 *    distribution, so a flat month still shows variation and two charts are no
 *    longer comparable by eye. That is affordable because nothing renders two of
 *    these side by side any more, and the absolute number is in every cell's
 *    label.
 *
 * 2. THE UNCOVERED REGION IS DRAWN ONCE. It used to be ~180 bordered, hatched
 *    squares: the loudest thing on the chart and the least informative. It is
 *    now a flat near-page tint, one dashed rule at the boundary, and one caption
 *    beneath the chart repeating that dash. Same fact, drawn once instead of
 *    180 times.
 *
 * 3. EVERY CELL IS EXPOSED TO ASSISTIVE TECH. The container used to be
 *    `role="img"`, which makes all 364 descendants presentational: the per-day
 *    labels existed in the DOM and reached nobody, leaving one summary sentence
 *    for a year of data. The tests did not catch it because
 *    `getByLabelText` reads the attribute rather than computing the
 *    accessibility tree, so they passed either way. Cells now carry
 *    `role="img"` themselves and the container is a named group.
 */

export const USAGE_RAMP = ['#EAE5D8', '#F1D2B6', '#E0A377', '#C86E3C', '#AF3C1C'] as const;
// Barely above the panel surface. Days before tracking started are the least
// informative thing here, so they get the least ink while the 52-week frame
// stays legible.
const NO_DATA_FILL = '#F6F2E9';
const COVERAGE_RULE = '#B0A488';

const CELL = 11;
const GAP = 3;
const PITCH = CELL + GAP;
const RAIL = 22;

export function UsageHeatmap({ coverageStartedAt, days, from, through }: UsageHeatmapProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const coverageDate = coverageStartedAt ? localDate(new Date(coverageStartedAt)) : undefined;
  const weeks = usageWeeks(from, 52);
  const cuts = usageQuantileCuts(days);
  const boundaryWeek = coverageDate
    ? weeks.findIndex((week) => week.some((date) => date >= coverageDate))
    : -1;

  // The chart is wider than a phone. Without this the viewport lands on the
  // OLDEST weeks, which under the quiet no-data fill is a blank grid: the one
  // part of the chart with nothing in it. Pin to the newest end.
  //
  // The observer covers the case the mount effect alone cannot: at a width
  // where the chart fits, scrollLeft is legitimately 0, and shrinking to a
  // phone width then leaves it at 0 — the blank end — with no remount to
  // correct it. It re-pins ONLY from 0, so a reader who scrolled to March and
  // then rotated is never yanked back.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const pin = () => {
      element.scrollLeft = element.scrollWidth - element.clientWidth;
    };
    pin();
    const observer = new ResizeObserver(() => {
      if (element.scrollLeft === 0) pin();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [from, through]);

  return (
    <div>
      <div ref={scrollRef} className="overflow-x-auto pb-1">
        <div className="mb-1.5 flex" aria-hidden>
          <span className="shrink-0" style={{ width: RAIL }} />
          <div className="flex" style={{ gap: GAP }}>
            {weeks.map((week, index) => (
              <span key={week[0]} className="relative h-3 shrink-0" style={{ width: CELL }}>
                {monthLabel(week, weeks[index - 1]) && (
                  <span className="absolute left-0 top-0 whitespace-nowrap font-sans text-[9px] uppercase tracking-[0.08em] text-text-subtle">
                    {monthLabel(week, weeks[index - 1])}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-start">
          <div
            className="shrink-0 font-sans text-[8px] leading-none text-text-subtle"
            style={{ width: RAIL, display: 'grid', gridTemplateRows: `repeat(7, ${CELL}px)`, rowGap: GAP }}
            aria-hidden
          >
            {['', 'M', '', 'W', '', 'F', ''].map((label, index) => (
              <span key={index} className="flex items-center">
                {label}
              </span>
            ))}
          </div>

          <div
            className="relative flex"
            style={{ gap: GAP }}
            role="group"
            aria-label="Daily provider-reported token usage"
          >
            {weeks.map((week) => (
              <div
                key={week[0]}
                style={{ display: 'grid', gridTemplateRows: `repeat(7, ${CELL}px)`, rowGap: GAP }}
              >
                {week.map((date) => {
                  const day = dayByDate.get(date);
                  const future = date > through;
                  const preCoverage = !future && (!coverageDate || date < coverageDate);
                  const measured = Boolean(
                    day && (day.totalTokens > 0 || day.reportedRuns > 0 || day.unknownRuns > 0),
                  );
                  const level = day ? usageLevel(day.totalTokens, cuts) : 0;
                  const title = usageDayTitle(date, day, { future, preCoverage });
                  // Pre-coverage days that DO hold measured usage keep their
                  // colour; only genuinely unmeasured days recede. Measured usage
                  // is never hidden behind a coverage caveat.
                  const background = future
                    ? 'transparent'
                    : preCoverage && !measured
                      ? NO_DATA_FILL
                      : USAGE_RAMP[level];
                  return (
                    <span
                      key={date}
                      role="img"
                      aria-label={title}
                      title={title}
                      className="block shrink-0 rounded-[2px]"
                      style={{ background, height: CELL, width: CELL }}
                    />
                  );
                })}
              </div>
            ))}

            {boundaryWeek > 0 && (
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-0"
                style={{
                  borderLeft: `1px dashed ${COVERAGE_RULE}`,
                  left: boundaryWeek * PITCH - GAP / 2 - 0.5,
                  top: -7,
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* The caption sits OUTSIDE the scroller, repeating the rule's dash so the
          mark is still explained. It was previously anchored to the rule inside
          the grid, which read better on a desktop where the whole year fits —
          but the chart opens scrolled to the newest weeks, so on a phone the
          February rule is off to the left and its caption rendered as the
          fragment "ct since Feb 18". An annotation that can be cut in half by
          its own scroll container is worse than one that is merely nearby. */}
      {boundaryWeek > 0 && coverageStartedAt && (
        <p className="mt-2 flex items-center gap-1.5 font-sans text-[9px] leading-none text-text-subtle">
          <span
            aria-hidden
            className="inline-block h-[9px] shrink-0"
            style={{ borderLeft: `1px dashed ${COVERAGE_RULE}` }}
          />
          {coverageNote(coverageStartedAt)}
        </p>
      )}
    </div>
  );
}

/**
 * Quartile boundaries over the ACTIVE days only. Zero days are excluded so a
 * quiet year does not spend three of the four levels describing nothing.
 */
export function usageQuantileCuts(days: AgentTokenUsageDay[]): [number, number, number] {
  const values = days
    .map((day) => day.totalTokens)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return [1, 2, 3];
  const at = (quantile: number) =>
    values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 1;
  return [at(0.25), at(0.5), at(0.75)];
}

/**
 * Required, not optional: the caption only renders alongside a rule, and a rule
 * only exists once there is a date to draw it at. An optional parameter here
 * would be an unreachable branch pretending to be a supported case.
 */
function coverageNote(coverageStartedAt: string): string {
  const started = new Date(coverageStartedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  return `Exact since ${started}`;
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

/** The single busiest day in a series, or undefined when nothing was measured. */
export function peakUsageDay(days: AgentTokenUsageDay[]): AgentTokenUsageDay | undefined {
  return days.reduce<AgentTokenUsageDay | undefined>(
    (best, day) => (day.totalTokens > (best?.totalTokens ?? 0) ? day : best),
    undefined,
  );
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}K`;
  return value.toLocaleString();
}

export function formatUsageDate(date: string): string {
  return parseLocalDate(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function usageLevel(value: number, cuts: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value < cuts[0]) return 1;
  if (value < cuts[1]) return 2;
  if (value < cuts[2]) return 3;
  return 4;
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
  state: { future: boolean; preCoverage: boolean },
): string {
  const label = parseLocalDate(date).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  if (state.future) return `${label}: future`;
  if (state.preCoverage && !day) return `${label}: before exact tracking began`;
  if (!day || (day.totalTokens === 0 && day.unknownRuns === 0)) return `${label}: 0 tokens`;
  const parts = day.totalTokens > 0 ? [`${formatTokens(day.totalTokens)} tokens`] : ['Token usage unavailable'];
  if (day.unknownRuns > 0 && day.totalTokens > 0) parts.push('provider reporting incomplete');
  if (state.preCoverage) parts.push('exact coverage incomplete');
  return `${label}: ${parts.join(' · ')}`;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!, 12);
}

function trimFixed(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}
