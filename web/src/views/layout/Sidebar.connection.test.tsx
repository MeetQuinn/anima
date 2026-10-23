import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { agentConfigSchema } from '@shared/agent-config';
import type { AgentStatusSummary } from '@shared/snapshot';
import Sidebar from './Sidebar';
const fixtures = vi.hoisted(() => ({ agents: [] as unknown[], statuses: [] as unknown[] }));
vi.mock('@/hooks/useAgentDirectory', () => ({
  useAgentStatuses: () => ({ data: fixtures.statuses }),
}));
vi.mock('@/hooks/useTeams', async (original) => ({
  ...(await original<typeof import('@/hooks/useTeams')>()),
  useTeams: () => [{ id: 'core', name: 'Core' }],
  useCurrentTeam: () => ({
    currentTeamId: 'core',
    currentTeam: { id: 'core', name: 'Core' },
    setCurrentTeamId: vi.fn(),
  }),
}));
vi.mock('@/hooks/useSidebarOrder', () => ({
  useSidebarOrder: () => ({
    orderedAgents: fixtures.agents,
    orderedKbs: [],
    agentIndexMap: new Map([['milo', 0]]),
    kbIndexMap: new Map(),
    sensors: [],
    reorderAgents: vi.fn(),
    reorderKbs: vi.fn(),
  }),
}));
afterEach(() => vi.useRealTimers());
it('keeps Slack warning and provider work separate in the collapsed rail', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
  fixtures.agents = [
    agentConfigSchema('milo').parse({
      id: 'milo',
      profile: { displayName: 'Milo' },
      slack: { appToken: 'xapp-test', botToken: 'xoxb-test' },
    }),
  ];
  const at = new Date().toISOString();
  const status: AgentStatusSummary = {
    agentId: 'milo',
    itemCount: 0,
    queueDepth: 0,
    health: {
      state: 'healthy',
      updatedAt: at,
      runtime: {
        providerChildExpected: false,
        providerWork: { state: 'working' },
        transports: {
          slack: {
            state: 'reconnecting',
            observedAt: at,
            since: at,
            disconnectedAt: at,
            attempts: 2,
            reason: 'network_error',
          },
        },
      },
    },
  };
  fixtures.statuses = [status];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/agents/milo/activity']}>
        <Sidebar collapsed onToggle={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui);
  const button = screen.getByRole('button', { name: 'Milo, working, Slack reconnecting' });
  expect(button.getAttribute('title')).toContain('network_error');
  expect(button.querySelector('[title="working"]')).toBeTruthy();
  expect(button.textContent).toContain('!');
  status.health!.runtime!.transports!.slack!.state = 'connected';
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Sidebar collapsed onToggle={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name: 'Milo, working' }).textContent).not.toContain('!');
  act(() => vi.advanceTimersByTime(35_000));
  expect(
    screen.getByRole('button', { name: 'Milo, working, Slack status unavailable' }),
  ).toBeTruthy();
});
