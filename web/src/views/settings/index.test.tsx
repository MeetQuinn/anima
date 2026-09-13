import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeUpgradeStatusResponse } from '@shared/runtime-upgrade';

import SettingsLayout from './index';

// The settings shell: a standalone surface at /settings/:page with the list on
// the left, the page on the right, Back to wherever the user came from, and
// the "Update Anima" button that exists only while an update is available.
//
// The four pages are stubbed to markers. Their own tests cover their content;
// here the question is whether the shell puts the right one on screen — and
// the real Providers page fetches on mount, which no shell test should trigger.

vi.mock('./ServerPage', () => ({ default: () => <div>server-page-body</div> }));
vi.mock('./ProvidersPage', () => ({ default: () => <div>providers-page-body</div> }));
vi.mock('./TokenUsagePage', () => ({ default: () => <div>token-usage-page-body</div> }));
vi.mock('./OutreachLimitsPage', () => ({ default: () => <div>outreach-limits-page-body</div> }));

const api = vi.hoisted(() => ({
  fetchRuntimeUpgrade: vi.fn(),
  applyRuntimeUpgrade: vi.fn(),
  fetchProviderCliStatus: vi.fn(),
}));
vi.mock('@/api/system', () => ({
  fetchRuntimeUpgrade: api.fetchRuntimeUpgrade,
  applyRuntimeUpgrade: api.applyRuntimeUpgrade,
  fetchProviderCliStatus: api.fetchProviderCliStatus,
  RuntimeUpgradeApplyError: class RuntimeUpgradeApplyError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/hooks/useAgentDirectory', () => ({
  useAgents: () => ({ data: [{ id: 'nora', profile: { displayName: 'Nora' } }] }),
  useAgentStatuses: () => ({ data: [] }),
}));

function upgradeStatus(
  state: RuntimeUpgradeStatusResponse['state'],
  extra: Partial<RuntimeUpgradeStatusResponse> = {},
): RuntimeUpgradeStatusResponse {
  return {
    checkedAt: '2026-09-13T00:00:00.000Z',
    currentVersion: '0.1.1-canary.75.1.80810fb',
    gate: { blockers: [], state: 'idle' },
    latestOnTrack: state === 'available' ? '0.1.1-canary.76.1.9c2d4ee' : undefined,
    operation: { status: 'idle' },
    releaseTrack: 'canary',
    state,
    updateAvailable: state === 'available',
    ...extra,
  };
}

function providerCli(updateAvailable: boolean) {
  return {
    operation: { status: 'idle' },
    upgradeLocked: false,
    providers: [
      {
        agents: [],
        installSource: 'npm',
        label: 'Claude Code',
        operation: { status: 'idle' },
        provider: 'claude-code',
        state: updateAvailable ? 'available' : 'current',
        updateAvailable,
        updateMode: 'managed',
      },
    ],
  };
}

/** A stand-in for the page the user came from, so Back has a real target. */
function Elsewhere() {
  const location = useLocation();
  return <div>elsewhere at {location.pathname + location.search}</div>;
}

