import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeUpgradeStatusResponse } from '@shared/runtime-upgrade';
import { queryKeys } from '@/lib/query-keys';
import { queryClient } from '@/query-client';
import RuntimeUpgradeRow from './RuntimeUpgrade';

// A poll that left BEFORE an out-of-band write must not land on top of it.
// The row writes through the app singleton, so the test mounts that client.

const api = vi.hoisted(() => ({ apply: vi.fn(), check: vi.fn(), status: vi.fn() }));
vi.mock('@/api/system', () => ({
  applyRuntimeUpgrade: api.apply,
  checkRuntimeUpgrade: api.check,
  fetchRuntimeUpgrade: api.status,
  RuntimeUpgradeApplyError: class extends Error {},
}));
vi.mock('@/hooks/useAgentDirectory', () => ({ useAgents: () => ({ data: [] }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const current: RuntimeUpgradeStatusResponse = {
  checkedAt: '2026-09-30T00:00:00Z', currentVersion: '0.1.33', latestOnTrack: '0.1.33',
  gate: { blockers: [], state: 'idle' }, operation: { status: 'idle' },
  releaseTrack: 'stable', state: 'current', updateAvailable: false,
};
const available: RuntimeUpgradeStatusResponse = {
  ...current, checkedAt: '2026-09-30T00:05:00Z', latestOnTrack: '0.1.34',
  state: 'available', updateAvailable: true,
};

afterEach(() => {
  queryClient.clear();
  api.check.mockReset();
  api.status.mockReset();
});

it('keeps the "Check for updates" result when an older poll lands after it', async () => {
  queryClient.setQueryData(queryKeys.runtimeUpgrade(), current);
  render(
    <QueryClientProvider client={queryClient}>
      <RuntimeUpgradeRow />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/Up to date/)).toBeTruthy();

  // The poll leaves while the server still says "current" …
  const stale = deferred<RuntimeUpgradeStatusResponse>();
  api.status.mockReturnValueOnce(stale.promise);
  const poll = queryClient.refetchQueries({ queryKey: queryKeys.runtimeUpgrade(), exact: true });
  expect(api.status).toHaveBeenCalledTimes(1);

  // … the user's check sees the new release …
  api.check.mockResolvedValueOnce(available);
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await waitFor(() => expect(queryClient.getQueryData(queryKeys.runtimeUpgrade())).toEqual(available));
  await waitFor(() => expect(screen.queryByText(/Up to date/)).toBeNull());

  // … then the poll's older answer arrives.
  await act(async () => {
    stale.resolve(current);
    await poll;
  });
  expect(queryClient.getQueryData(queryKeys.runtimeUpgrade())).toEqual(available);
  expect(screen.queryByText(/Up to date/)).toBeNull();
  // Positive control: no other fetch could have repaired the cache.
  expect(api.status).toHaveBeenCalledTimes(1);
});
