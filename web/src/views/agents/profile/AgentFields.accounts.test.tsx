import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClaudeCodeAccountState } from '@shared/provider-accounts';
import { ClaudeAccountRow } from './AgentFields';

const accountState: ClaudeCodeAccountState = {
  accounts: [
    {
      account: 'guoqiang@lunapark.com',
      id: 'primary',
      label: 'Primary',
      plan: 'Claude Max',
      profile: 'default',
      selected: true,
      status: 'available',
    },
    {
      account: 'lemon.yang.y@gmail.com',
      id: 'secondary',
      label: 'Secondary',
      plan: 'Claude Max',
      profile: 'isolated',
      selected: false,
      status: 'available',
    },
    {
      account: 'guoqiang@lunapark.com',
      id: 'account-2',
      label: 'Account 2',
      plan: 'Claude Team',
      profile: 'isolated',
      selected: false,
      status: 'available',
    },
  ],
  activeAccountId: 'primary',
  errorAgentIds: [],
  pendingAgentIds: [],
  provider: 'claude-code',
  status: 'active',
};

describe('ClaudeAccountRow', () => {
  it('marks unpinned inheritance as Default while keeping email · plan identity', async () => {
    const onRequestSave = vi.fn();
    const view = render(
      <ClaudeAccountRow accountState={accountState} onRequestSave={onRequestSave} />,
    );

    expect(screen.getByText('guoqiang@lunapark.com · Claude Max')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.queryByText(/Machine default|Primary|Secondary|Account 2/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /guoqiang@lunapark.com · Claude Max/ }));
    fireEvent.click(screen.getByRole('combobox'));
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options.map((option) => option.textContent)).toEqual([
      'guoqiang@lunapark.com · Claude Max · Default',
      'lemon.yang.y@gmail.com · Claude Max',
      'guoqiang@lunapark.com · Claude Team',
    ]);
    const secondaryOption = screen.getByRole('option', { name: 'lemon.yang.y@gmail.com · Claude Max' });
    fireEvent.pointerDown(secondaryOption);
    fireEvent.pointerUp(secondaryOption);
    fireEvent.click(secondaryOption);
    await waitFor(() => expect(screen.getByRole('combobox').textContent).toContain('lemon.yang.y@gmail.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRequestSave).toHaveBeenCalledWith('secondary');

    view.rerender(
      <ClaudeAccountRow
        accountId="secondary"
        accountState={accountState}
        onRequestSave={onRequestSave}
      />,
    );
    expect(screen.getByText('lemon.yang.y@gmail.com · Claude Max')).toBeTruthy();
    expect(screen.queryByText('Default')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /lemon.yang.y@gmail.com · Claude Max/ }));
    fireEvent.click(screen.getByRole('combobox'));
    const defaultOption = await screen.findByRole('option', {
      name: 'guoqiang@lunapark.com · Claude Max · Default',
    });
    fireEvent.pointerDown(defaultOption);
    fireEvent.pointerUp(defaultOption);
    fireEvent.click(defaultOption);
    await waitFor(() => expect(screen.getByRole('combobox').textContent).toContain('Default'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRequestSave).toHaveBeenLastCalledWith(null);
  });

  it('shows but cannot select an unauthenticated account', async () => {
    const signedOut: ClaudeCodeAccountState = {
      ...accountState,
      accounts: accountState.accounts.map((account) => (
        account.id === 'secondary' ? { ...account, status: 'not_configured' as const } : account
      )),
    };
    render(
      <ClaudeAccountRow
        accountId="secondary"
        accountState={signedOut}
        onRequestSave={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', {
      name: /lemon.yang.y@gmail.com · Claude Max · Sign in required/,
    }));
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', {
      name: /lemon.yang.y@gmail.com · Claude Max · Sign in required/,
    });
    expect(option.getAttribute('aria-disabled')).toBe('true');
  });

  it('can restore inheritance when the pinned account is also the machine default', async () => {
    const onRequestSave = vi.fn();
    render(
      <ClaudeAccountRow
        accountId="primary"
        accountState={accountState}
        onRequestSave={onRequestSave}
      />,
    );

    // Pinned even when identity matches Providers-active — no Default mark.
    expect(screen.getByText('guoqiang@lunapark.com · Claude Max')).toBeTruthy();
    expect(screen.queryByText('Default')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /guoqiang@lunapark.com · Claude Max/ }));
    fireEvent.click(screen.getByRole('combobox'));
    const defaultOption = await screen.findByRole('option', {
      name: 'guoqiang@lunapark.com · Claude Max · Default',
    });
    fireEvent.pointerDown(defaultOption);
    fireEvent.pointerUp(defaultOption);
    fireEvent.click(defaultOption);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRequestSave).toHaveBeenCalledWith(null);
  });

  it('numbers only otherwise-identical identity and plan rows', async () => {
    const duplicates: ClaudeCodeAccountState = {
      ...accountState,
      accounts: accountState.accounts.slice(0, 2).map((account) => ({
        ...account,
        account: 'guoqiang@lunapark.com',
        plan: undefined,
      })),
    };
    render(<ClaudeAccountRow accountState={duplicates} onRequestSave={() => {}} />);

    expect(screen.getByText('Default')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /guoqiang@lunapark.com · Plan unknown · 1/ }));
    fireEvent.click(screen.getByRole('combobox'));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'guoqiang@lunapark.com · Plan unknown · 1 · Default',
      'guoqiang@lunapark.com · Plan unknown · 2',
    ]);
  });

  it('does not expose internal labels for profiles without an account identity', async () => {
    const unsigned: ClaudeCodeAccountState = {
      ...accountState,
      accounts: [
        accountState.accounts[0]!,
        {
          id: 'secondary',
          label: 'Secondary',
          profile: 'isolated',
          selected: false,
          status: 'not_configured',
        },
      ],
    };
    render(<ClaudeAccountRow accountState={unsigned} onRequestSave={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /guoqiang@lunapark.com · Claude Max/ }));
    fireEvent.click(screen.getByRole('combobox'));
    expect(await screen.findAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', {
      name: 'guoqiang@lunapark.com · Claude Max · Default',
    })).toBeTruthy();
    expect(screen.queryByText(/Secondary|Machine default|Primary|Account 2/)).toBeNull();
  });
});
