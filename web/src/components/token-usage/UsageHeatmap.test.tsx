import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UsageHeatmap, mergeUsageDays, usageScaleMax } from './UsageHeatmap';

describe('UsageHeatmap', () => {
  it('renders exactly 52 weeks and distinguishes pre-coverage days from zero', () => {
    const { container } = render(
      <UsageHeatmap
        coverageStartedAt="2026-01-03T00:00:00.000Z"
        days={[
          {
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 900,
            date: '2026-01-04',
            inputTokens: 100,
            outputTokens: 200,
            reasoningOutputTokens: 50,
            reportedRuns: 2,
            totalTokens: 1200,
            unknownRuns: 0,
          },
          {
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            date: '2026-01-05',
            inputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            reportedRuns: 0,
            totalTokens: 0,
            unknownRuns: 1,
          },
        ]}
        from="2025-12-28"
        through="2026-12-26"
      />,
    );
    expect(container.querySelectorAll('span[title]').length).toBe(364);
    expect(screen.getAllByLabelText(/before exact tracking began/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/1.2K tokens · 2 reported runs/)).toBeTruthy();
    expect(screen.getByLabelText(/1 run without usage/).className).toContain('border-health-warn');
    expect(screen.getAllByLabelText(/0 tokens/).length).toBeGreaterThan(0);
  });

  it('merges daily agent totals without adding reasoning twice', () => {
    const merged = mergeUsageDays([
      [day('2026-08-01', 120, 80)],
      [day('2026-08-01', 30, 20), day('2026-08-02', 400, 100)],
    ]);
    expect(merged.map((entry) => [entry.date, entry.totalTokens, entry.reasoningOutputTokens])).toEqual([
      ['2026-08-01', 150, 100],
      ['2026-08-02', 400, 100],
    ]);
    expect(usageScaleMax(merged)).toBe(400);
  });
});

function day(date: string, totalTokens: number, reasoningOutputTokens: number) {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    date,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningOutputTokens,
    reportedRuns: 1,
    totalTokens,
    unknownRuns: 0,
  };
}
