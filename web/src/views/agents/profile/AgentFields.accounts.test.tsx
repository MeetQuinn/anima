import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClaudeCodeAccountState } from '@shared/provider-accounts';
import { ClaudeAccountRow } from './AgentFields';

const accountState: ClaudeCodeAccountState = {
  accounts: [
    {
      account: 'primary@example.com',
      id: 'primary',
      label: 'Primary',
      profile: 'default',
      selected: true,
      status: 'available',
    },
    {
      account: 'secondary@example.com',
      id: 'secondary',
      label: 'Secondary',
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
  it('distinguishes machine-default inheritance from a per-agent account', async () => {
    const onRequestSave = vi.fn();
    const view = render(
      <ClaudeAccountRow accountState={accountState} onRequestSave={onRequestSave} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Machine default · Primary/ }));
    fireEvent.click(screen.getByRole('combobox'));
    const secondaryOption = await screen.findByRole('option', { name: /Secondary · secondary@example.com/ });
    fireEvent.pointerDown(secondaryOption);
    fireEvent.pointerUp(secondaryOption);
    fireEvent.click(secondaryOption);
    await waitFor(() => expect(screen.getByRole('combobox').textContent).toContain('Secondary'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRequestSave).toHaveBeenCalledWith('secondary');

    view.rerender(
      <ClaudeAccountRow
        accountId="secondary"
        accountState={accountState}
        onRequestSave={onRequestSave}
      />,
    );
    expect(screen.getByText('Secondary · secondary@example.com')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Secondary · secondary@example.com/ }));
    fireEvent.click(screen.getByRole('combobox'));
    const defaultOption = await screen.findByRole('option', { name: /Machine default · Primary/ });
    fireEvent.pointerDown(defaultOption);
    fireEvent.pointerUp(defaultOption);
    fireEvent.click(defaultOption);
    await waitFor(() => expect(screen.getByRole('combobox').textContent).toContain('Machine default'));
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
      name: /Secondary · secondary@example.com · Sign in required/,
    }));
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', {
      name: /Secondary · secondary@example.com · Sign in required/,
    });
    expect(option.getAttribute('aria-disabled')).toBe('true');
  });
});
