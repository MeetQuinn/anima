import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
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
  it('keeps Tab inside the dialog and hands focus back to what opened it', async () => {
    // Adopting `useDialogFocus` (batch B-flat) adds containment and restore here.
    // The landing spot deliberately stays the dialog container: at open the only
    // control is Cancel, and the code field only appears once the provider
    // answers, so focus is not put on "abandon the sign-in you just started".
    api.startClaudeAccountLogin.mockResolvedValueOnce({
      createdAt,
      id,
      loginUrl: 'https://claude.com/cai/oauth/authorize?state=test',
      status: 'waiting',
      updatedAt: createdAt,
    });
    api.fetchClaudeAccountLogin.mockResolvedValue({
      createdAt,
      id,
      status: 'waiting',
      updatedAt: createdAt,
    });

    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button">Add account</button>
          {open && (
            <ClaudeAccountLoginModal onClose={() => setOpen(false)} onSucceeded={() => {}} />
          )}
        </>
      );
    }

    const opener = document.createElement('button');
    opener.textContent = 'Providers';
    document.body.append(opener);
    opener.focus();

    render(<Host />);
    const dialog = await screen.findByRole('dialog', { name: 'Add Claude account' });
    expect(document.activeElement).toBe(dialog);

    // A Tab from the container is a boundary: it moves inside instead of leaving
    // for the panel behind the dialog.
    const forward = fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);

    // Closing goes through an async cancel of the managed login, so the unmount
    // lands outside the act() around the click and React flushes the effect
    // cleanup that restores focus in a later task. Waiting on the DOM being gone
    // is therefore NOT enough to wait on the restore — measured: asserting it
    // synchronously here passes alone and fails under load.
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });
});
