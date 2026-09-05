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
// Runs in CI (`pnpm --dir web test`) and locally the same way.
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

function openModal(
  provider: Record<string, unknown>,
  onCommit: (...args: never[]) => Promise<void>,
) {
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
    expect(onCommit).toHaveBeenCalledWith(
      { env: { MOONSHOT_API_KEY: 'sk-new' } },
      { envOnly: true },
    );
    expect(screen.queryByRole('dialog', { name: 'Save and apply when idle?' })).toBeNull();

    // THE REGRESSION (Milo, PR #676 gate): with the save pending, Escape,
    // the backdrop, and the header X must all be inert — unmounting here
    // would drop the drafts and leave the rejection nowhere to render.
    const editor = screen.getByRole('dialog', { name: 'Runtime' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Runtime' })).toBe(editor);
    fireEvent.click(editor.parentElement!);
    expect(screen.getByRole('dialog', { name: 'Runtime' })).toBe(editor);
    expect((dialog.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // 409 path: the rejection lands inline, the editor stays mounted, the
    // typed draft survives.
    rejectCommit(new Error('agent runtime command not found on this machine (409)'));
    await waitFor(() => expect(dialog.getByText(/runtime command not found/)).toBeTruthy());
    expect(screen.getByRole('dialog', { name: 'Runtime' })).toBe(editor);
    expect((dialog.getByPlaceholderText('unchanged') as HTMLInputElement).value).toBe('sk-new');

    // Settled → dismissal works again. Under CI load the rejection text can
    // render a frame before `busy` clears (this exact race went red on #684
    // and again on #686), so wait for a dismissible signal — Close re-enabled
    // — before firing the final Escape.
    await waitFor(() =>
      expect((dialog.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
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

  it("kind change clears the old provider's command/args drafts and sends neither unless retyped", async () => {
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
    const [update, opts] = onCommit.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { envOnly: boolean },
    ];
    expect(update).toMatchObject({ kind: 'codex-cli', model: 'gpt-6-astra' });
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

// Pins for the Advanced disclosure (PR #684 gate): Milo's mutations
// `useState(hadOverrides)` → `useState(true)` and Advanced onClick → no-op
// both left the suite green, so the collapsed-unless-configured contract and
// the toggle itself get durable instruments here. The argv textarea is the
// marker for "command editor mounted": its placeholder ('--chrome' for
// claude-code) exists only inside the expanded section.
describe('Runtime modal — Advanced disclosure', () => {
  it('opens collapsed with no override; toggling reveals the editor, a draft survives collapse, and a hidden dirty draft still routes through the restart confirm', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal({ kind: 'claude-code', model: 'fable' }, onCommit);

    // Collapsed on arrival: the disclosure says so AND the editor is absent.
    const advanced = dialog.getByRole('button', { name: 'Advanced' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(dialog.queryByPlaceholderText('--chrome')).toBeNull();

    // Toggle open (kills the onClick-no-op mutation), type an argv draft.
    fireEvent.click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(dialog.getByPlaceholderText('--chrome'), { target: { value: '--chrome' } });

    // Collapse back: the editor unmounts but the draft is state, not DOM.
    fireEvent.click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(dialog.queryByPlaceholderText('--chrome')).toBeNull();

    // Re-expand: the draft is exactly as typed.
    fireEvent.click(advanced);
    expect((dialog.getByPlaceholderText('--chrome') as HTMLTextAreaElement).value).toBe('--chrome');

    // Collapse again and save while the dirty draft is hidden: folding the
    // section must not fold the safety rail — the launch-affecting change
    // still routes through ConfirmRestartModal, and the payload carries it.
    fireEvent.click(advanced);
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ runtimeArgs: ['--chrome'] }, { envOnly: false });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('opens expanded when the agent already has an override (kills useState(true): the collapsed branch is the one asserted above), with focus on the dialog container', () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal(
      { kind: 'claude-code', model: 'fable', runtimeArgs: ['--chrome'] },
      onCommit,
    );

    // Existing data is never hidden on arrival…
    expect(dialog.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect((dialog.getByPlaceholderText('--chrome') as HTMLTextAreaElement).value).toBe('--chrome');
    // …and the auto-open must not steal focus from the dialog container
    // (the focus contract: the first control is an edit, not a safe answer).
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Runtime' }));
  });
});

// Pins for the per-agent fast mode opt-in. Claude and Codex support the field;
// other providers reject it, so the payload rules here are load-bearing, not
// cosmetic. Absent and false launch identically (nothing is injected for
// either), so an untouched box must send no key at all.
describe('Runtime modal — fast mode', () => {
  it('is a launch-affecting opt-in: checking the box routes through the restart confirm and sends exactly { fastMode: true }', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal({ kind: 'claude-code', model: 'fable' }, onCommit);

    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    const box = dialog.getByRole('checkbox', { name: 'Request fast mode' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    // The honest copy IS the contract (Milo's #686 gate: a wholesale rewrite
    // to "Enables fast mode…" left the suite green). Pin the two load-bearing
    // meanings: request-not-guarantee, and org enablement + usage credits as
    // the availability condition.
    expect(dialog.getByText(/A request, not a guarantee/)).toBeTruthy();
    expect(
      dialog.getByText(
        /unless the Anthropic organization has fast mode enabled with usage credits/,
      ),
    ).toBeTruthy();
    fireEvent.click(box);

    // Toggling changes provider launch config → the restart confirm must
    // mount; committing happens from ITS Save.
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ fastMode: true }, { envOnly: false });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('existing fastMode shows on the row, auto-expands Advanced with the box checked, and unchecking sends { fastMode: false }', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal({ kind: 'claude-code', model: 'fable', fastMode: true }, onCommit);

    // The read-only row discloses the CONFIG, qualified: "Fast mode
    // requested", never a bare "Fast mode" — provider-side availability may
    // still decline the request, so this surface must not read as activation.
    expect(screen.getByRole('button', { name: /Fast mode requested/ })).toBeTruthy();
    // fastMode counts as configured Advanced data: never hidden on arrival.
    expect(dialog.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    const box = dialog.getByRole('checkbox', { name: 'Request fast mode' }) as HTMLInputElement;
    expect(box.checked).toBe(true);

    fireEvent.click(box);
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    expect(onCommit).toHaveBeenCalledWith({ fastMode: false }, { envOnly: false });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('is available for Codex with Codex credit and API pricing copy', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal({ kind: 'codex-cli', model: 'gpt-5.6-sol' }, onCommit);

    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    expect(dialog.getByText(/up to 1.5× faster/)).toBeTruthy();
    expect(dialog.getByText(/2.5× ChatGPT credits/)).toBeTruthy();
    expect(dialog.getByText(/API-key sessions use Priority pricing/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));

    expect(onCommit).toHaveBeenCalledWith({ fastMode: true }, { envOnly: false });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('lets the opt-in ride a kind change to Codex', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal(
      { kind: 'kimi-cli', model: 'kimi-code/kimi-for-coding' },
      onCommit,
    );

    fireEvent.click(dialog.getByRole('button', { name: 'Codex CLI' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));

    const [update] = onCommit.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(update).toMatchObject({
      fastMode: true,
      kind: 'codex-cli',
      model: 'gpt-6-astra',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('clears fast mode on every kind change and never sends it to an unsupported provider', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal({ kind: 'claude-code', model: 'fable', fastMode: true }, onCommit);

    fireEvent.click(dialog.getByRole('button', { name: 'Codex CLI' }));
    // The kind-change hint owns the disclosure that the opt-in was dropped.
    expect(dialog.getByText(/Fast mode was turned off/)).toBeTruthy();
    expect(
      (dialog.getByRole('checkbox', { name: 'Request fast mode' }) as HTMLInputElement).checked,
    ).toBe(false);

    // Like the command drafts, the opt-in draft is cleared by ANY kind
    // change: switching back to Claude Code shows the box unchecked, so a
    // round-trip cannot silently re-arm it.
    fireEvent.click(dialog.getByRole('button', { name: 'Claude Code' }));
    expect(
      (dialog.getByRole('checkbox', { name: 'Request fast mode' }) as HTMLInputElement).checked,
    ).toBe(false);
    fireEvent.click(dialog.getByRole('button', { name: 'Kimi CLI' }));
    expect(dialog.queryByRole('checkbox', { name: 'Request fast mode' })).toBeNull();

    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [update] = onCommit.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(update).toMatchObject({ kind: 'kimi-cli' });
    expect(update).not.toHaveProperty('fastMode');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });
});
