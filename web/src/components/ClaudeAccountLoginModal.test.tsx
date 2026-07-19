import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ClaudeAccountLoginModal from './ClaudeAccountLoginModal';

const api = vi.hoisted(() => ({
  cancelClaudeAccountLogin: vi.fn(),
  fetchClaudeAccountLogin: vi.fn(),
  startClaudeAccountLogin: vi.fn(),
  submitClaudeAccountLoginCode: vi.fn(),
}));

vi.mock('@/api/system', () => api);

const createdAt = '2026-07-19T13:00:00.000Z';
const id = '00000000-0000-4000-8000-000000000001';

describe('ClaudeAccountLoginModal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('keeps polling after a transient read error and reports success once', async () => {
    const onSucceeded = vi.fn();
    api.startClaudeAccountLogin.mockResolvedValueOnce({ createdAt, id, status: 'starting', updatedAt: createdAt });
    api.fetchClaudeAccountLogin
      .mockRejectedValueOnce(new Error('temporary disconnect'))
      .mockResolvedValueOnce({
        account: 'new@example.com',
        accountId: 'account-new',
        createdAt,
        id,
        status: 'succeeded',
        updatedAt: '2026-07-19T13:00:02.000Z',
      });

    render(<ClaudeAccountLoginModal onClose={() => {}} onSucceeded={onSucceeded} />);

    expect(document.activeElement).toBe(await screen.findByRole('dialog', { name: 'Add Claude account' }));
    expect(await screen.findByText('Could not refresh sign-in status. Retrying…')).toBeTruthy();
    expect(await screen.findByText('Signed in as new@example.com', {}, { timeout: 2_500 })).toBeTruthy();
    expect(screen.queryByText('Could not refresh sign-in status. Retrying…')).toBeNull();
    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(api.fetchClaudeAccountLogin).toHaveBeenCalledTimes(2);
  });

  it('submits a one-time code without retaining it in the rendered operation', async () => {
    api.startClaudeAccountLogin.mockResolvedValueOnce({
      createdAt,
      id,
      loginUrl: 'https://claude.com/cai/oauth/authorize?state=test',
      status: 'waiting',
      updatedAt: createdAt,
    });
    api.submitClaudeAccountLoginCode.mockResolvedValueOnce({
      createdAt,
      id,
      status: 'verifying',
      updatedAt: '2026-07-19T13:00:01.000Z',
    });

    render(<ClaudeAccountLoginModal onClose={() => {}} onSucceeded={() => {}} />);
    const input = await screen.findByLabelText('One-time code');
    fireEvent.change(input, { target: { value: 'one-time-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(api.submitClaudeAccountLoginCode).toHaveBeenCalledWith(id, 'one-time-secret'));
    expect(screen.queryByDisplayValue('one-time-secret')).toBeNull();
  });

  it('keeps the modal open when cancellation cannot reach the managed login process', async () => {
    const onClose = vi.fn();
    const operation = {
      createdAt,
      id,
      status: 'starting',
      updatedAt: createdAt,
    } as const;
    api.startClaudeAccountLogin.mockResolvedValueOnce(operation);
    api.fetchClaudeAccountLogin
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce({
        ...operation,
        status: 'cancelled',
        updatedAt: '2026-07-19T13:00:02.000Z',
      });
    api.cancelClaudeAccountLogin.mockRejectedValueOnce(new Error('temporary disconnect'));

    render(<ClaudeAccountLoginModal onClose={onClose} onSucceeded={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Could not cancel sign-in. Try again.')).toBeTruthy();
    await waitFor(() => expect(api.fetchClaudeAccountLogin).toHaveBeenCalledWith(id), {
      timeout: 2_000,
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(screen.getByText('Could not cancel sign-in. Try again.')).toBeTruthy();
    await waitFor(
      () => expect(screen.queryByText('Could not cancel sign-in. Try again.')).toBeNull(),
      { timeout: 2_000 },
    );
    expect(screen.getByRole('dialog', { name: 'Add Claude account' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
