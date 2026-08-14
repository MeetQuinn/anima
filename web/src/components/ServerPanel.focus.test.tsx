import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { recordFocusMoves } from '@/test/focus-moves';
import ServerPanel from './ServerPanel';

// Focus and semantics contract for the Server panel, and the first coverage of
// a REAL nested pair: the panel hosts RestartButton, whose confirm is itself a
// `useDialogFocus` instance portaled to `document.body` — so it is not inside
// the panel's subtree, and both instances are live at once.
// `dialog-focus-stack.test.tsx` pins that mechanism with purpose-built doubles;
// this is the shape it was built for, standing in for itself.
//
// The panel had no focus handling before: opening it left focus on the sidebar
// Server button behind the backdrop, so the first Tab walked the app underneath
// a full-screen dialog.
//
// Where a case mixes an instrument with a regression guard, it says which
// assertion is which, and the restore case asserts focus LEFT the opener before
// asserting it comes back — otherwise it passes trivially against a dialog that
// never moved focus at all.
//
// TWO describes, because the panel's two layered behaviours fail differently.
// The first covers focus and naming. The second covers Escape dismissal, which
// is the panel's OWN policy rather than the hook's: the hook only answers
// `isTopmostDialog()`, and this file pins what the panel does with that answer.
// They share the mocks and `PanelHost` deliberately — a separate file would
// duplicate the agent/system/upgrade scaffolding that makes Restart reach its
// confirm at all, and the two copies would drift.
//
// NOTE: web vitest is not wired into CI yet (issue #344) - run locally.

vi.mock('@/api/system', () => ({
  fetchServerInfo: vi.fn().mockResolvedValue({
    version: '0.1.11',
    track: 'canary',
    animaHome: '/tmp/anima-home',
    startedAt: '2026-08-14T00:00:00.000Z',
  }),
  pingHealth: vi.fn().mockResolvedValue(true),
  // Never called by these cases — the confirm is always cancelled, never
  // confirmed. Mocked so a mistake in a future case cannot put a restart on the
  // wire from a unit test.
  restartServices: vi.fn(),
}));

// The real runtime-upgrade row's contents change with upgrade state, which would
// make "the last control in the panel" a moving target. Stubbed to one button so
// the boundary case measures the panel's own wrap, not the row's state machine.
vi.mock('./RuntimeUpgrade', () => ({
  default: () => <button type="button">Check for updates</button>,
}));

// One agent mid-item, so Restart goes through the confirm rather than restarting
// outright. That branch is the whole point of the nested case.
vi.mock('@/hooks/useAgentDirectory', () => ({
  useAgents: () => ({ data: [{ id: 'nora', profile: { displayName: 'Nora' } }] }),
  useAgentStatuses: () => ({ data: [{ agentId: 'nora', currentItemId: 'item-1' }] }),
}));

/** An outside opener plus the panel it opens, so restore has somewhere to go. */
function PanelHost() {
  const [open, setOpen] = useState(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <button type="button" onClick={() => setOpen(true)}>
        Server
      </button>
      {open && <ServerPanel onClose={() => setOpen(false)} />}
    </QueryClientProvider>
  );
}

function openPanel() {
  render(<PanelHost />);
  const opener = screen.getByRole('button', { name: 'Server' });
  opener.focus();
  fireEvent.click(opener);
  return { opener };
}

