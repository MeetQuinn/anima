import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderUsageRow } from '@shared/provider-usage';
import UsagePanel from './UsagePanel';

const api = vi.hoisted(() => ({
  cancelClaudeAccountLogin: vi.fn(),
  fetchClaudeAccountLogin: vi.fn(),
  removeClaudeAccount: vi.fn(),
  refreshProviderUsage: vi.fn(),
  selectClaudeAccount: vi.fn(),
  startClaudeAccountLogin: vi.fn(),
  submitClaudeAccountLoginCode: vi.fn(),
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
      windows: [
        { label: '5h', remainingPercent: 64, resetsAt: '2030-01-01T05:00:00.000Z' },
        { label: 'Weekly', remainingPercent: 41, resetsAt: '2030-01-03T05:00:00.000Z' },
      ],
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
      windows: [
        { label: '5h', remainingPercent: 88, resetsAt: '2030-01-01T05:00:00.000Z' },
        { label: 'Weekly', remainingPercent: 62, resetsAt: '2030-01-03T05:00:00.000Z' },
      ],
    },
  ] as ProviderUsageRow[],
}));

const defaultAccountState = structuredClone(accountState.value);
const defaultUsageRows = structuredClone(usageRows.value);

vi.mock('@/api/system', () => ({
  applyProviderCliUpdate: vi.fn(),
  cancelClaudeAccountLogin: api.cancelClaudeAccountLogin,
  checkProviderClis: vi.fn(),
  fetchClaudeAccountLogin: api.fetchClaudeAccountLogin,
  fetchProviderContextLimits: vi.fn(async () => ({ providers: [] })),
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
  removeClaudeAccount: api.removeClaudeAccount,
  refreshProviderUsage: api.refreshProviderUsage,
  selectClaudeAccount: api.selectClaudeAccount,
  saveProviderContextLimit: vi.fn(),
  startClaudeAccountLogin: api.startClaudeAccountLogin,
  submitClaudeAccountLoginCode: api.submitClaudeAccountLoginCode,
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UsagePanel onClose={() => {}} />
    </QueryClientProvider>,
  );
}

async function expandClaude(): Promise<void> {
  // Cold start collapses every provider; open Claude to reach account rows.
  const toggle = await screen.findByRole('button', { name: /Claude Code/i });
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(toggle);
  }
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
}

describe('UsagePanel Claude account selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    accountState.value = structuredClone(defaultAccountState);
    usageRows.value = structuredClone(defaultUsageRows);
    api.refreshProviderUsage.mockResolvedValue({ providers: usageRows.value });
  });

  it('shows every account with its own meters and confirms a global resumable switch', async () => {
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
    await expandClaude();

    // Every account renders as a full card; only the active one carries the marker.
    expect(await screen.findByText('secondary@example.com')).toBeTruthy();
    expect(screen.getByText('primary@example.com')).toBeTruthy();
    expect(screen.getAllByText('Active')).toHaveLength(1);
    expect(screen.getByText('88%')).toBeTruthy();
    // The #159 fix: every window row — Weekly included, other accounts included —
    // shows its own percent AND reset time. 2 accounts × 2 windows = 4 resets.
    expect(screen.getByText('64%')).toBeTruthy();
    expect(screen.getAllByText('Weekly')).toHaveLength(2);
    expect(screen.getAllByText(/^resets /)).toHaveLength(4);

    // Use is inline on the non-active account row.
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    expect(await screen.findByText('Switch to primary@example.com?')).toBeTruthy();
    expect(screen.getByText(/Active Claude turns are requeued to resume after the account reload/)).toBeTruthy();
    expect(screen.getByText(/sessions, MCP servers, and shared state stay in place/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));

    await waitFor(() => expect(api.selectClaudeAccount).toHaveBeenCalledWith('primary'));
    expect(api.refreshProviderUsage).toHaveBeenCalledOnce();
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
    expect(screen.getByText(/Active turns on those agents are requeued to resume after reload/)).toBeTruthy();
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    fireEvent.click(retryButtons[retryButtons.length - 1]!);

    await waitFor(() => expect(api.selectClaudeAccount).toHaveBeenCalledWith('secondary'));
  });

  it('offers the same safe retry when a switch is still waiting for agent outcomes', async () => {
    accountState.value.status = 'switching';
    accountState.value.errorAgentIds = [];
    accountState.value.pendingAgentIds = ['quill', 'tide'];
    api.selectClaudeAccount.mockResolvedValueOnce({
      ...accountState.value,
      pendingAgentIds: [],
      status: 'active',
    });
    renderPanel();

    expect(await screen.findByText('Switching account · waiting for 2 agents')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Retry secondary@example.com?')).toBeTruthy();
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    fireEvent.click(retryButtons[retryButtons.length - 1]!);

    await waitFor(() => expect(api.selectClaudeAccount).toHaveBeenCalledWith('secondary'));
  });

  it('keeps account removal in an overflow menu and requires destructive confirmation', async () => {
    accountState.value.activeAccountId = 'primary';
    accountState.value.accounts[0]!.selected = true;
    accountState.value.accounts[1]!.selected = false;
    usageRows.value = usageRows.value.map((row) => ({
      ...row,
      active: row.accountId === 'primary' ? true : undefined,
    }));
    api.removeClaudeAccount.mockResolvedValueOnce({
      accounts: [accountState.value.accounts[0]!],
      activeAccountId: 'primary',
      errorAgentIds: [],
      pendingAgentIds: [],
      provider: 'claude-code',
      status: 'active',
    });
    api.refreshProviderUsage.mockResolvedValueOnce({ providers: [usageRows.value[0]!] });
    renderPanel();
    await expandClaude();

    fireEvent.click(screen.getByRole('button', { name: 'More actions for primary@example.com' }));
    expect(
      screen.getByRole('menuitem', { name: /Remove account.*Primary account cannot be removed/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for primary@example.com' }));

    fireEvent.click(screen.getByRole('button', { name: 'More actions for secondary@example.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove account' }));
    expect(await screen.findByText('Remove secondary@example.com?')).toBeTruthy();
    expect(screen.getByText(/removes the local Claude sign-in and archives its isolated profile/)).toBeTruthy();
    expect(screen.getByText(/Shared Claude projects and history stay in place/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }));
    await waitFor(() => expect(api.removeClaudeAccount).toHaveBeenCalledWith('secondary'));
    expect(api.refreshProviderUsage).toHaveBeenCalledOnce();
  });

  it('offers reauthentication for an expired account without hiding the healthy one', async () => {
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
    await expandClaude();

    expect(await screen.findByText('Auth expired')).toBeTruthy();
    expect(screen.getByText('secondary@example.com')).toBeTruthy();
    expect(screen.getByText('88%')).toBeTruthy();

    api.startClaudeAccountLogin.mockResolvedValueOnce({
      accountId: 'primary',
      createdAt: '2026-07-19T13:00:00.000Z',
      error: 'Claude sign-in did not complete. Try again.',
      id: '00000000-0000-4000-8000-000000000001',
      status: 'failed',
      updatedAt: '2026-07-19T13:00:00.000Z',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in to primary@example.com' })).toBeTruthy();
    await waitFor(() => expect(api.startClaudeAccountLogin).toHaveBeenCalledWith({ accountId: 'primary' }));
  });
});
