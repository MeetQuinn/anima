import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderCliStatusResponse } from '@shared/provider-cli';
import type { ProviderLoginStatusResponse } from '@shared/provider-login';
import { queryKeys } from '@/lib/query-keys';

import ProvidersPage from './ProvidersPage';

// A poll that left BEFORE an out-of-band write must not land on top of it.
// Every endpoint is mocked; nothing here reaches a server.

const cliApi = vi.hoisted(() => ({ check: vi.fn(), fetch: vi.fn() }));
const loginApi = vi.hoisted(() => ({ cancel: vi.fn(), fetch: vi.fn(), start: vi.fn() }));

vi.mock('@/api/system', () => ({
  applyProviderCliUpdate: vi.fn(),
  cancelProviderLogin: loginApi.cancel,
  checkProviderClis: cliApi.check,
  fetchProviderCliStatus: cliApi.fetch,
  fetchProviderContextLimits: vi.fn(async () => ({ providers: [] })),
  fetchProviderLogin: loginApi.fetch,
  fetchProviderRuntimeCommands: vi.fn(async () => ({ providers: [] })),
  fetchProviderUsage: vi.fn(async () => ({ providers: [] })),
  fetchProviderUsageProvider: vi.fn(),
  refreshProviderUsage: vi.fn(async () => ({ providers: [] })),
  saveProviderContextLimit: vi.fn(),
  saveProviderRuntimeCommand: vi.fn(),
  startProviderLogin: loginApi.start,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function cliStatus(installedVersion: string): ProviderCliStatusResponse {
  return {
    operation: { status: 'idle' },
    providers: [
      {
        agents: [],
        installedVersion,
        installSource: 'kimi-native',
        label: 'Kimi Code',
        latestVersion: '1.1.0',
        operation: { status: 'idle' },
        provider: 'kimi-cli',
        state: installedVersion === '1.1.0' ? 'current' : 'available',
        updateAvailable: installedVersion !== '1.1.0',
        updateMode: 'manual',
      },
    ],
    upgradeLocked: false,
  };
}

function login(status: 'idle' | 'running'): ProviderLoginStatusResponse {
  return {
    providers: [
      {
        checkedAt: '2026-07-13T04:00:00.000Z',
        command: 'mkimi',
        operation: status === 'running'
          ? {
            code: 'ABCD-EFGH1',
            expiresAt: '2026-07-13T04:15:00.000Z',
            mode: 'device',
            startedAt: '2026-07-13T04:00:00.000Z',
            status: 'running',
            url: 'https://example.test/device',
          }
          : { status: 'idle' },
        provider: 'kimi-cli',
        state: 'signed_out',
      },
    ],
  } as ProviderLoginStatusResponse;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProvidersPage />
    </QueryClientProvider>,
  );
  return client;
}

describe('ProvidersPage out-of-band writes vs in-flight polls', () => {
  beforeEach(() => {
    window.localStorage.clear();
    cliApi.check.mockReset();
    cliApi.fetch.mockReset().mockResolvedValue(cliStatus('1.0.0'));
    loginApi.cancel.mockReset();
    loginApi.fetch.mockReset().mockResolvedValue(login('idle'));
    loginApi.start.mockReset();
  });

  it('keeps the Refresh result for CLI status when an older poll lands after it', async () => {
    const client = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Kimi Code/i }));
    expect(await screen.findByText(/Update available/)).toBeTruthy();
    expect(cliApi.fetch).toHaveBeenCalledTimes(1);

    // The CLI-status poll leaves while the server still has 1.0.0 …
    const stale = deferred<ProviderCliStatusResponse>();
    cliApi.fetch.mockReturnValueOnce(stale.promise);
    const poll = client.refetchQueries({ queryKey: queryKeys.providerCliStatus(), exact: true });
    expect(cliApi.fetch).toHaveBeenCalledTimes(2);

    // … Refresh re-checks and sees 1.1.0 …
    cliApi.check.mockResolvedValueOnce(cliStatus('1.1.0'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));
    await waitFor(() => expect(client.getQueryData(queryKeys.providerCliStatus())).toEqual(cliStatus('1.1.0')));
    await waitFor(() => expect(screen.queryByText(/Update available/)).toBeNull());

    // … then the poll's older answer arrives.
    await act(async () => {
      stale.resolve(cliStatus('1.0.0'));
      await poll;
    });
    expect(client.getQueryData(queryKeys.providerCliStatus())).toEqual(cliStatus('1.1.0'));
    expect(screen.queryByText(/Update available/)).toBeNull();
    // Positive control: no other CLI-status fetch could have repaired it.
    expect(cliApi.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the cancelled sign-in when an older login poll lands after it', async () => {
    loginApi.fetch.mockReset().mockResolvedValueOnce(login('running'));
    const client = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Kimi Code/i }));
    expect(await screen.findByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();
    expect(loginApi.fetch).toHaveBeenCalledTimes(1);

    // The login poll leaves while the sign-in is still running …
    const stale = deferred<ProviderLoginStatusResponse>();
    loginApi.fetch.mockReturnValueOnce(stale.promise);
    const poll = client.refetchQueries({ queryKey: queryKeys.providerLogin(), exact: true });
    expect(loginApi.fetch).toHaveBeenCalledTimes(2);

    // … the user cancels and the server confirms …
    loginApi.cancel.mockResolvedValueOnce(login('idle'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await waitFor(() => expect(client.getQueryData(queryKeys.providerLogin())).toEqual(login('idle')));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull());

    // … then the poll's older "running" answer arrives.
    await act(async () => {
      stale.resolve(login('running'));
      await poll;
    });
    expect(client.getQueryData(queryKeys.providerLogin())).toEqual(login('idle'));
    expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull();
    // Positive control: the 2s running-poll did not fire in between.
    expect(loginApi.fetch).toHaveBeenCalledTimes(2);
  });
});
