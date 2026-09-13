import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Sidebar from './Sidebar';
import MobileNavScreen from './MobileNavScreen';

// The sidebar footer used to be three panel triggers (Usage, Providers, Server)
// with two resting update dots. It is now one entry — Settings — that opens the
// settings surface and records where the user came from so Back can return
// there. No dots: an available update is announced on the settings list.
//
// Both spines (desktop Sidebar, mobile Screen 1) are pinned here because the
// footer is the same promise on both, and the mobile footer was the only
// mobile entry to those panels.

vi.mock('@/hooks/useAgentDirectory', () => ({
  useAgents: () => ({ data: [{ id: 'nora', profile: { displayName: 'Nora' } }] }),
  useAgentStatuses: () => ({ data: [] }),
}));
vi.mock('@/hooks/useTeams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTeams')>();
  return {
    ...actual,
    useTeams: () => [{ id: 'core', name: 'Core', home: 'core' }],
    useCurrentTeam: () => ({ currentTeamId: 'core', currentTeam: { id: 'core', name: 'Core', home: 'core' }, setCurrentTeamId: vi.fn() }),
  };
});
vi.mock('@/hooks/useSidebarOrder', () => ({
  useSidebarOrder: () => ({
    orderedAgents: [],
    orderedKbs: [],
    agentIndexMap: new Map(),
    kbIndexMap: new Map(),
    sensors: [],
    reorderAgents: vi.fn(),
    reorderKbs: vi.fn(),
  }),
}));
// These two queries fed the removed dots. Spied so the test can say they are
// no longer asked for on the spine at all — the dots are gone, not hidden.
const status = vi.hoisted(() => ({ upgrade: vi.fn(), providerCli: vi.fn() }));
vi.mock('@/hooks/useRuntimeUpgrade', () => ({
  useRuntimeUpgrade: status.upgrade,
  useUpdateAvailable: status.upgrade,
}));
vi.mock('@/hooks/useProviderCliStatus', () => ({ useProviderCliStatus: status.providerCli }));

function Probe() {
  const location = useLocation();
  return (
    <div>
      probe {location.pathname} state={JSON.stringify(location.state)}
    </div>
  );
}

function renderSpine(ui: React.ReactElement, at = '/agents/nora/activity?team=core') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/agents/:agentId/*" element={ui} />
          <Route path="/" element={ui} />
          <Route path="/settings/:page?" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  status.upgrade.mockReturnValue(true);
  status.providerCli.mockReturnValue({ data: { providers: [{ updateAvailable: true }] } });
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('desktop sidebar footer', () => {
  it.each([false, true])('has exactly one footer control, Settings, and no update dot (collapsed=%s)', (collapsed) => {
    renderSpine(<Sidebar collapsed={collapsed} onToggle={() => {}} />);

    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    for (const gone of ['Token usage', 'Providers', 'Server', 'Server status & restart', 'Usage']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
      expect(screen.queryByTitle(new RegExp(`^${gone}`))).toBeNull();
    }
    expect(document.querySelector('[data-server-panel-trigger]')).toBeNull();
    // With BOTH updates available, nothing on the spine turns into a dot.
    expect(document.querySelectorAll('.rounded-full.bg-accent').length).toBe(0);
    expect(status.upgrade).not.toHaveBeenCalled();
    expect(status.providerCli).not.toHaveBeenCalled();
  });

  it('opens the settings surface and records the current page, query included, for Back', () => {
    renderSpine(<Sidebar collapsed={false} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByText('probe /settings state={"from":"/agents/nora/activity?team=core"}')).toBeTruthy();
    expect(sessionStorage.getItem('settings-return-to')).toBe('/agents/nora/activity?team=core');
  });
});

describe('mobile nav screen footer', () => {
  it('collapses Usage / Providers / Server into one Settings entry and opens the surface', () => {
    renderSpine(<MobileNavScreen onSelectAgent={() => {}} />, '/?team=core');

    const footer = screen.getByRole('button', { name: 'Settings' });
    expect(within(footer).getByText('Settings')).toBeTruthy();
    for (const gone of ['Usage', 'Providers', 'Server']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
    expect(document.querySelectorAll('.rounded-full.bg-accent').length).toBe(0);
    expect(status.upgrade).not.toHaveBeenCalled();
    expect(status.providerCli).not.toHaveBeenCalled();

    fireEvent.click(footer);
    expect(screen.getByText('probe /settings state={"from":"/?team=core"}')).toBeTruthy();
  });
});
