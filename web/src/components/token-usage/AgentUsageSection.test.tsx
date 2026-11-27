import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentUsageSection } from './AgentUsageSection';

const api = vi.hoisted(() => ({ fetchAgentTokenUsage: vi.fn() }));

vi.stubGlobal(
  'ResizeObserver',
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  },
);

vi.mock('@/api/token-usage', () => ({
  currentTokenUsageRange: () => ({
    from: '2025-08-10',
    gridThrough: '2026-08-08',
    through: '2026-08-04',
    timezone: 'Asia/Shanghai',
  }),
  fetchAgentTokenUsage: api.fetchAgentTokenUsage,
  localDate: (value: Date) => {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },
}));

function reportWithCoverage(coverageStartedAt?: string) {
  return {
    agents: [
      {
        agentId: 'nora',
        agentName: 'Nora',
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        coverageStartedAt,
        days: [
          {
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            date: '2026-08-04',
            inputTokens: 1000,
            outputTokens: 200,
            reasoningOutputTokens: 50,
            reportedRuns: 1,
            totalTokens: 1200,
            unknownRuns: 0,
          },
        ],
        inputTokens: 1000,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        reportedRuns: 1,
        totalTokens: 1200,
        unknownRuns: 0,
      },
    ],
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    from: '2025-08-10',
    inputTokens: 1000,
    outputTokens: 200,
    reasoningOutputTokens: 50,
    reportedRuns: 1,
    through: '2026-08-04',
    timezone: 'Asia/Shanghai',
    totalTokens: 1200,
    unknownRuns: 0,
  };
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentUsageSection agentId="nora" />
    </QueryClientProvider>,
  );
}

describe('AgentUsageSection', () => {
  it('shows Exact since once when coverage starts within the 52-week heatmap range', async () => {
    api.fetchAgentTokenUsage.mockResolvedValueOnce(reportWithCoverage('2026-03-05T12:00:00.000Z'));
    renderSection();
    expect(await screen.findByText('Tokens · Past 52 weeks')).toBeTruthy();
    expect(screen.getAllByText(/^Exact since /)).toHaveLength(1);
    expect(screen.getByText('Provider-reported totals only. Output includes reasoning tokens.')).toBeTruthy();
  });

  it('shows formatted Exact since once in the header when coverage started before the 52-week range', async () => {
    api.fetchAgentTokenUsage.mockResolvedValueOnce(reportWithCoverage('2025-01-15T12:00:00.000Z'));
    renderSection();
    expect(await screen.findByText('Tokens · Past 52 weeks')).toBeTruthy();
    expect(screen.getAllByText(/^Exact since /)).toHaveLength(1);
  });

  it('explains when exact tracking will begin if coverage has not started yet', async () => {
    api.fetchAgentTokenUsage.mockResolvedValueOnce(reportWithCoverage(undefined));
    renderSection();
    expect(await screen.findByText('Exact tracking begins when this agent next restarts.')).toBeTruthy();
  });
});
