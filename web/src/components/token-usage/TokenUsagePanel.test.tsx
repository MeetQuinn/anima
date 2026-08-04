import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import TokenUsagePanel, { commonCoverageStart, formatShare, rankAgents } from './TokenUsagePanel';

const api = vi.hoisted(() => ({ fetchAgentTokenUsage: vi.fn() }));

// The panel renders UsageHeatmap, which observes its scroll container so a
// resize cannot strand the reader on the empty oldest weeks. jsdom has no
// ResizeObserver. The behaviour itself is pinned in UsageHeatmap.test.tsx; here
// the stub only needs to exist, so it is inert on purpose — a version that
// fired the callback would be asserting the heatmap's job from the wrong file.
vi.stubGlobal(
  'ResizeObserver',
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  },
);

function agent(agentId: string, agentName: string, totalTokens: number, extra: Record<string, unknown> = {}) {
  return {
    agentId,
    agentName,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    days:
      totalTokens > 0
        ? [
            {
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              date: '2026-08-04',
              inputTokens: totalTokens,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              reportedRuns: 2,
              totalTokens,
              unknownRuns: 0,
            },
          ]
        : [],
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    reportedRuns: totalTokens > 0 ? 2 : 0,
    totalTokens,
    unknownRuns: totalTokens > 0 ? 0 : 1,
    ...extra,
  };
}

function report(agents: ReturnType<typeof agent>[]) {
  return {
    agents,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    from: '2025-08-10',
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    reportedRuns: 2,
    through: '2026-08-04',
    timezone: 'Asia/Shanghai',
    totalTokens: agents.reduce((sum, entry) => sum + entry.totalTokens, 0),
    unknownRuns: 1,
  };
}

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

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <TokenUsagePanel onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('TokenUsagePanel', () => {
  it('starts aggregate exact coverage only when every agent is covered', () => {
    expect(commonCoverageStart([
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    ])).toBe('2026-08-03T00:00:00.000Z');
    expect(commonCoverageStart(['2026-08-01T00:00:00.000Z', undefined])).toBeUndefined();
  });

  it('ranks by usage and breaks ties on name so refetches do not reshuffle', () => {
    const order = rankAgents([agent('c', 'Cleo', 10), agent('a', 'Ada', 10), agent('b', 'Bo', 90)]);
    expect(order.map((entry) => entry.agentName)).toEqual(['Bo', 'Ada', 'Cleo']);
  });

  it('keeps a small share readable instead of rounding it to zero', () => {
    expect(formatShare(0.04)).toBe('0.0');
    expect(formatShare(0.9)).toBe('0.9');
    expect(formatShare(54.4)).toBe('54');
  });

  it('shows the lifetime total, the busiest day, and a ranked agent list', async () => {
    api.fetchAgentTokenUsage.mockResolvedValue(
      report([
        agent('bram', 'Bram', 0),
        agent('mira', 'Mira', 350, {
          avatarUrl: 'https://avatars.example/mira.png',
          coverageStartedAt: '2026-08-01T00:00:00.000Z',
        }),
      ]),
    );
    renderPanel();

    expect(await screen.findByText('Mira')).toBeTruthy();
    expect(screen.getByText('Lifetime')).toBeTruthy();
    expect(screen.getByText(/Busiest day/)).toBeTruthy();
    expect(screen.getByText('Top agents')).toBeTruthy();

    // Sorted, not registry order: Mira has usage, Bram has none, and the mock
    // returns Bram first.
    const rows = screen.getAllByRole('button').filter((node) => /Mira|Bram/.test(node.textContent ?? ''));
    expect(rows.map((row) => row.querySelector('.font-serif')?.textContent)).toEqual(['Mira', 'Bram']);
    expect(rows[0]?.textContent).toContain('100% · peak 350');
    // A share that rounds to zero keeps a decimal rather than reading as
    // "used nothing".
    expect(rows[1]?.textContent).toContain('0.0%');
    expect(screen.getByText('Mira').closest('button')?.querySelector('img')?.getAttribute('src'))
      .toBe('https://avatars.example/mira.png');
    expect(screen.getByText('Bram').closest('button')?.querySelector('[aria-hidden="true"]')?.textContent)
      .toBe('B');

    // Measured usage still reads as measured even while aggregate coverage is
    // incomplete (Bram has never started tracking).
    expect(screen.getByLabelText(/350 tokens · exact coverage incomplete/)).toBeTruthy();

    // The prose and the per-kind cache breakdown are gone, and the per-agent
    // heatmap with them. Pinned as absences BECAUSE the positives above are
    // pinned in the same render: over-removal cannot pass both halves.
    expect(screen.queryByText(/Tokens processed · all agents/)).toBeNull();
    expect(screen.queryByText(/All-agent totals become exact/)).toBeNull();
    expect(screen.queryByText('By agent')).toBeNull();
    expect(screen.queryByText(/shared intensity scale/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/cache/i);
    expect(document.body.textContent).not.toMatch(/\bruns?\b|\bunknown\b/i);
    expect(document.body.textContent).not.toMatch(/quota|cost/i);
  });

  it('draws the top ten and leaves the rest to the sidebar', async () => {
    api.fetchAgentTokenUsage.mockResolvedValue(
      report(Array.from({ length: 13 }, (_, index) => agent(`a${index}`, `Agent ${index}`, (13 - index) * 1000))),
    );
    renderPanel();

    expect(await screen.findByText('Agent 0')).toBeTruthy();
    expect(screen.getByText('Agent 9')).toBeTruthy();
    // The cut is real: the three smallest agents draw no row, and nothing
    // stands in for them.
    expect(screen.queryByText('Agent 10')).toBeNull();
    expect(screen.queryByText('Agent 12')).toBeNull();
    expect(screen.queryByText(/more agents/)).toBeNull();
  });
});
