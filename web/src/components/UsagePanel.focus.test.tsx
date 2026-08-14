import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderUsageRow } from '@shared/provider-usage';
import UsagePanel from './UsagePanel';

// Focus, naming and Escape contract for the Providers panel — the second half of
// group C, the last adoption cut of the `aria-modal` sweep.
//
// The panel had no focus handling: opening it left focus on the sidebar control
// behind the backdrop, so the first Tab walked the app underneath a full-screen
// dialog. It also had an ANONYMOUS-BY-CONSTANT name (`aria-label="Providers"`)
// alongside a visible header saying the same word twice over.
//
// The finding worth the file is the Escape handler. It already carried a
// hand-rolled topmost check — `e.key === 'Escape' && !loginTarget` — which
// enumerated ONE of the two dialogs this panel can host. The other is
// `useConfirm`'s ConfirmModal, reached from the account-switch, account-removal
// and CLI-update paths. With one of those open, a single Escape cancelled the
// confirm AND closed the panel underneath it. That is the same defect #669 fixed
// on the Server panel, surviving here behind a guard that looked like it covered
// the case.
//
// So the cases below are split deliberately:
//   - the CONFIRM case is the INSTRUMENT for this cut: red against the panel as
//     it stands at e3516c2c, and red again against a predicate stuck at true.
//   - the LOGIN-modal case is a REGRESSION GUARD against THAT change (green at
//     e3516c2c, because `!loginTarget` did handle it) and an INSTRUMENT against
//     the predicate. Both roles are recorded on the case itself.
//   - the standalone case guards the opposite failure: a gate that is too TIGHT
//     kills Escape entirely, and neither of the other two can see that.
//
// Measured across the five focus files (50/50 at baseline): the panel at
// e3516c2c reds 5 of the 7 here; a predicate stuck at true reds the confirm and
// login cases; a predicate stuck at false reds the confirm and standalone ones.
//
// NOTE: web vitest is not wired into CI yet (issue #344) - run locally.

const api = vi.hoisted(() => ({
  cancelClaudeAccountLogin: vi.fn(),
  fetchClaudeAccountLogin: vi.fn(),
  removeClaudeAccount: vi.fn(),
  refreshProviderUsage: vi.fn(async () => ({ providers: [] })),
  selectClaudeAccount: vi.fn(),
  startClaudeAccountLogin: vi.fn(),
  submitClaudeAccountLoginCode: vi.fn(),
}));

// Two accounts, the second active. That is the minimum that produces a "Use"
// button on the first one, which is the cheapest route into the shared confirm.
// Deliberately the SWITCH path rather than removal or CLI update: this file
// never clicks a confirm through, and reaching the modal by the least
// destructive door means a future case added here cannot reach a destructive one
// by accident.
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
    // Not 'switching': that value puts `fetchProviderAccounts` on a 1 Hz
    // refetch loop (UsagePanel's `refetchInterval`) for the life of the test.
    status: 'active' as const,
  },
}));

const usageRows = vi.hoisted(() => ({
  value: [
    {
      account: 'primary@example.com',
      accountId: 'primary',
      checkedAt: '2026-08-14T09:00:00.000Z',
      extras: [],
      label: 'Claude Code',
      provider: 'claude-code',
      source: 'private-api',
      status: 'available',
      windows: [{ label: '5h', remainingPercent: 64, resetsAt: '2030-01-01T05:00:00.000Z' }],
    },
    {
      account: 'secondary@example.com',
      accountId: 'secondary',
      active: true,
      checkedAt: '2026-08-14T09:00:00.000Z',
      extras: [],
      label: 'Claude Code',
      provider: 'claude-code',
      source: 'private-api',
      status: 'available',
      windows: [{ label: '5h', remainingPercent: 88, resetsAt: '2030-01-01T05:00:00.000Z' }],
    },
  ] as ProviderUsageRow[],
}));