describe('Server panel — focus contract', () => {
  it('lands focus in the panel, on nothing that would act', () => {
    // Deliberately no `initialFocusRef`. Every control here either undoes the
    // open (Close) or does something machine-scoped (Restart, the runtime
    // upgrade row) — a keyboard user who opens the panel and presses Enter must
    // not restart the server. A confirm lands on Cancel because a confirm ASKS
    // something and Cancel is the safe answer; a panel asks nothing, so its
    // dismiss is not a safe answer, it is undo.
    //
    // The container is the landing spot, and it is a real resting place: the
    // next case shows Tab leaves it immediately.
    const { opener } = openPanel();

    const dialog = screen.getByRole('dialog', { name: 'Server' });
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(opener);
    // The two that matter, named rather than implied by the container check.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Restart' }));
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Close server panel' }),
    );
  });

  it('keeps Tab inside the panel instead of the app behind it', () => {
    openPanel();
    const dialog = screen.getByRole('dialog', { name: 'Server' });

    const forward = fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close server panel' }));

    // Shift+Tab off the first control wraps to the last one rather than reaching
    // the sidebar behind the backdrop.
    const backward = fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(backward).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Check for updates' }));
  });

  it('takes its accessible name from the visible header rather than a second copy of the word', () => {
    // Two halves. "The dialog is called Server" is a REGRESSION GUARD: it held
    // before too, via a hardcoded `aria-label="Server"`. The INSTRUMENT is that
    // the name now resolves THROUGH the visible header, so the announced name
    // and the header cannot drift apart — and so a broken pointer is caught,
    // which a string comparison would not do.
    openPanel();

    const dialog = screen.getByRole('dialog', { name: 'Server' });
    expect(dialog.hasAttribute('aria-label')).toBe(false);
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading?.textContent?.trim()).toBe('Server');
    expect(dialog.contains(heading)).toBe(true);
  });

  it('returns focus to the control that opened it', () => {
    const { opener } = openPanel();
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Close server panel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('hands Tab to the restart confirm above it and gives focus back to Restart', () => {
    // Which half measures what:
    //   - Against the pre-change panel this whole case is a REGRESSION GUARD. An
    //     unregistered panel has no Tab listener to misbehave, so the confirm is
    //     the only layer and behaves the same. It is here because adopting the
    //     hook is what creates the second listener in the first place.
    //   - Against a hook without the topmost check it is an INSTRUMENT: the
    //     panel sees "focus is outside me", cancels the confirm's Tab and moves
    //     focus through one of its own controls, behind a dialog covering it.
    //     That is asserted on the TRAIL rather than the end state — measured,
    //     after the end-state version came out green against exactly that
    //     variant. The panel registered first, so its listener runs first and
    //     the confirm's then pulls focus back; the resting place is the same
    //     either way and only the control passed through differs.
    openPanel();
    const panel = screen.getByRole('dialog', { name: 'Server' });

    const restart = screen.getByRole('button', { name: 'Restart' });
    // Focused first because a keyboard user reaches Restart by Tab and presses
    // Enter, and the hook records "focus came from here" from `activeElement`.
    // `fireEvent.click` moves no focus in jsdom.
    restart.focus();
    fireEvent.click(restart);

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab off the confirm's first control wraps inside the CONFIRM, and
    // never touches the panel underneath.
    const moves = recordFocusMoves();
    const backward = fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    moves.stop();
    expect(backward).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restart now' }));
    expect(moves.targets.some((el) => panel.contains(el))).toBe(false);

    fireEvent.click(cancel);

    expect(screen.queryByRole('dialog', { name: 'Restart now?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Server' })).toBeTruthy();
    expect(document.activeElement).toBe(restart);
  });
});

describe('Server panel — Escape dismissal', () => {
  // The panel owns its own Escape handler, and the confirm above it owns one
  // too. Both listen on `window`, and the confirm portals to `document.body`,
  // so neither listener can be scoped away by DOM containment — before this cut
  // one Escape ran both, and cancelling the restart confirm also closed the
  // panel the user was still reading. Measured before the guard on exactly the
  // sequence below: `confirmClosed=true panelClosed=true`.
  //
  // What fixes it is a question, not a rule: `isTopmostDialog()` from the hook.
  // The rule — "ignore Escape while something is over me" — stays here, because
  // it is not the only possible answer (TeamModal closes its picker first, and
  // a confirm mid-commit refuses Escape outright).

  it('still closes on Escape when it is the only dialog', () => {
    // REGRESSION GUARD against the gate being too tight. A predicate stuck at
    // false, or a caller that inverts it, makes Escape stop working entirely —
    // which the two-press case below cannot see, since it only ever asks
    // whether the panel closed too EARLY.
    openPanel();
    const panel = screen.getByRole('dialog', { name: 'Server' });
    expect(document.activeElement).toBe(panel);

    fireEvent.keyDown(panel, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Server' })).toBeNull();
  });

  it('leaves other keys alone', () => {
    // Cheap, and it pins that the guard was added to the Escape branch rather
    // than swallowing the whole handler.
    openPanel();
    const panel = screen.getByRole('dialog', { name: 'Server' });

    fireEvent.keyDown(panel, { key: 'Enter' });
    fireEvent.keyDown(panel, { key: 'a' });

    expect(screen.getByRole('dialog', { name: 'Server' })).toBeTruthy();
  });

  it('closes only the restart confirm on the first Escape, and the panel on the second', () => {
    // THE INSTRUMENT for this cut. Red against the panel at cd10bcd3 (ungated
    // handler) and against any hook whose predicate answers true for a covered
    // dialog: the first Escape takes both layers, so the panel is already gone
    // by the mid-sequence assertion.
    //
    // Asserted as a SEQUENCE rather than an end state on purpose. Both presses
    // end with everything closed, so a final-state check cannot tell "the user
    // cancelled the restart and kept reading" from "the user lost both at
    // once" — the same trap the nested focus case fell into.
    openPanel();

    const restart = screen.getByRole('button', { name: 'Restart' });
    restart.focus();
    fireEvent.click(restart);

    const confirm = screen.getByRole('dialog', { name: 'Restart now?' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    // First Escape — answers the confirm, and nothing else.
    fireEvent.keyDown(confirm, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Restart now?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Server' })).toBeTruthy();
    // And the panel is usable again rather than merely present: focus is back on
    // the control that opened the confirm.
    expect(document.activeElement).toBe(restart);

    // Second Escape — now the panel is topmost again, so it takes it.
    fireEvent.keyDown(restart, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Server' })).toBeNull();
  });
});
