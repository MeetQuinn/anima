import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentConfigSchema } from '@shared/agent-config';
import type { AgentStatusSummary } from '@shared/snapshot';
import { fetchAgentStatuses } from '@/api/agents';
import { queryKeys } from '@/lib/query-keys';
import Sidebar from './Sidebar';

vi.mock('@/api/agents', async (original) => ({
  ...(await original<typeof import('@/api/agents')>()),
  fetchAgentStatuses: vi.fn(),
}));
vi.mock('@/hooks/useTeams', async (original) => ({
  ...(await original<typeof import('@/hooks/useTeams')>()),
  useTeams: () => [{ id: 'core', name: 'Core' }],
  useCurrentTeam: () => ({ currentTeamId: 'core', setCurrentTeamId: vi.fn() }),
}));
vi.mock('@/hooks/useSidebarOrder', () => ({
  useSidebarOrder: () => ({
    orderedAgents: [
      agentConfigSchema('scout').parse({
        id: 'scout',
        profile: { displayName: 'Scout' },
        slack: { appToken: 'xapp-test', botToken: 'xoxb-test' },
      }),
    ],
    orderedKbs: [],
    agentIndexMap: new Map([['scout', 0]]),
    kbIndexMap: new Map(),
    sensors: [],
    reorderAgents: vi.fn(),
    reorderKbs: vi.fn(),
  }),
}));

let client: QueryClient;
const fetchStatuses = vi.mocked(fetchAgentStatuses);
function status(state: 'connected' | 'reconnecting' = 'connected', age = 0): AgentStatusSummary[] {
  const at = new Date(Date.now() - age).toISOString();
  return [
    {
      agentId: 'scout',
      itemCount: 0,
      queueDepth: 0,
      health: {
        state: 'healthy',
        updatedAt: at,
        runtime: {
          providerChildExpected: false,
          providerWork: { state: 'working' },
          transports: {
            slack: { state, observedAt: at, since: at, attempts: state === 'connected' ? 0 : 1 },
          },
        },
      },
    },
  ];
}
function mount(collapsed = false) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/scout/activity']}>
        <Sidebar collapsed={collapsed} onToggle={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function flush(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function pending() {
  let resolve!: (value: AgentStatusSummary[]) => void;
  let reject!: (error: Error) => void;
  fetchStatuses.mockReturnValue(
    new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    }),
  );
  return { resolve, reject };
}
function expectQuiet() {
  expect(screen.getByRole('button', { name: /^Scout,? working$/ })).toBeTruthy();
  expect(screen.queryByText(/Slack (status|connected|reconnecting|disconnected)/)).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T08:00:00Z'));
  focusManager.setFocused(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchStatuses.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

it.each([false, true])(
  'does not flash stale cached Slack state on remount (collapsed=%s)',
  async (collapsed) => {
    // The cached response, not the running listener, aged while this view was closed.
    client.setQueryData(queryKeys.agentStatuses(), status('connected', 40_000), {
      updatedAt: Date.now() - 40_000,
    });
    const request = pending();
    mount(collapsed);
    expectQuiet();
    await flush(2_000);
    expectQuiet();
    request.resolve(status());
    await flush();
    expectQuiet();
  },
);

it('waits for foreground revalidation but retains a fresh real disconnect', async () => {
  fetchStatuses.mockImplementation(async () => status());
  mount();
  await flush();
  expectQuiet();
  act(() => focusManager.setFocused(false));
  await flush(40_000);
  const request = pending();
  act(() => focusManager.setFocused(true));
  await flush();
  expectQuiet();
  request.resolve(status('reconnecting'));
  await flush();
  expect(screen.getByText('Slack reconnecting')).toBeTruthy();
});

it.each(['stale response', 'request failure', 'hung request'])(
  'shows unavailable after %s',
  async (outcome) => {
    client.setQueryData(queryKeys.agentStatuses(), status('connected', 40_000), {
      updatedAt: Date.now() - 40_000,
    });
    const request = pending();
    mount();
    expectQuiet();
    if (outcome === 'stale response') request.resolve(status('connected', 40_000));
    if (outcome === 'request failure') request.reject(new Error('offline'));
    await flush(outcome === 'hung request' ? 10_000 : 1);
    expect(screen.getByText('Slack status unavailable')).toBeTruthy();
  },
);

it('does not hide a cached disconnect while refreshing it', () => {
  client.setQueryData(queryKeys.agentStatuses(), status('reconnecting', 40_000), {
    updatedAt: Date.now() - 40_000,
  });
  pending();
  mount();
  expect(screen.getByText('Slack status unavailable')).toBeTruthy();
});

it('keeps a server-confirmed stale snapshot visible during refresh', () => {
  client.setQueryData(queryKeys.agentStatuses(), status('connected', 80_000), {
    updatedAt: Date.now() - 40_000,
  });
  pending();
  mount();
  expect(screen.getByText('Slack status unavailable')).toBeTruthy();
});

it('does not invent a connection warning before the first response', async () => {
  const request = pending();
  mount();
  expect(screen.queryByText(/Slack (status|connected|reconnecting|disconnected)/)).toBeNull();
  expect(screen.queryByText('Not connected')).toBeNull();
  request.resolve(status());
  await flush();
  expectQuiet();
});

it('does not restart an expired refresh window when another surface mounts', async () => {
  client.setQueryData(queryKeys.agentStatuses(), status('connected', 40_000), {
    updatedAt: Date.now() - 40_000,
  });
  pending();
  mount();
  await flush(40_000);
  expect(screen.getAllByText('Slack status unavailable')).toHaveLength(1);
  mount();
  expect(screen.getAllByText('Slack status unavailable')).toHaveLength(2);
  await flush(5_000);
  expect(screen.getAllByText('Slack status unavailable')).toHaveLength(2);
});
