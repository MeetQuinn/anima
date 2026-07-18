import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderUsageRow } from '@shared/provider-usage';
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

const usageRows = vi.hoisted(() => ({
  value: [
    {
      account: 'primary@example.com',
      accountId: 'primary',
      checkedAt: '2026-07-17T17:00:00.000Z',
      extras: [],
      label: 'Claude Code',
      provider: 'claude-code',
      source: 'private-api',
      status: 'available',
      windows: [{ label: '5h', remainingPercent: 64 }],
    },
    {
      account: 'secondary@example.com',
      accountId: 'secondary',
      active: true,
      checkedAt: '2026-07-17T17:00:00.000Z',
      extras: [],
      label: 'Claude Code',
      provider: 'claude-code',
      source: 'private-api',
      status: 'available',
      windows: [{ label: '5h', remainingPercent: 88 }],
    },
  ] as ProviderUsageRow[],
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
    providers: usageRows.value,
  })),
  fetchProviderUsageProvider: vi.fn(),
  selectClaudeAccount: api.selectClaudeAccount,
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UsagePanel onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('UsagePanel Claude account selection', () => {
  it('shows every account with its own meters and confirms a global session-preserving switch', async () => {
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
    renderPanel();

    // Both accounts render with their own numbers; the active one is badged.
    expect(await screen.findByText('secondary@example.com')).toBeTruthy();
    expect(screen.getByText('primary@example.com')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('88%')).toBeTruthy();
    expect(screen.getByText('64%')).toBeTruthy();

    // Switching is a deliberate button on the non-active account's block.
    fireEvent.click(screen.getByRole('button', { name: 'Set active' }));
    expect(await screen.findByText('Switch to primary@example.com?')).toBeTruthy();
    expect(screen.getByText(/Current Claude turns continue uninterrupted/)).toBeTruthy();
    expect(screen.getByText(/sessions, MCP servers, and shared state stay in place/)).toBeTruthy();
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
    renderPanel();

    expect(await screen.findByText('Account switch failed: iris')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Retry secondary@example.com?')).toBeTruthy();
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    fireEvent.click(retryButtons[retryButtons.length - 1]!);

    await waitFor(() => expect(api.selectClaudeAccount).toHaveBeenCalledWith('secondary'));
  });

  it('dims an expired account without hiding the healthy one', async () => {
    accountState.value.status = 'active';
    accountState.value.errorAgentIds = [];
    usageRows.value = [
      {
        account: 'primary@example.com',
        accountId: 'primary',
        checkedAt: '2026-07-17T17:00:00.000Z',
        error: { message: 'Provider usage request was rejected (401)', type: 'unauthorized' },
        extras: [],
        label: 'Claude Code',
        provider: 'claude-code',
        source: 'private-api',
        status: 'unavailable',
        windows: [],
      },
      usageRows.value[1]!,
    ];
    renderPanel();

    expect(await screen.findByText('Auth expired')).toBeTruthy();
    expect(screen.getByText('secondary@example.com')).toBeTruthy();
    expect(screen.getByText('88%')).toBeTruthy();
  });
});
