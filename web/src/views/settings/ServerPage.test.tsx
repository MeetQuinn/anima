import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/query-keys';
import ServerPage from './ServerPage';

const api = vi.hoisted(() => ({ info: vi.fn(), upgrade: vi.fn() }));
vi.mock('@/api/system', () => ({
  fetchServerInfo: api.info, fetchRuntimeUpgrade: api.upgrade,
  pingHealth: vi.fn(async () => true),
  checkRuntimeUpgrade: vi.fn(), applyRuntimeUpgrade: vi.fn(),
  RuntimeUpgradeApplyError: class extends Error {},
}));
vi.mock('@/components/RestartButton', () => ({ default: () => null }));
vi.mock('@/hooks/useAgentDirectory', () => ({ useAgents: () => ({ data: [] }) }));
afterEach(() => vi.clearAllMocks());

function status(version: string, state: 'current' | 'available') {
  return {
    checkedAt: '2026-09-30T00:00:00Z', currentVersion: version, latestOnTrack: '0.1.34',
    gate: { blockers: [], state: 'idle' }, operation: { status: 'idle' },
    releaseTrack: 'stable', state, updateAvailable: state === 'available',
  };
}
function info(version: string) {
  return { version, track: 'stable', startedAt: '2026-09-30T00:00:00Z', animaHome: '/tmp/anima', uptimeSeconds: 1 };
}

it('refreshes a cached old upgrade card on entry and when the server version changes', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.runtimeUpgrade(), status('0.1.32', 'available'));
  api.info.mockResolvedValue(info('0.1.33'));
  api.upgrade.mockResolvedValue(status('0.1.33', 'current'));
  const view = render(<QueryClientProvider client={client}><ServerPage /></QueryClientProvider>);
  await waitFor(() => expect(screen.queryByText('Upgrade & restart')).toBeNull());
  expect(await screen.findByText('Up to date')).toBeTruthy();
  expect(api.upgrade).toHaveBeenCalledTimes(1);

  client.setQueryData(queryKeys.runtimeUpgrade(), status('0.1.33', 'available'));
  api.upgrade.mockResolvedValue(status('0.1.34', 'current'));
  await act(async () => { client.setQueryData(queryKeys.serverInfo(), info('0.1.34')); });
  await waitFor(() => expect(client.getQueryData(queryKeys.runtimeUpgrade())).toMatchObject({ currentVersion: '0.1.34' }));
  expect(api.upgrade).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Upgrade & restart')).toBeNull();
  view.unmount();
  client.clear();
});