function renderAt(path: string, state?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/settings/:page?', element: <SettingsLayout /> },
      { path: '/agents/:agentId/*', element: <Elsewhere /> },
      { path: '/', element: <Elsewhere /> },
    ],
    { initialEntries: [{ pathname: path, state }] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

beforeEach(() => {
  api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('current'));
  api.applyRuntimeUpgrade.mockResolvedValue({ ok: true, scheduled: true });
  api.fetchProviderCliStatus.mockResolvedValue(providerCli(false));
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  setViewportWidth(1280);
  sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('settings shell (desktop)', () => {
  it('renders the requested page beside the list and marks it current', async () => {
    renderAt('/settings/providers');

    expect(await screen.findByText('providers-page-body')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Providers' })).toBeTruthy();
    expect(screen.queryByText('server-page-body')).toBeNull();

    const list = screen.getByRole('navigation', { name: 'Settings' });
    const current = within(list).getByRole('button', { name: 'Providers' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(list).getByRole('button', { name: 'Server' }).getAttribute('aria-current')).toBeNull();
    // Both groups, in order, and no agents sidebar anywhere on this surface.
    expect(within(list).getByText('Runtime')).toBeTruthy();
    expect(within(list).getByText('Policies')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new agent/i })).toBeNull();
  });

  it('opens the first page for the bare path and for an unknown page', async () => {
    const first = renderAt('/settings');
    expect(await screen.findByText('server-page-body')).toBeTruthy();
    expect(first.router.state.location.pathname).toBe('/settings/server');

    first.unmount();
    const second = renderAt('/settings/not-a-page');
    await waitFor(() => expect(second.router.state.location.pathname).toBe('/settings/server'));
  });

  it('switches pages from the list and hands focus to the new title', async () => {
    const { router } = renderAt('/settings/server');
    expect(await screen.findByText('server-page-body')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));

    expect(await screen.findByText('token-usage-page-body')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings/token-usage');
    const title = screen.getByRole('heading', { level: 1, name: 'Token usage' });
    expect(document.activeElement).toBe(title);
    expect(screen.queryByText('server-page-body')).toBeNull();
  });

  it('Back returns to the page the user came from, query included', async () => {
    renderAt('/settings/server', { from: '/agents/nora/activity?team=core' });
    expect(await screen.findByText('server-page-body')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(await screen.findByText('elsewhere at /agents/nora/activity?team=core')).toBeTruthy();
  });

  it('Back falls back to the root when nothing was recorded', async () => {
    renderAt('/settings/server');
    expect(await screen.findByText('server-page-body')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('elsewhere at /')).toBeTruthy();
  });

  it('shows the Providers "Update" pill only while a provider CLI update is waiting', async () => {
    api.fetchProviderCliStatus.mockResolvedValue(providerCli(true));
    const first = renderAt('/settings/server');
    const list = screen.getByRole('navigation', { name: 'Settings' });
    const providers = within(list).getByRole('button', { name: /Providers/ });
    await waitFor(() => expect(within(providers).getByText('Update')).toBeTruthy());
    // Only Providers carries it; Server does not (the footer button speaks for it).
    expect(within(within(list).getByRole('button', { name: 'Server' })).queryByText('Update')).toBeNull();

    // Control: same shell, no provider update, no pill.
    first.unmount();
    api.fetchProviderCliStatus.mockResolvedValue(providerCli(false));
    renderAt('/settings/server');
    await screen.findByText('server-page-body');
    await waitFor(() => expect(api.fetchProviderCliStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Update')).toBeNull();
  });
});

describe('Update Anima button', () => {
  it('does not exist when the runtime is current', async () => {
    renderAt('/settings/server');
    expect(await screen.findByText('server-page-body')).toBeTruthy();
    await waitFor(() => expect(api.fetchRuntimeUpgrade).toHaveBeenCalled());
    // The list is present (control), the button is not.
    expect(screen.getByRole('button', { name: 'Server' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Update Anima/ })).toBeNull();
  });

  it('exists with the version pair while an update is available and applies at once when every agent is idle', async () => {
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('available'));
    renderAt('/settings/server');

    const button = await screen.findByRole('button', {
      name: 'Update Anima, 0.1.1-canary.75.1.80810fb to 0.1.1-canary.76.1.9c2d4ee',
    });
    // The pair on the button drops the commit SHA so two canary versions fit
    // the 256px column; the full strings stay in the accessible name.
    expect(within(button).getByText('0.1.1-canary.75.1 → 0.1.1-canary.76.1')).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() => expect(api.applyRuntimeUpgrade).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Progress overlay, still on the same page — no navigation.
    expect(await screen.findByText('Installing 0.1.1-canary.76.1.9c2d4ee…')).toBeTruthy();
    expect(screen.getByText('server-page-body')).toBeTruthy();
  });

  it('asks first, naming the working agent, when an agent is mid-item', async () => {
    api.fetchRuntimeUpgrade.mockResolvedValue(
      upgradeStatus('available', {
        gate: {
          state: 'busy',
          blockers: [{ agentId: 'nora', itemId: 'item-1', since: '2026-09-13T00:00:00.000Z', status: 'running' }],
        },
      }),
    );
    renderAt('/settings/server');

    fireEvent.click(await screen.findByRole('button', { name: /^Update Anima,/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Update & restart now?' });
    expect(within(dialog).getByText(/Nora/)).toBeTruthy();
    expect(api.applyRuntimeUpgrade).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.applyRuntimeUpgrade).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Update Anima,/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Update & restart' }));
    await waitFor(() => expect(api.applyRuntimeUpgrade).toHaveBeenCalledTimes(1));
  });
});

describe('Update Anima button: install failure', () => {
  // The worker can fail the install BEFORE the restart (dashboard never goes
  // down). The poll sees operation.status=failed; the page whose footer started
  // the update must say so — the Server page's FailedCard is on another page.
  const failedOp = {
    status: 'failed' as const,
    error: 'Target verification failed',
    completedAt: '2026-09-13T00:00:05.000Z',
  };

  it('surfaces the polled failure on the page that started it, and the button retries', async () => {
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('available'));
    renderAt('/settings/providers');
    const button = await screen.findByRole('button', { name: /^Update Anima,/ });
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('available', { operation: failedOp }));

    fireEvent.click(button);
    expect(await screen.findByText(/^Installing .*…$/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/^Installing .*…$/)).toBeNull(), { timeout: 3500 });

    expect(api.applyRuntimeUpgrade).toHaveBeenCalledTimes(1);
    expect(api.fetchRuntimeUpgrade.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Still on the page that started it, with the failure spelled out.
    expect(screen.getByText('providers-page-body')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Update failed/);
    expect(alert.textContent).toMatch(/still on 0\.1\.1-canary\.75\.1\.80810fb/);
    expect(alert.textContent).toMatch(/Target verification failed/);

    // Retry: the button is back and enabled; pressing it applies again and
    // clears the failure while the new attempt is in progress.
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('available'));
    const retry = screen.getByRole('button', { name: /^Update Anima,/ });
    expect(retry.hasAttribute('disabled')).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(api.applyRuntimeUpgrade).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^Installing .*…$/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the current operation visible even when the status flips away from "available"', async () => {
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('available'));
    renderAt('/settings/token-usage');
    fireEvent.click(await screen.findByRole('button', { name: /^Update Anima,/ }));
    expect(await screen.findByText(/^Installing .*…$/)).toBeTruthy();

    // The check itself errors mid-install (state=error): the overlay for the
    // operation we started must not vanish with the button.
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('error'));
    await waitFor(() => expect(api.fetchRuntimeUpgrade.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 3500,
    });
    expect(screen.getByText(/^Installing .*…$/)).toBeTruthy();

    // ...and when the failure arrives while the button is hidden, the failure
    // still lands on this page with a way to try again.
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('error', { operation: failedOp }));
    await waitFor(() => expect(screen.queryByText(/^Installing .*…$/)).toBeNull(), { timeout: 3500 });
    expect(screen.getByRole('alert').textContent).toMatch(/Update failed/);
    // The shared status query refetches after the failure; once it reads
    // "error" the offer is gone and the note carries its own retry.
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Update Anima,/ })).toBeNull());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByText('token-usage-page-body')).toBeTruthy();
  });

  it('keeps the error and a retry when the retry request itself is rejected while the offer is gone', async () => {
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('available'));
    renderAt('/settings/outreach-limits');
    fireEvent.click(await screen.findByRole('button', { name: /^Update Anima,/ }));
    expect(await screen.findByText(/^Installing .*…$/)).toBeTruthy();
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('error', { operation: failedOp }));
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 3500 });

    // The registry is still down: the apply request is refused outright.
    api.applyRuntimeUpgrade.mockRejectedValueOnce(new Error('Retry rejected: package registry offline'));
    fireEvent.click(retry);
    await waitFor(() => expect(api.applyRuntimeUpgrade).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Retry rejected: package registry offline/),
    );
    expect(screen.queryByText(/^Installing .*…$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Update Anima,/ })).toBeNull();

    // ...and the footer still offers a way to try once more, which applies again.
    api.applyRuntimeUpgrade.mockResolvedValueOnce({ ok: true, scheduled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.applyRuntimeUpgrade).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/^Installing .*…$/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('outreach-limits-page-body')).toBeTruthy();
  });
});