// Whole-module factory, so every name the panel OR its children import has to be
// present or the import graph throws at load — including the four login calls
// `ClaudeAccountLoginModal` pulls in and `fetchProviderCliStatus`, which
// `useProviderCliStatus` uses rather than the panel itself.
//
// Every mutating call is a bare `vi.fn()`: no case here confirms anything, and
// stubbing them means a future case that clicks a confirm through cannot put a
// provider switch, an account removal or a machine-wide CLI update on the wire
// from a unit test.
vi.mock('@/api/system', () => ({
  applyProviderCliUpdate: vi.fn(),
  cancelClaudeAccountLogin: api.cancelClaudeAccountLogin,
  checkProviderClis: vi.fn(),
  fetchClaudeAccountLogin: api.fetchClaudeAccountLogin,
  fetchProviderAccounts: vi.fn(async () => ({ providers: [accountState.value] })),
  fetchProviderCliStatus: vi.fn(async () => ({
    operation: { status: 'idle' as const },
    providers: [
      {
        agents: [],
        // These three are spelled from the zod enums in `shared/provider-cli.ts`
        // rather than copied from the neighbouring UsagePanel tests, which use
        // values ('ready', 'native') that are not members. Nothing validates at
        // runtime, so those pass — but they are not a source of truth.
        installSource: 'claude-native' as const,
        installedVersion: '2.1.0',
        label: 'Claude Code',
        operation: { status: 'idle' as const },
        provider: 'claude-code' as const,
        state: 'current' as const,
        updateAvailable: false,
        updateMode: 'unavailable' as const,
      },
    ],
    upgradeLocked: false,
  })),
  fetchProviderContextLimits: vi.fn(async () => ({ providers: [] })),
  fetchProviderRuntimeCommands: vi.fn(async () => ({ providers: [] })),
  fetchProviderUsage: vi.fn(async () => ({ providers: usageRows.value })),
  removeClaudeAccount: api.removeClaudeAccount,
  refreshProviderUsage: api.refreshProviderUsage,
  saveProviderContextLimit: vi.fn(),
  saveProviderRuntimeCommand: vi.fn(),
  selectClaudeAccount: api.selectClaudeAccount,
  startClaudeAccountLogin: api.startClaudeAccountLogin,
  submitClaudeAccountLoginCode: api.submitClaudeAccountLoginCode,
}));

/** An outside opener plus the panel it opens, so restore has somewhere to go. */
function PanelHost() {
  const [open, setOpen] = useState(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <button type="button" onClick={() => setOpen(true)}>
        Providers
      </button>
      {open && <UsagePanel onClose={() => setOpen(false)} />}
    </QueryClientProvider>
  );
}

async function openPanel() {
  render(<PanelHost />);
  const opener = screen.getByRole('button', { name: 'Providers' });
  // Focused first because a keyboard user reaches it by Tab and presses Enter,
  // and the hook records "focus came from here" from `activeElement`.
  // `fireEvent.click` moves no focus in jsdom.
  opener.focus();
  fireEvent.click(opener);
  // The panel renders a skeleton until usage AND CLI status resolve, and the
  // dialog element itself exists during the skeleton — so waiting only for the
  // dialog would measure a two-control shell rather than the real panel. Wait
  // for a provider row instead.
  const panel = await screen.findByRole('dialog', { name: 'Providers' });
  await screen.findByRole('button', { name: /Claude Code/i });
  return { opener, panel };
}

/** Cold start collapses every provider; open Claude to reach the account rows. */
async function expandClaude() {
  const toggle = await screen.findByRole('button', { name: /Claude Code/i });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
}

