import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeUpgradeStatusResponse } from '@shared/runtime-upgrade';
import { queryKeys } from '@/lib/query-keys';
import { useRuntimeUpgradeAction } from './useRuntimeUpgradeAction';

const api = vi.hoisted(() => ({ apply: vi.fn(), status: vi.fn() }));
vi.mock('@/api/system', () => ({
  applyRuntimeUpgrade: api.apply,
  fetchRuntimeUpgrade: api.status,
  RuntimeUpgradeApplyError: class extends Error {},
}));
vi.mock('@/hooks/useAgentDirectory', () => ({ useAgents: () => ({ data: [] }) }));

const available: RuntimeUpgradeStatusResponse = {
  checkedAt: '2026-09-30T00:00:00Z', currentVersion: '0.1.33', latestOnTrack: '0.1.34',
  gate: { blockers: [], state: 'idle' }, operation: { status: 'idle' },
  releaseTrack: 'stable', state: 'available', updateAvailable: true,
};
const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  api.apply.mockReset().mockResolvedValue({ latestOnTrack: '0.1.34' });
  api.status.mockReset().mockResolvedValue(available);
  reload.mockReset();
  const originalWindow = window;
  vi.stubGlobal('window', new Proxy(originalWindow, {
    get(target, key) {
      if (key === 'location') return { reload };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.runtimeUpgrade(), available);
  const view = renderHook(useRuntimeUpgradeAction, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, client };
}

it('reloads after a successful upgrade even when no poll saw downtime', async () => {
  const view = mount();
  // The server may choose a newer target than the cached offer.
  api.apply.mockResolvedValue({ latestOnTrack: '0.1.35' });
  await act(async () => view.result.current.performUpgrade());
  api.status.mockResolvedValue({
    ...available, currentVersion: '0.1.35', state: 'current', updateAvailable: false,
    operation: { status: 'succeeded', targetVersion: '0.1.35' },
  });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(view.client.getQueryData(queryKeys.runtimeUpgrade())).toMatchObject({ currentVersion: '0.1.35' });
  view.unmount();
  view.client.clear();
});

it('does not treat an older successful operation as completion of a new apply', async () => {
  const view = mount();
  await act(async () => view.result.current.performUpgrade());
  api.status.mockResolvedValue({
    ...available, operation: { status: 'succeeded', targetVersion: '0.1.33' },
  });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(reload).not.toHaveBeenCalled();
  expect(view.result.current.phase).toBe('applying');
  view.unmount();
  view.client.clear();
});

it('refreshes a stale offer after apply is rejected', async () => {
  const view = mount();
  api.apply.mockRejectedValue(new Error('Unsupported Media Type'));
  api.status.mockResolvedValue({ ...available, currentVersion: '0.1.34', state: 'current', updateAvailable: false });
  await act(async () => view.result.current.performUpgrade());
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(view.result.current.status?.state).toBe('current');
  expect(view.result.current.applyError).toBe('Unsupported Media Type');
  view.unmount();
  view.client.clear();
});