describe('settings shell (mobile)', () => {
  beforeEach(() => {
    setViewportWidth(375);
  });

  it('is two-level: the bare path is the list, a page has its own bar with Settings as the way back', async () => {
    const { router } = renderAt('/settings', { from: '/agents/nora/activity' });

    // Level 1: list only, no page body, four rows.
    const list = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(list).getAllByRole('button')).toHaveLength(4);
    expect(screen.queryByText('server-page-body')).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();

    // Level 2.
    fireEvent.click(within(list).getByRole('button', { name: /Token usage/ }));
    expect(await screen.findByText('token-usage-page-body')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings/token-usage');
    expect(screen.getByText('Token usage')).toBeTruthy(); // bar title
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull(); // no duplicate h1
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();

    // `‹ Settings` goes to the list, not to the opener.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('navigation', { name: 'Settings' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings');

    // And Back from the list goes to the opener.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('elsewhere at /agents/nora/activity')).toBeTruthy();
  });

  it('flags the Server row while an update is available, since the list has no footer button', async () => {
    api.fetchRuntimeUpgrade.mockResolvedValue(upgradeStatus('available'));
    renderAt('/settings');
    const list = await screen.findByRole('navigation', { name: 'Settings' });
    const server = within(list).getByRole('button', { name: /Server/ });
    await waitFor(() => expect(within(server).getByText('Update')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Update Anima/ })).toBeNull();
  });
});
