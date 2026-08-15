import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { providerCatalog } from '@shared/provider-catalog';

import { RuntimeRow } from './RuntimeField';

// Behavioral pins for the Runtime modal (task #183), added at Milo's gate on
// PR #676. Four branches were exercised only through a throwaway zero-fetch
// harness; this file makes them durable, plus the regression his review
// found: a pending save left every dismissal path (Escape, header X,
// backdrop) ungated, so the editor unmounted mid-flight and a rejection had
// nothing to render into.
//
// The Base UI Select is mocked with plain buttons. That is deliberate and
// scoped: agent-driven synthetic input cannot operate the real popup (known
// automation limitation, PR body), and what these cases pin is the DRAFT and
// PAYLOAD logic behind `onValueChange` — kind change resetting command/args
// drafts, and the diff builder sending only typed values — not the dropdown's
// internals, which are third-party and exercised by real input in production.
//
// NOTE: web vitest is not wired into CI yet (issue #344) - run locally.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const Ctx = React.createContext<(value: string | null) => void>(() => {});
  return {
    Select: ({
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string | null) => void;
      children: React.ReactNode;
    }) => <Ctx.Provider value={onValueChange}>{children}</Ctx.Provider>,
    SelectTrigger: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({
      value,
      children,
      disabled,
    }: {
      value: string;
      children: React.ReactNode;
      disabled?: boolean;
    }) => {
      const onValueChange = React.useContext(Ctx);
      return (
        <button type="button" disabled={disabled} onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

const providerOptions = providerCatalog();

function openModal(provider: Record<string, unknown>, onCommit: (...args: never[]) => Promise<void>) {
  render(
    <RuntimeRow
      provider={provider as never}
      providerOptions={providerOptions}
      providerAvailability={null}
      isActive
      onCommit={onCommit as never}
    />,
  );
  // The whole Runtime row is the opener; its accessible name starts with the
  // provider line. Regex keeps it distinct from the mocked select items
  // inside the dialog, whose names are the bare kind labels.
  fireEvent.click(screen.getByRole('button', { name: /·/ }));
  const dialog = screen.getByRole('dialog', { name: 'Runtime' });
  return within(dialog);
}

function confirmDialog() {
  return screen.getByRole('dialog', { name: 'Save and apply when idle?' });
}

describe('Runtime modal — save/dismissal contract', () => {
  it('env-only save skips the restart confirm, and while pending no dismissal path closes the editor; a rejection renders inline with drafts intact', async () => {
    let rejectCommit!: (error: Error) => void;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCommit = reject;
        }),
    );
    const dialog = openModal(
      { kind: 'kimi-cli', model: 'kimi-k3', env: { MOONSHOT_API_KEY: 'old' } },
      onCommit,
    );

    // Change only an env value → launch-unaffecting → commit goes straight
    // through with envOnly: true and the ConfirmRestartModal never mounts.
    fireEvent.change(dialog.getByPlaceholderText('unchanged'), { target: { value: 'sk-new' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(onCommit).toHaveBeenCalledWith({ env: { MOONSHOT_API_KEY: 'sk-new' } }, { envOnly: true });
    expect(screen.queryByRole('dialog', { name: 'Save and apply when idle?' })).toBeNull();

    // THE REGRESSION (Milo, PR #676 gate): with the save pending, Escape,
    // the backdrop, and the header X must all be inert — unmounting here
    // would drop the drafts and leave the rejection nowhere to render.
    const editor = screen.getByRole('dialog', { name: 'Runtime' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Runtime' })).toBe(editor);
    fireEvent.click(editor.parentElement!);
    expect(screen.getByRole('dialog', { name: 'Runtime' })).toBe(editor);
    expect((dialog.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);

    // 409 path: the rejection lands inline, the editor stays mounted, the
    // typed draft survives.
    rejectCommit(new Error('agent runtime command not found on this machine (409)'));
    await waitFor(() => expect(dialog.getByText(/runtime command not found/)).toBeTruthy());
    expect(screen.getByRole('dialog', { name: 'Runtime' })).toBe(editor);
    expect((dialog.getByPlaceholderText('unchanged') as HTMLInputElement).value).toBe('sk-new');

    // Settled → dismissal works again.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('sends an atomic diff: a command-only edit reaches onCommit as exactly { runtimeCommand } after the restart confirm', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal(
      {
        kind: 'claude-code',
        model: 'fable',
        runtimeCommand: '/opt/homebrew/bin/claude-canary',
        runtimeArgs: ['--chrome', '--profile'],
        env: { FOO: '1' },
      },
      onCommit,
    );

    fireEvent.change(dialog.getByDisplayValue('/opt/homebrew/bin/claude-canary'), {
      target: { value: '/opt/homebrew/bin/claude-stable' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    // Launch-affecting → the nested confirm mounts on top; committing happens
    // from ITS Save, not the editor's.
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));

    // Exactly one key: unchanged kind/model/effort, args, and env are all
    // omitted, so the server touches nothing the operator did not edit.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      { runtimeCommand: '/opt/homebrew/bin/claude-stable' },
      { envOnly: false },
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('kind change clears the old provider\'s command/args drafts and sends neither unless retyped', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal(
      {
        kind: 'claude-code',
        model: 'fable',
        runtimeCommand: '/opt/homebrew/bin/claude-canary',
        runtimeArgs: ['--chrome'],
      },
      onCommit,
    );

    // Switch kind via the (mocked) select. The command draft written for the
    // old provider's CLI must not survive into the new kind.
    fireEvent.click(dialog.getByRole('button', { name: 'Codex CLI' }));
    expect(dialog.queryByDisplayValue('/opt/homebrew/bin/claude-canary')).toBeNull();
    expect(dialog.getByText(/command override below was cleared/)).toBeTruthy();

    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [update, opts] = onCommit.mock.calls[0] as unknown as [Record<string, unknown>, { envOnly: boolean }];
    expect(update).toMatchObject({ kind: 'codex-cli', model: 'gpt-5.6-sol' });
    // The pin: no override keys ride along on a kind change the operator
    // typed nothing for — the server would otherwise persist the old kind's
    // command against the new kind's binary.
    expect(update).not.toHaveProperty('runtimeCommand');
    expect(update).not.toHaveProperty('runtimeArgs');
    expect(update).not.toHaveProperty('env');
    expect(opts).toEqual({ envOnly: false });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });
});
