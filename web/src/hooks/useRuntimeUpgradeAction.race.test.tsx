import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeUpgradeStatusResponse } from '@shared/runtime-upgrade';
import { queryKeys } from '@/lib/query-keys';
import { useRuntimeUpgradeAction } from './useRuntimeUpgradeAction';

// The in-progress tick writes the shared status key that useRuntimeUpgrade
// also polls. The query's poll calls fetchRuntimeUpgrade(context); the tick
// calls it with no arguments, so the mock can route the two separately.

const api = vi.hoisted(() => ({ apply: vi.fn(), poll: vi.fn(), tick: vi.fn() }));
vi.mock('@/api/system', () => ({
  applyRuntimeUpgrade: api.apply,
  fetchRuntimeUpgrade: (...args: unknown[]) => (args.length > 0 ? api.poll() : api.tick()),
  RuntimeUpgradeApplyError: class extends Error {},
}));
vi.mock('@/hooks/useAgentDirectory', () => ({ useAgents: () => ({ data: [] }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const available: RuntimeUpgradeStatusResponse = {
  checkedAt: '2026-09-30T00:00:00Z', currentVersion: '0.1.33', latestOnTrack: '0.1.34',
  gate: { blockers: [], state: 'idle' }, operation: { status: 'idle' },
  releaseTrack: 'stable', state: 'available', updateAvailable: true,
};
const running: RuntimeUpgradeStatusResponse = {
  ...available, operation: { status: 'running', targetVersion: '0.1.34' },
};
const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  api.apply.mockReset().mockResolvedValue({ latestOnTrack: '0.1.34' });
  api.poll.mockReset();
  api.tick.mockReset();
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

it('keeps the tick\'s status when a poll sent before the tick lands after it', async () => {
  const view = mount();
  await act(async () => view.result.current.performUpgrade());
  expect(view.result.current.phase).toBe('applying');

  // The shared query's poll leaves while the server still reports idle …
  const stale = deferred<RuntimeUpgradeStatusResponse>();
  api.poll.mockReturnValueOnce(stale.promise);
  const poll = view.client.refetchQueries({ queryKey: queryKeys.runtimeUpgrade(), exact: true });
  expect(api.poll).toHaveBeenCalledTimes(1);

  // … the tick reads the running operation and writes it …
  api.tick.mockResolvedValue(running);
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(api.tick).toHaveBeenCalledTimes(1);
  expect(view.client.getQueryData<RuntimeUpgradeStatusResponse>(queryKeys.runtimeUpgrade())?.operation.status)
    .toBe('running');

  // … then the poll's older answer arrives (before the next tick).
  await act(async () => {
    stale.resolve(available);
    await poll;
    // Flush TanStack's batched observer notify under fake timers (10ms is
    // far below the 1.5s tick and 3s poll; the call counts below confirm).
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(view.client.getQueryData<RuntimeUpgradeStatusResponse>(queryKeys.runtimeUpgrade())?.operation.status)
    .toBe('running');
  expect(view.result.current.status?.operation.status).toBe('running');
  // Positive control: no further tick or poll ran in between.
  expect(api.tick).toHaveBeenCalledTimes(1);
  expect(api.poll).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  view.unmount();
  view.client.clear();
});

it('neither writes nor reloads when the effect unmounts while its cancel is pending', async () => {
  const view = mount();
  await act(async () => view.result.current.performUpgrade());
  const gate = deferred<void>();
  const cancel = vi.spyOn(view.client, 'cancelQueries').mockImplementationOnce(() => gate.promise);
  // Without the guard this answer would both overwrite the cache and reload.
  api.tick.mockResolvedValue({
    ...running, currentVersion: '0.1.34', operation: { status: 'succeeded', targetVersion: '0.1.34' },
  });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(api.tick).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);

  view.unmount();
  await act(async () => {
    gate.resolve();
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(view.client.getQueryData(queryKeys.runtimeUpgrade())).toEqual(available);
  expect(reload).not.toHaveBeenCalled();
  view.client.clear();
});
