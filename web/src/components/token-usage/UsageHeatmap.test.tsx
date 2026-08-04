import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentTokenUsageDay } from '@shared/agent-token-usage';
import { UsageHeatmap, mergeUsageDays, peakUsageDay, usageQuantileCuts } from './UsageHeatmap';

// jsdom ships neither ResizeObserver nor layout, and per the harness-boundary
// note in src/test/setup.ts both are mocked in the file that needs them rather
// than globally. The stub captures the callback so the resize branch can be
// driven directly; jsdom does store an assigned scrollLeft, so the assertions
// below read a real value rather than one this file wrote.
let onResize: (() => void) | undefined;
let observed: Element | undefined;

class StubResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  // The callback is captured in observe(), not in the constructor: capturing it
  // at construction let a version of the component that never called observe()
  // still pass this file's assertions. The target is recorded for the same
  // reason — observing the wrong node is a real way to ship this broken.
  observe(target: Element) {
    onResize = this.callback;
    observed = target;
  }
  disconnect() {
    onResize = undefined;
    observed = undefined;
  }
  unobserve() {}
}

vi.stubGlobal('ResizeObserver', StubResizeObserver);

function stubWidths(scrollWidth: number, clientWidth: number) {
  for (const [name, value] of [['scrollWidth', scrollWidth], ['clientWidth', clientWidth]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
}

afterEach(() => {
  for (const name of ['scrollWidth', 'clientWidth']) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  onResize = undefined;
  observed = undefined;
});

describe('UsageHeatmap', () => {
  it('renders exactly 52 weeks and distinguishes pre-coverage days from zero', () => {
    render(
      <UsageHeatmap
        coverageStartedAt="2026-01-03T00:00:00.000Z"
        days={[day('2026-01-04', 1200), { ...day('2026-01-05', 0), unknownRuns: 1 }]}
        from="2025-12-28"
        through="2026-12-26"
      />,
    );
    expect(screen.getAllByRole('img').length).toBe(364);
    expect(screen.getAllByLabelText(/before exact tracking began/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/1.2K tokens/)).toBeTruthy();
    expect(screen.getByLabelText(/Token usage unavailable/)).toBeTruthy();
    expect(screen.getAllByLabelText(/0 tokens/).length).toBeGreaterThan(0);
  });

  // The a11y half of the same DOM, pinned on BOTH sides. The container used to
  // be `role="img"`, which makes every descendant presentational and hides all
  // 364 per-day labels behind one summary sentence. Asserting only "cells are
  // images" would also pass if the container went back to being an image too,
  // so the negative is asserted with it.
  it('exposes every day to assistive tech instead of one summary image', () => {
    render(<UsageHeatmap days={[day('2026-01-04', 1200)]} from="2025-12-28" through="2026-12-26" />);
    const cells = screen.getAllByRole('img');
    expect(cells.length).toBe(364);
    expect(cells[0]?.getAttribute('aria-label')).toMatch(/\d/);
    expect(screen.getByRole('group', { name: 'Daily provider-reported token usage' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Daily provider-reported token usage' })).toBeNull();
  });

  // The reason the scale changed at all. Under the previous
  // log1p(value)/log1p(95th-percentile-max) bucketing these seven spread-out
  // days collapsed onto two levels; quartile cuts give the ramp back.
  it('spends the whole ramp on a spread-out series', () => {
    const spread = ['1K', '9K', '40K', '90K', '300K', '900K', '5M'];
    render(
      <UsageHeatmap
        days={[1_000, 9_000, 40_000, 90_000, 300_000, 900_000, 5_000_000].map((total, index) =>
          day(`2026-01-0${index + 1}`, total),
        )}
        from="2025-12-28"
        through="2026-12-26"
      />,
    );
    const fills = spread.map(
      (label) => screen.getByLabelText(new RegExp(`: ${label} tokens`)).style.background,
    );
    expect(fills.every(Boolean)).toBe(true);
    // Seven days spanning four orders of magnitude must reach all four active
    // levels. Under the previous log-against-a-max bucketing they collapsed
    // onto two, which is the defect this scale change exists to fix.
    expect(new Set(fills).size).toBe(4);
  });

  it('keeps measured usage visible when exact aggregate coverage is incomplete', () => {
    render(<UsageHeatmap days={[day('2026-02-26', 500_000)]} from="2025-12-28" through="2026-12-26" />);
    const measured = screen.getByLabelText(/500K tokens · exact coverage incomplete/);
    expect(measured.getAttribute('title')).not.toContain('before exact tracking began');
    // Measured usage is never repainted as "no data" just because coverage is
    // incomplete. The comparison is against a genuinely unmeasured day in the
    // same render, so the assertion fails if either fill moves.
    const unmeasured = screen.getAllByLabelText(/before exact tracking began/)[0]!;
    expect(measured.style.background).not.toBe('');
    expect(measured.style.background).not.toBe(unmeasured.style.background);
  });

  it('cuts quartiles over active days only, ignoring zeroes', () => {
    const days = [0, 0, 0, 100, 200, 300, 400].map((total, index) => day(`2026-03-0${index + 1}`, total));
    expect(usageQuantileCuts(days)).toEqual([200, 300, 400]);
    expect(usageQuantileCuts([])).toEqual([1, 2, 3]);
  });

  // The caption lives outside the scroll container so it cannot be cut in half
  // by it. Both sides: no coverage date means no rule, so there is nothing to
  // caption and the line must not appear at all.
  //
  // The date is deliberately well inside the year. A coverage date landing in
  // week 0 means the whole chart is covered, there is no "before" region to
  // demarcate, and the component draws neither rule nor caption — correct, but
  // it would make this test pass for the wrong reason.
  it('captions the coverage rule, and only when there is a rule', () => {
    const { rerender } = render(
      <UsageHeatmap
        coverageStartedAt="2026-03-05T00:00:00.000Z"
        days={[day('2026-01-04', 1200)]}
        from="2025-12-28"
        through="2026-12-26"
      />,
    );
    const caption = screen.getByText(/^Exact since /);
    expect(caption.closest('.overflow-x-auto')).toBeNull();

    rerender(<UsageHeatmap days={[day('2026-01-04', 1200)]} from="2025-12-28" through="2026-12-26" />);
    expect(screen.queryByText(/Exact since/)).toBeNull();
  });

  // The mount effect alone cannot cover this: at a width where the chart fits,
  // scrollLeft is legitimately 0, and shrinking to a phone width leaves it at 0
  // — the oldest, emptiest weeks — with no remount to correct it. Both halves
  // are pinned, because "always re-pin" would pass the first assertion and yank
  // a reader who had scrolled somewhere on purpose.
  it('re-pins to the newest weeks when a resize makes the chart overflow, but not over a reader', () => {
    stubWidths(757, 757);
    const { container } = render(
      <UsageHeatmap days={[day('2026-01-04', 1200)]} from="2025-12-28" through="2026-12-26" />,
    );
    const scroller = container.querySelector('.overflow-x-auto') as HTMLElement;
    expect(scroller.scrollLeft).toBe(0);
    expect(observed).toBe(scroller);

    // Landscape -> portrait: the chart now overflows and nothing moved it.
    stubWidths(757, 337);
    onResize?.();
    expect(scroller.scrollLeft).toBe(420);

    // A reader who scrolled back to the older weeks keeps their position.
    scroller.scrollLeft = 120;
    stubWidths(757, 300);
    onResize?.();
    expect(scroller.scrollLeft).toBe(120);
  });

  it('merges daily agent totals without adding reasoning twice', () => {
    const merged = mergeUsageDays([
      [reasoningDay('2026-08-01', 120, 80)],
      [reasoningDay('2026-08-01', 30, 20), reasoningDay('2026-08-02', 400, 100)],
    ]);
    expect(merged.map((entry) => [entry.date, entry.totalTokens, entry.reasoningOutputTokens])).toEqual([
      ['2026-08-01', 150, 100],
      ['2026-08-02', 400, 100],
    ]);
    expect(peakUsageDay(merged)?.date).toBe('2026-08-02');
    expect(peakUsageDay([])).toBeUndefined();
  });
});

function day(date: string, totalTokens: number): AgentTokenUsageDay {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    date,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    reportedRuns: totalTokens > 0 ? 1 : 0,
    totalTokens,
    unknownRuns: 0,
  };
}

function reasoningDay(date: string, totalTokens: number, reasoningOutputTokens: number): AgentTokenUsageDay {
  return { ...day(date, totalTokens), reasoningOutputTokens };
}