describe('Providers panel — focus contract', () => {
  it('lands focus in the panel, on nothing that would act', async () => {
    // No `initialFocusRef`. Close undoes the open, and Refresh re-checks every
    // provider CLI and re-reads provider usage — so a keyboard user who opens
    // the panel and presses Enter would fire a machine-wide provider sweep they
    // never asked for. A confirm lands on Cancel because a confirm ASKS
    // something and Cancel is the safe answer; a panel asks nothing.
    const { opener, panel } = await openPanel();

    expect(document.activeElement).toBe(panel);
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Refresh providers' }),
    );
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Close providers panel' }),
    );
  });

  it('keeps Tab inside the panel instead of the app behind it', async () => {
    const { opener, panel } = await openPanel();

    // jsdom implements no native Tab movement, so a mid-dialog Tab is not
    // observable as a move. What IS observable is that the hook cancelled the
    // key (`fireEvent` returns `dispatchEvent`'s boolean, so `false` means
    // defaultPrevented) and that the boundary press moved focus itself.
    //
    // Neither endpoint is asserted by NAME here, unlike the Server panel's
    // version of this case, and the reason is worth recording. The header's
    // Refresh button is `disabled` while any of the five queries is in flight,
    // and the hook deliberately skips disabled nodes — so "which control is
    // first" depends on fetch timing, and the last one depends on how many
    // provider rows the fixture produced. Pinning either would pin the fixture
    // rather than the contract. What the contract actually promises is that Tab
    // is answered by this dialog and lands inside it, and that is what is
    // asserted: cancelled, moved off the container, still contained.
    const forward = fireEvent.keyDown(panel, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).not.toBe(panel);
    expect(panel.contains(document.activeElement)).toBe(true);
    const first = document.activeElement!;

    // Shift+Tab off the first control wraps to the last one INSIDE the panel
    // rather than reaching the app behind the backdrop.
    const backward = fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(backward).toBe(false);
    expect(document.activeElement).not.toBe(first);
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);
  });

  it('takes its accessible name from the visible header rather than a second copy of the word', async () => {
    // Two halves. "The dialog is called Providers" is a REGRESSION GUARD: it
    // held before too, via a hardcoded `aria-label`. The INSTRUMENT is that the
    // name now resolves THROUGH the visible header, so the announced name and
    // the header cannot drift apart — the failure the workspace picker in this
    // same cut was actually exhibiting.
    const { panel } = await openPanel();

    expect(panel.hasAttribute('aria-label')).toBe(false);
    const labelledBy = panel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading?.textContent?.trim()).toBe('Providers');
    expect(panel.contains(heading)).toBe(true);
  });

  it('returns focus to the control that opened it', async () => {
    const { opener } = await openPanel();
    // Without this half the last assertion passes trivially against a panel that
    // never moved focus off the opener at all.
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Close providers panel' }));

    expect(screen.queryByRole('dialog', { name: 'Providers' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Providers panel — Escape dismissal', () => {
  it('still closes on Escape when it is the only dialog', async () => {
    // REGRESSION GUARD against the gate being too tight. A predicate stuck at
    // false, or a caller that inverts it, makes Escape stop working entirely —
    // which neither layered case below can see, since both only ask whether the
    // panel closed too EARLY.
    const { panel } = await openPanel();

    fireEvent.keyDown(panel, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Providers' })).toBeNull();
  });

  it('closes only the confirm on the first Escape, and the panel on the second', async () => {
    // THE INSTRUMENT. Red against the panel at e3516c2c, whose `!loginTarget`
    // guard is blind to this dialog: the first Escape took the confirm AND the
    // panel, so the user lost the thing they were still deciding about.
    //
    // Asserted as a SEQUENCE rather than an end state, because both presses end
    // with everything closed — a final-state check cannot separate "cancelled
    // the switch and kept reading" from "lost both at once".
    await openPanel();
    await expandClaude();

    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    const confirm = await screen.findByRole('dialog', { name: 'Switch to primary@example.com?' });

    // First Escape — answers the confirm, and nothing else.
    fireEvent.keyDown(confirm, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Switch to primary@example.com?' })).toBeNull();
    const panel = screen.getByRole('dialog', { name: 'Providers' });

    // Second Escape — the panel is topmost again, so it takes it.
    fireEvent.keyDown(panel, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Providers' })).toBeNull();
    // Nothing was ever confirmed: no account switch reached the wire.
    expect(api.selectClaudeAccount).not.toHaveBeenCalled();
  });

  it('leaves the panel open while the sign-in dialog is over it', async () => {
    // Measured, not assumed, and it is BOTH — the two roles have different
    // referents and saying only one would be wrong:
    //   - against the panel at e3516c2c it is a REGRESSION GUARD (green there:
    //     the old `!loginTarget` enumeration did handle this one layer), pinned
    //     because replacing an enumeration with a predicate is exactly the kind
    //     of change that widens coverage in one direction while dropping the
    //     case that already worked;
    //   - against a hook whose predicate answers true for a covered dialog it is
    //     an INSTRUMENT, and it goes red.
    await openPanel();
    await expandClaude();

    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const login = await screen.findByRole('dialog', { name: /Claude/i });
    expect(login).not.toBe(screen.getByRole('dialog', { name: 'Providers' }));

    fireEvent.keyDown(login, { key: 'Escape' });

    expect(screen.getByRole('dialog', { name: 'Providers' })).toBeTruthy();
  });
});
