import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import TokenUsagePanel, { commonCoverageStart } from './TokenUsagePanel';

vi.mock('@/api/token-usage', () => ({
  currentTokenUsageRange: () => ({
    from: '2025-08-10',
    gridThrough: '2026-08-08',
    through: '2026-08-04',
    timezone: 'Asia/Shanghai',
  }),
  fetchAgentTokenUsage: vi.fn(async () => ({
    agents: [
      {
        agentId: 'mira',
        agentName: 'Mira',
        avatarUrl: 'https://avatars.example/mira.png',
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 200,
        coverageStartedAt: '2026-08-01T00:00:00.000Z',
        days: [],
        inputTokens: 100,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        reportedRuns: 2,
        totalTokens: 350,
        unknownRuns: 0,
      },
      {
        agentId: 'bram',
        agentName: 'Bram',
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        days: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        reportedRuns: 0,
        totalTokens: 0,
        unknownRuns: 1,
      },
    ],
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 200,
    from: '2025-08-10',
    inputTokens: 100,
    outputTokens: 50,
    reasoningOutputTokens: 10,
    reportedRuns: 2,
    through: '2026-08-04',
    timezone: 'Asia/Shanghai',
    totalTokens: 350,
    unknownRuns: 1,
  })),
  localDate: (value: Date) => {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },
}));

describe('TokenUsagePanel', () => {
  it('starts aggregate exact coverage only when every agent is covered', () => {
    expect(commonCoverageStart([
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    ])).toBe('2026-08-03T00:00:00.000Z');
    expect(commonCoverageStart(['2026-08-01T00:00:00.000Z', undefined])).toBeUndefined();
  });

  it('shows aggregate and per-agent exact usage without calling it quota or cost', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TokenUsagePanel onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Mira')).toBeTruthy();
    expect(screen.getByText('Bram')).toBeTruthy();
    expect(screen.getByText('Mira').closest('button')?.querySelector('img')?.getAttribute('src')).toBe('https://avatars.example/mira.png');
    expect(screen.getByText('Bram').closest('button')?.querySelector('[aria-hidden="true"]')?.textContent).toBe('B');
    expect(screen.getByText(/Tokens processed · all agents/)).toBeTruthy();
    expect(screen.getByText(/Earlier days are intentionally unfilled, not estimated/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/quota|cost/i);
  });
});
