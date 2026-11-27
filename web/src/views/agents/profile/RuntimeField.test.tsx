import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { providerCatalog, type ProviderAvailability } from '@shared/provider-catalog';

import { providerCatalogForAvailability } from '@/lib/provider-availability';
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
// What Base UI does to a value on its own (moving a value that left the list
// back to the one it opened with) is driven through the real Select in
// RuntimeField.base-select.test.tsx.
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
  availability: ProviderAvailability[] | null = null,
) {
  render(
    <RuntimeRow
      provider={provider as never}
      providerOptions={availability ? providerCatalogForAvailability(providerOptions, availability) : providerOptions}
      providerAvailability={availability}
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
    fireEvent.click(dialog.getByRole('button', { name: 'Codex' }));
    expect(dialog.queryByDisplayValue('/opt/homebrew/bin/claude-canary')).toBeNull();
    expect(dialog.getByText(/The previous command override was cleared/)).toBeTruthy();

    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [update, opts] = onCommit.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { envOnly: boolean },
    ];
    expect(update).toMatchObject({ kind: 'codex-cli', model: 'gpt-6.2-astra' });
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
    // meanings: standard-speed fallback, and fast mode + usage credits on the
    // Anthropic organization as the availability condition.
    expect(
      dialog.getByText(
        /A request, not a guarantee\. Needs fast mode and usage credits enabled for your Anthropic organization, and Claude can still run at standard speed\./,
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

    // The read-only row discloses the CONFIG, qualified: a compact FAST tag
    // whose accessible name and hover both say "Fast mode requested", because
    // provider-side availability may still decline the request, so this
    // surface must not read as activation.
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
    const dialog = openModal({ kind: 'codex-cli', model: 'gpt-6.1-sol' }, onCommit);

    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    expect(dialog.getByText(/Available on supported models and accounts/)).toBeTruthy();
    expect(dialog.getByText(/extra subscription quota \(2\.5×\), purchased credits \(2×\)/)).toBeTruthy();
    expect(dialog.getByText(/Priority API pricing/)).toBeTruthy();
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

    fireEvent.click(dialog.getByRole('button', { name: 'Codex' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));

    const [update] = onCommit.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(update).toMatchObject({
      fastMode: true,
      kind: 'codex-cli',
      model: 'gpt-6.2-astra',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('clears fast mode on every kind change and never sends it to an unsupported provider', async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const dialog = openModal({ kind: 'claude-code', model: 'fable', fastMode: true }, onCommit);

    fireEvent.click(dialog.getByRole('button', { name: 'Codex' }));
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
    fireEvent.click(dialog.getByRole('button', { name: 'Kimi Code' }));
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

// Claude Code's live list can name models the built-in catalog does not know. The
// row and the model menu show the CLI's name for those, a built-in name otherwise,
// and a pick saves the id.
describe('Runtime modal — live model names', () => {
  const liveClaude: ProviderAvailability[] = [
    {
      checkedAt: '2026-11-25T00:00:00.000Z',
      defaultModel: 'opus',
      kind: 'claude-code',
      modelLabels: { 'claude-fable-5-1[1m]': 'Fable 1M', opus: 'Opus (live)' },
      modelReasoningEfforts: { 'claude-fable-5-1[1m]': ['high', 'max'], opus: ['low', 'medium', 'high', 'xhigh', 'max'] },
      models: ['opus', 'claude-fable-5-1[1m]'],
      present: true,
    },
  ];

  it('names a saved live-only model on the row by its live name', () => {
    render(
      <RuntimeRow
        provider={{ kind: 'claude-code', model: 'claude-fable-5-1[1m]', reasoningEffort: 'max' } as never}
        providerOptions={providerCatalogForAvailability(providerOptions, liveClaude)}
        providerAvailability={liveClaude}
        isActive
        onCommit={vi.fn(async () => {}) as never}
      />,
    );
    expect(screen.getByRole('button', { name: /·/ }).textContent).toContain('Fable 1M');
  });

  it('lists live names in the model menu, and picking one saves its id', async () => {
    const onCommit = vi.fn(async () => {});
    const dialog = openModal({ kind: 'claude-code', model: 'opus', reasoningEffort: 'high' }, onCommit, liveClaude);
    expect(dialog.queryByRole('button', { name: 'Opus (live)' })).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'Fable 1M' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith(
      { kind: 'claude-code', model: 'claude-fable-5-1[1m]', reasoningEffort: 'high' },
      { envOnly: false },
    );
  });

  // Kimi's CLI name for its alias wins over Claude's built-in name for the same id.
  it("names a Kimi alias by Kimi's name, not Claude's", () => {
    const liveKimi: ProviderAvailability[] = [
      {
        checkedAt: '2026-11-25T00:00:00.000Z',
        defaultModel: 'opus',
        kind: 'kimi-cli',
        modelLabels: { opus: 'Local Builder' },
        modelReasoningEfforts: { opus: [] },
        models: ['opus'],
        present: true,
      },
    ];
    render(
      <RuntimeRow
        provider={{ kind: 'kimi-cli', model: 'opus' } as never}
        providerOptions={providerCatalogForAvailability(providerOptions, liveKimi)}
        providerAvailability={liveKimi}
        isActive
        onCommit={vi.fn(async () => {}) as never}
      />,
    );
    const row = screen.getByRole('button', { name: /·/ }).textContent;
    expect(row).toContain('Local Builder');
    expect(row).not.toContain('Opus');
  });

  // Two OpenCode providers can give a model the same name, and a third model can be
  // named what one of those shows with its id; every row still shows its own id.
  const sharedNames: [string, string, string][] = [
    ['review-a/chat', 'review-a/chat', 'high'],
    ['review-b/chat', 'Review Chat (review-b/chat)', 'low'],
    ['review-a/extra-chat', 'Review Chat (review-a/chat) (review-a/extra-chat)', 'medium'],
  ];
  for (const [model, shown, effort] of sharedNames) it(`tells ${model} apart from models named alike, in the menu and on the pick`, async () => {
    const liveOpenCode: ProviderAvailability[] = [
      {
        checkedAt: '2026-11-25T00:00:00.000Z',
        defaultModel: 'review-a/chat',
        kind: 'opencode-cli',
        modelLabels: {
          'review-a/chat': 'Review Chat',
          'review-a/extra-chat': 'Review Chat (review-a/chat)',
          'review-b/chat': 'Review Chat',
        },
        modelReasoningEfforts: { 'review-a/chat': ['high'], 'review-a/extra-chat': ['medium'], 'review-b/chat': ['low'] },
        models: ['review-a/chat', 'review-b/chat', 'review-a/extra-chat'],
        present: true,
      },
    ];
    const onCommit = vi.fn(async () => {});
    // Start from a model other than the pick, so that picking it is a change.
    const saved = model === 'review-b/chat' ? 'review-a/chat' : 'review-b/chat';
    const dialog = openModal({ kind: 'opencode-cli', model: saved, reasoningEffort: 'high' }, onCommit, liveOpenCode);
    expect(dialog.queryByRole('button', { name: 'Review Chat' })).toBeNull();
    for (const [, text] of sharedNames) expect(dialog.getAllByRole('button', { name: text }).length).toBeGreaterThan(0);
    fireEvent.click(dialog.getAllByRole('button', { name: shown }).at(-1)!);
    // The trigger shows the pick the same way, and no other row does.
    expect(dialog.getAllByRole('button', { name: shown })).toHaveLength(2);
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith({ kind: 'opencode-cli', model, reasoningEffort: effort }, { envOnly: false });
  });
});

// Codex reads its model list live; each model's effort menu is what that read
// reports and saves accept. A model switch whose menu is empty must clear the
// saved level instead of letting the hidden one ride along.
describe('Runtime modal — effort follows the new model', () => {
  const liveCodex = (terraEfforts: string[]): ProviderAvailability[] => [
    {
      checkedAt: '2026-11-24T00:00:00.000Z',
      defaultModel: 'gpt-6.2-astra',
      kind: 'codex-cli',
      modelReasoningEfforts: { 'gpt-6.1-terra': terraEfforts, 'gpt-6.2-astra': ['high', 'xhigh'] },
      models: ['gpt-6.2-astra', 'gpt-6.1-terra'],
      present: true,
    },
  ];
  const saved = { kind: 'codex-cli', model: 'gpt-6.2-astra', reasoningEffort: 'xhigh' };

  for (const [name, efforts, expected] of [
    ['no levels', [], null],
    ['only levels saves reject', ['minimal'], null],
    ['a level saves accept', ['high'], 'high'],
  ] as const) {
    it(`switching to a model with ${name} sends reasoningEffort: ${String(expected)}`, async () => {
      const onCommit = vi.fn(async () => {});
      const dialog = openModal(saved, onCommit, liveCodex([...efforts]));
      fireEvent.click(dialog.getByRole('button', { name: 'GPT-6.1 Terra' }));
      expect(dialog.queryAllByRole('button', { name: 'High' }).length > 0).toBe(expected === 'high');
      fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
      fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
      expect(onCommit).toHaveBeenCalledWith(
        { kind: 'codex-cli', model: 'gpt-6.1-terra', reasoningEffort: expected },
        { envOnly: false },
      );
    });
  }

  // The live read can answer after the dialog opened: after the model pick, or
  // after Save while the restart confirm is open. Astra's live menu here is High only.
  const lateMenu: ProviderAvailability[] = [
    {
      checkedAt: '2026-11-24T00:00:00.000Z',
      defaultModel: 'gpt-6.2-astra',
      kind: 'codex-cli',
      modelReasoningEfforts: { 'gpt-6.2-astra': ['high'], 'gpt-6.2-sol': ['high'] },
      models: ['gpt-6.2-sol', 'gpt-6.2-astra'],
      present: true,
    },
  ];
  function openWithLateMenu(
    provider: Record<string, unknown>,
    onCommit: (...args: never[]) => Promise<void>,
    menu: ProviderAvailability[] = lateMenu,
  ) {
    const row = (availability: ProviderAvailability[] | null) => (
      <RuntimeRow
        provider={provider as never}
        providerOptions={providerCatalogForAvailability(providerOptions, availability)}
        providerAvailability={availability}
        isActive
        onCommit={onCommit as never}
      />
    );
    const { rerender } = render(row(null));
    fireEvent.click(screen.getByRole('button', { name: /·/ }));
    return {
      dialog: within(screen.getByRole('dialog', { name: 'Runtime' })),
      menuArrives: () => rerender(row(menu)),
    };
  }

  for (const when of ['after the model pick', 'while the restart confirm is open'] as const) {
    it(`a new model's level follows a live menu that arrives ${when}`, async () => {
      const onCommit = vi.fn(async () => {});
      const { dialog, menuArrives } = openWithLateMenu(
        { kind: 'codex-cli', model: 'gpt-6.2-sol', reasoningEffort: 'xhigh' },
        onCommit,
      );
      fireEvent.click(dialog.getByRole('button', { name: 'GPT-6.2 Astra' }));
      // Before the live read, the built-in menu offers Extra High, and it is the default.
      expect(dialog.queryAllByRole('button', { name: 'Extra High' }).length).toBeGreaterThan(0);
      if (when === 'after the model pick') {
        menuArrives();
        expect(dialog.queryAllByRole('button', { name: 'Extra High' })).toHaveLength(0);
        expect(dialog.queryAllByRole('button', { name: 'High' }).length).toBeGreaterThan(0);
      }
      fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
      if (when === 'while the restart confirm is open') menuArrives();
      fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
      expect(onCommit).toHaveBeenCalledWith(
        { kind: 'codex-cli', model: 'gpt-6.2-astra', reasoningEffort: 'high' },
        { envOnly: false },
      );
    });
  }

  it('a level picked by hand follows a live menu that arrives later', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, menuArrives } = openWithLateMenu(
      { kind: 'codex-cli', model: 'gpt-6.2-sol', reasoningEffort: 'xhigh' },
      onCommit,
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Max' }));
    menuArrives();
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith(
      { kind: 'codex-cli', model: 'gpt-6.2-sol', reasoningEffort: 'high' },
      { envOnly: false },
    );
  });

  it('an untouched saved level stays when a late menu lacks it and only another field changes', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, menuArrives } = openWithLateMenu(
      { kind: 'codex-cli', model: 'gpt-6.2-astra', reasoningEffort: 'xhigh' },
      onCommit,
    );
    menuArrives();
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith({ fastMode: true }, { envOnly: false });
  });

  // Later reads can also drop a model from the list, or empty a model's effort menu.
  const solMenu = (sol: string[], models = ['gpt-6.2-sol', 'gpt-6.1-terra']): ProviderAvailability[] => [
    {
      checkedAt: '2026-11-24T00:00:00.000Z',
      defaultModel: 'gpt-6.1-terra',
      kind: 'codex-cli',
      modelReasoningEfforts: { 'gpt-6.1-terra': ['high'], 'gpt-6.2-sol': sol },
      models,
      present: true,
    },
  ];
  const solXhigh = { kind: 'codex-cli', model: 'gpt-6.2-sol', reasoningEffort: 'xhigh' };

  it('a newly picked model the live list drops blocks Save until another is picked', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, menuArrives } = openWithLateMenu(solXhigh, onCommit, solMenu(['high', 'xhigh']));
    fireEvent.click(dialog.getByRole('button', { name: 'GPT-6.2 Astra' }));
    menuArrives();
    expect(dialog.getByText('Pick a model')).toBeTruthy();
    expect(dialog.getByText(/GPT-6.2 Astra is no longer in the model list/)).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog.getByRole('button', { name: 'GPT-6.1 Terra' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith(
      { kind: 'codex-cli', model: 'gpt-6.1-terra', reasoningEffort: 'high' },
      { envOnly: false },
    );
  });

  it('a model dropped while the restart confirm is open sends nothing and returns to the editor', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, menuArrives } = openWithLateMenu(solXhigh, onCommit, solMenu(['high', 'xhigh']));
    fireEvent.click(dialog.getByRole('button', { name: 'GPT-6.2 Astra' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    menuArrives();
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Save and apply when idle?' })).toBeNull();
    expect(dialog.getByText(/GPT-6.2 Astra is no longer in the model list/)).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the saved model stays when the live list lacks it and only another field changes', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, menuArrives } = openWithLateMenu(
      { kind: 'codex-cli', model: 'gpt-6.2-astra', reasoningEffort: 'xhigh' },
      onCommit,
      solMenu(['high']),
    );
    menuArrives();
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith({ fastMode: true }, { envOnly: false });
  });

  for (const [menuName, sol] of [
    ['no levels', []],
    ['only levels saves reject', ['minimal']],
  ] as const) {
    for (const when of ['before Save', 'while the restart confirm is open'] as const) {
      it(`a level picked by hand on the saved model is cleared when its live menu has ${menuName} (${when})`, async () => {
        const onCommit = vi.fn(async () => {});
        const { dialog, menuArrives } = openWithLateMenu(solXhigh, onCommit, solMenu([...sol]));
        fireEvent.click(dialog.getByRole('button', { name: 'High' }));
        if (when === 'before Save') menuArrives();
        fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
        if (when === 'while the restart confirm is open') menuArrives();
        fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
        expect(onCommit).toHaveBeenCalledWith(
          { kind: 'codex-cli', model: 'gpt-6.2-sol', reasoningEffort: null },
          { envOnly: false },
        );
      });
    }
  }

  it('an untouched saved level stays when its live menu turns out empty and only fast mode changes', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, menuArrives } = openWithLateMenu(solXhigh, onCommit, solMenu([]));
    menuArrives();
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith({ fastMode: true }, { envOnly: false });
  });

  it('a hand-picked level that a later menu moves back to the saved one sends nothing', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, menuArrives } = openWithLateMenu(solXhigh, onCommit, solMenu(['xhigh']));
    fireEvent.click(dialog.getByRole('button', { name: 'High' }));
    menuArrives();
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog', { name: 'Save and apply when idle?' })).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Runtime' })).toBeNull());
  });

  it('a save that keeps the model sends no effort, even when the menu hides the saved level', async () => {
    const onCommit = vi.fn(async () => {});
    const dialog = openModal(
      { kind: 'codex-cli', model: 'gpt-6.1-terra', reasoningEffort: 'xhigh' },
      onCommit,
      liveCodex([]),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith({ fastMode: true }, { envOnly: false });
  });

  it('renders install hint commands inside <code> without literal backticks when the current provider is missing', () => {
    const onCommit = vi.fn(async () => {});
    const dialog = openModal(
      { kind: 'claude-code', model: 'opus' },
      onCommit,
      [{ kind: 'claude-code', present: false }],
    );
    const code = screen.getByRole('dialog', { name: 'Runtime' }).querySelector('code');
    expect(code?.textContent).toBe('claude --version');
    expect(dialog.getByText(/Install Claude Code so/).textContent).not.toContain('`');
  });
});
