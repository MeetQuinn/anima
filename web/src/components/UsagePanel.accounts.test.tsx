import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import UsagePanel from './UsagePanel';

const api = vi.hoisted(() => ({
  selectClaudeAccount: vi.fn(),
}));

const accountState = vi.hoisted(() => ({
  value: {
    accounts: [
      {
        account: 'primary@example.com',
        id: 'primary',
        label: 'Primary',
        profile: 'default' as const,
        selected: false,
        status: 'available' as const,
      },
      {
        account: 'secondary@example.com',
        id: 'secondary',
        label: 'Secondary',
        profile: 'isolated' as const,
        selected: true,
        status: 'available' as const,
      },
    ],
    activeAccountId: 'secondary',
    errorAgentIds: [] as string[],
    pendingAgentIds: [] as string[],
    provider: 'claude-code' as const,
    status: 'active' as 'active' | 'error' | 'switching',
  },
}));

vi.mock('@/api/system', () => ({
  applyProviderCliUpdate: vi.fn(),
  checkProviderClis: vi.fn(),
  fetchProviderAccounts: vi.fn(async () => ({
    providers: [accountState.value],
  })),
  fetchProviderCliStatus: vi.fn(async () => ({
    operation: { status: 'idle' as const },
    providers: [
      {
        agents: [],
        installSource: 'native' as const,
        installedVersion: '2.1.0',
        label: 'Claude Code',
        operation: { status: 'idle' as const },
        provider: 'claude-code' as const,
        state: 'ready' as const,
        updateAvailable: false,
        updateMode: 'native' as const,
      },
    ],
    upgradeLocked: false,
  })),
  fetchProviderUsage: vi.fn(async () => ({
    providers: [
      {
        account: 'secondary@example.com',
        checkedAt: '2026-07-17T17:00:00.000Z',
        extras: [],
        label: 'Claude Code',
        provider: 'claude-code' as const,
        source: 'private-api' as const,
        status: 'available' as const,
        windows: [],
      },
    ],
  })),
  fetchProviderUsageProvider: vi.fn(),
  selectClaudeAccount: api.selectClaudeAccount,
}));

describe('UsagePanel Claude account selection', () => {
  it('uses the platform account state and confirms a global session-preserving switch', async () => {
    accountState.value.status = 'active';
    accountState.value.errorAgentIds = [];
    api.selectClaudeAccount.mockResolvedValueOnce({
      accounts: [],
      activeAccountId: 'primary',
      errorAgentIds: [],
      pendingAgentIds: [],
      provider: 'claude-code',
      status: 'active',
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <UsagePanel onClose={() => {}} />
      </QueryClientProvider>,
    );

    const accountSelect = await screen.findByRole('combobox', { name: 'Claude account' });
    expect((accountSelect as HTMLSelectElement).value).toBe('secondary');

    fireEvent.change(accountSelect, { target: { value: 'primary' } });
    expect(await screen.findByText('Switch to primary@example.com?')).toBeTruthy();
    expect(screen.getByText(/Current Claude turns continue uninterrupted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));

    await waitFor(() => expect(api.selectClaudeAccount).toHaveBeenCalledWith('primary'));
  });

  it('retries failed agents without asking the operator to select another account', async () => {
    accountState.value.status = 'error';
    accountState.value.errorAgentIds = ['iris'];
    api.selectClaudeAccount.mockResolvedValueOnce({
      ...accountState.value,
      errorAgentIds: [],
      pendingAgentIds: ['iris'],
      status: 'switching',
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <UsagePanel onClose={() => {}} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Account switch failed: iris')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Retry secondary@example.com?')).toBeTruthy();
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    fireEvent.click(retryButtons[retryButtons.length - 1]!);

    await waitFor(() => expect(api.selectClaudeAccount).toHaveBeenCalledWith('secondary'));
  });
});
