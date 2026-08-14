import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { useDialogFocus } from '@/hooks/useDialogFocus';
import { BusyConfirmModal } from './restart-shared';

// Topmost-dialog stack + call-site-typed initial focus for `useDialogFocus`.
//
// WHY THIS EXISTS: every open instance attaches its own capture-phase Tab
// listener on `window` and contains focus to its own dialog. With two instances
// live, a Tab pressed inside the upper dialog was also handled by the LOWER one,
// because a dialog that portals to `document.body` is not inside the other's
// subtree — so the lower instance saw "focus is outside me" and hauled it back.
// It cancelled keypresses that were nobody's boundary and moved focus through a
// control in the dialog underneath on its way.
//
// The real shapes this unblocks:
//   - ServerPanel hosts RestartButton / RuntimeUpgradeRow, both of which mount
//     BusyConfirmModal — itself a useDialogFocus instance, portaled to body.
//   - TeamModals renders its own dialog plus a second aria-modal picker portal,
//     both mounted at once.
//
// HOW IT IS ASSERTED: jsdom implements no native Tab movement, so "focus moved
// to the next control" is not observable for a mid-dialog keypress — nothing
// moves either way. Two things ARE observable, and both are properties of the
// bug: whether the hook CANCELLED the event (`fireEvent` returns
// `dispatchEvent`'s boolean, so `false` means defaultPrevented), and every
// element focus passed through (recorded via `focusin`). Boundary keypresses are
// additionally asserted by focus identity, which the hook does move.
//
// WHICH CASES ARE INSTRUMENTS, and against what. Every mechanism in the hook is
// pinned by at least one case that goes red when that mechanism is removed. The
// lists below are measured against each earlier head of this PR and against
// hand-built variants of the current hook, not reasoned about:
//   - pre-change hook (46b83c9c), no stack at all — 7 red: "leaves a mid-dialog
//     Tab alone", "moves focus nowhere", "never touches a control underneath",
//     "does not restore from body-focus", both one-at-a-time cases, "skips
//     claims whose invoker went with its own dialog".
//   - ee5cfba8, Tab stack but restore not stack-aware — 4 red: "does not restore
//     from body-focus", both one-at-a-time cases, "skips claims".
//   - c6030732, stack-aware restore deferred by a microtask — 4 red: both
//     one-at-a-time cases, "both dialogs unmount together", "skips claims". The
//     upper dialog outlives the commit, so a one-shot deferred callback cannot
//     carry the restore chain.
//   - variant that drops a non-topmost dialog's claim instead of filing it — the
//     same 4 red. The claim chain is what those four cases actually measure.
//   - variant that takes the oldest claim without checking the invoker is still
//     connected — 1 red: "skips claims". That case is the only shape in the
//     suite where the oldest claim is the wrong one, which is why it exists.
// The StrictMode case is a guard, not an instrument: green against every variant
// above, because a lone dialog is topmost and restores synchronously. It is here
// so that deferring restoration again — which would make the dev remount hand
// focus back to the page — fails loudly.
// The rest are regression guards: green before and after by design, so that
// topmost behavior cannot be bought by breaking single-dialog containment or
// invoker restore. The two initial-focus cases are typecheck instruments, not
// runtime ones — a button-typed ref on an <input> is a compile error, which is
// the whole point of the widening.
//
// NOTE: web vitest is not wired into CI yet (#344) - run locally.

/** Records every element focus lands on, in order. */
function recordFocusMoves() {
  const targets: Element[] = [];
  const onFocusIn = (event: Event) => {
    if (event.target instanceof Element) targets.push(event.target);
  };
  document.addEventListener('focusin', onFocusIn, true);
  return { targets, stop: () => document.removeEventListener('focusin', onFocusIn, true) };
}

/** An outer dialog on the hook, hosting a nested BusyConfirmModal. ServerPanel's shape. */
function OuterHostingConfirm() {
  const { dialogRef, initialFocusRef } = useDialogFocus(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Server" tabIndex={-1}>
      <button type="button" ref={initialFocusRef}>
        Close server panel
      </button>
      <button type="button" onClick={() => setConfirmOpen(true)}>
        Restart
      </button>
      {confirmOpen && (
        <BusyConfirmModal
          kind="restart"
          runningNames={['nora']}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

/** The lower dialog on its own, without the nested confirm inside it. */
function PanelDialog({ onOpenConfirm }: { onOpenConfirm: () => void }) {
  const { dialogRef, initialFocusRef } = useDialogFocus(true);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Server" tabIndex={-1}>
      <button type="button" ref={initialFocusRef}>
        Close server panel
      </button>
      <button type="button" onClick={onOpenConfirm}>
        Restart
      </button>
    </div>
  );
}

/**
 * Outside opener → lower dialog → upper confirm, with each layer closable on its
 * own. The confirm is a SIBLING of the panel here, so the panel can close while
 * the confirm stays open — the state a nested render cannot reach.
 */
function StackHost() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setPanelOpen(true)}>
        Open server panel
      </button>
      <button type="button" onClick={() => setPanelOpen(false)}>
        Close panel from outside
      </button>
      {panelOpen && <PanelDialog onOpenConfirm={() => setConfirmOpen(true)} />}
      {confirmOpen && (
        <BusyConfirmModal
          kind="restart"
          runningNames={['nora']}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}

/** A plain hook-backed dialog with one control, for stacking more than two deep. */
function StackDialog({ label, children }: { label: string; children?: React.ReactNode }) {
  const { dialogRef, initialFocusRef } = useDialogFocus(true);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      <button type="button" ref={initialFocusRef}>
        Close {label}
      </button>
      {children}
    </div>
  );
}

/**
 * Three dialogs, each opened from the one below it and each closable on its own.
 * Only shape in the suite where the first claim filed is NOT the one that can be
 * restored to — B's opener lives inside A, and A closes before the stack drains.
 */
function DeepStackHost() {
  const [open, setOpen] = useState({ a: false, b: false, c: false });
  const set = (patch: Partial<typeof open>) => setOpen((prev) => ({ ...prev, ...patch }));
  return (
    <>
      <button type="button" onClick={() => set({ a: true })}>
        Open A
      </button>
      <button type="button" onClick={() => set({ a: false })}>
        Close A from outside
      </button>
      <button type="button" onClick={() => set({ b: false })}>
        Close B from outside
      </button>
      {open.a && (
        <StackDialog label="A">
          <button type="button" onClick={() => set({ b: true })}>
            Open B
          </button>
        </StackDialog>
      )}
      {open.b && (
        <StackDialog label="B">
          <button type="button" onClick={() => set({ c: true })}>
            Open C
          </button>
        </StackDialog>
      )}
      {open.c && (
        <StackDialog label="C">
          <button type="button" onClick={() => set({ c: false })}>
            Done with C
          </button>
        </StackDialog>
      )}
    </>
  );
}

/** The real ServerPanel shape: the confirm is a child, so both go at once. */
function NestedHostWithOpener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open server panel
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Close panel from outside
      </button>
      {open && <OuterHostingConfirm />}
    </>
  );
}

describe('useDialogFocus — topmost dialog wins', () => {
  it('leaves a mid-dialog Tab in the upper dialog alone', () => {
    render(<OuterHostingConfirm />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);

    // Cancel is the confirm's first control, so going forward it is not a
    // containment boundary: nobody may cancel this keypress, or the user cannot
    // Tab from Cancel to Restart now at all.
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(cancel);
  });

  it('moves focus nowhere when the keypress is nobody"s boundary', () => {
    render(<OuterHostingConfirm />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    const rec = recordFocusMoves();
    fireEvent.keyDown(window, { key: 'Tab' });
    rec.stop();

    // The end state alone would hide the defect: the lower dialog pulled focus to
    // its own first control and the upper one pulled it straight back, so
    // `activeElement` looked untouched while a real browser fired focus/blur on a
    // control the user cannot see.
    expect(rec.targets).toEqual([]);
  });

  it('never touches a control in the dialog underneath', () => {
    render(<OuterHostingConfirm />);
    const restart = screen.getByRole('button', { name: 'Restart' });
    const closePanel = screen.getByRole('button', { name: 'Close server panel' });
    fireEvent.click(restart);

    // Walk the boundary in both directions; nothing in the lower dialog may be
    // focused at any point along the way, not just at the end.
    const rec = recordFocusMoves();
    for (const shiftKey of [false, true, false]) {
      fireEvent.keyDown(window, { key: 'Tab', shiftKey });
    }
    rec.stop();

    expect(rec.targets).not.toContain(closePanel);
    expect(rec.targets).not.toContain(restart);
  });

  it('still wraps at the upper dialog"s own boundaries', () => {
    // Regression guard: containment must survive the fix, not just stop leaking.
    render(<OuterHostingConfirm />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Restart now' });

    confirm.focus();
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(cancel);

    expect(fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(confirm);
  });

  it('hands containment back to the lower dialog once the upper one closes', () => {
    // Regression guard: leaving the stack in a wrong state would show up here.
    render(<OuterHostingConfirm />);
    const closePanel = screen.getByRole('button', { name: 'Close server panel' });
    const restart = screen.getByRole('button', { name: 'Restart' });

    fireEvent.click(restart);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();

    restart.focus();
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(closePanel);
    expect(fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(restart);
  });

  it('returns focus to the control that opened the upper dialog', () => {
    // Regression guard for the restore half of the contract.
    render(<OuterHostingConfirm />);
    const restart = screen.getByRole('button', { name: 'Restart' });
    restart.focus();
    fireEvent.click(restart);
    expect(document.activeElement).not.toBe(restart);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(restart);
  });

  it('contains a single dialog exactly as before, with no stack to consult', () => {
    // Regression guard: the fix must not need a second dialog to work.
    render(<OuterHostingConfirm />);
    const closePanel = screen.getByRole('button', { name: 'Close server panel' });
    const restart = screen.getByRole('button', { name: 'Restart' });
    expect(document.activeElement).toBe(closePanel);

    expect(fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(restart);
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(closePanel);
  });

  it('does not restore from body-focus while a dialog is open above', () => {
    // Milo's red on ee5cfba8, and the case that killed "the existing condition
    // already covers it": focus is normally inside the upper dialog, but when the
    // upper dialog's focused control is removed or disabled, focus falls to
    // `document.body` — an explicit restore branch. The lower dialog then hauled
    // focus to its own opener, behind a dialog the user is still looking at.
    render(<StackHost />);
    const opener = screen.getByRole('button', { name: 'Open server panel' });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    cancel.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByRole('button', { name: 'Close panel from outside' }));
    expect(screen.queryByRole('button', { name: 'Close server panel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeTruthy();

    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).toBe(document.body);
  });

  it('returns focus to the outside opener when both dialogs unmount together', () => {
    // The other half of the stack-aware restore: skipping restore for a
    // non-topmost dialog must not strand focus when the whole tree goes at once.
    render(<NestedHostWithOpener />);
    const opener = screen.getByRole('button', { name: 'Open server panel' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close panel from outside' }));
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to the outside opener when the dialogs close one at a time', () => {
    // Milo's second red, on c6030732. The lower dialog closes first and correctly
    // moves nothing — but it holds the only record of where focus came from. The
    // upper dialog closes in a LATER commit, and its own invoker is the Restart
    // button that went with the lower dialog, so restoring "its" focus reaches a
    // disconnected element. Dropping the lower dialog's record leaves focus on
    // `body` with no owner; nothing scheduled inside the first commit can carry
    // it, because the upper dialog outlives that commit.
    render(<StackHost />);
    const opener = screen.getByRole('button', { name: 'Open server panel' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    fireEvent.click(screen.getByRole('button', { name: 'Close panel from outside' }));
    expect(screen.queryByRole('button', { name: 'Close server panel' })).toBeNull();
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(cancel);
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to the outside opener after a one-at-a-time close from body-focus', () => {
    // Same sequence with focus dropped to `body` in between — the state that made
    // the first restore steal possible. The chain still has to end on the opener.
    render(<StackHost />);
    const opener = screen.getByRole('button', { name: 'Open server panel' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close panel from outside' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(cancel);
    expect(document.activeElement).toBe(opener);
  });

  it('skips claims whose invoker went with its own dialog', () => {
    // Three deep, closed middle-out. The FIRST claim filed belongs to B, whose
    // opener is a button inside A — and A closes before the stack drains, so that
    // claim points at a detached control. Taking the oldest claim blindly would
    // focus nothing at all; the still-connected outside opener is the one place
    // the user can carry on from.
    render(<DeepStackHost />);
    const opener = screen.getByRole('button', { name: 'Open A' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open C' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close B from outside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close A from outside' }));
    expect(screen.getByRole('dialog', { name: 'C' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Done with C' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus alone when the dialog underneath it closes', () => {
    // Same shape as the body-focus case above, but with focus still inside the
    // upper dialog — the branch that made the missing stack check look redundant.
    render(<StackHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Open server panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(screen.getByRole('button', { name: 'Close panel from outside' }));
    expect(screen.queryByRole('button', { name: 'Close server panel' })).toBeNull();
    expect(document.activeElement).toBe(cancel);
  });
});

describe('useDialogFocus — StrictMode', () => {
  it('keeps focus inside the dialog through the dev remount', () => {
    // StrictMode is on in `main.tsx`, so in dev every effect mounts, tears down
    // and mounts again. The teardown queues a restore like any close would; if it
    // ran, the dialog would open and immediately throw focus back to the page.
    // The stack is what tells them apart — the same instance is registered again.
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    render(
      <StrictMode>
        <OuterHostingConfirm />
      </StrictMode>,
    );

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close server panel' }));
    opener.remove();
  });
});

describe('useDialogFocus — initial focus is not button-only', () => {
  // Both cases below pass against the pre-change hook at runtime — an <input>
  // has `.disabled` just like a button does. Their instrument is `tsc`: on the
  // old signature these refs are two compile errors, which is what the widening
  // buys. They are here so the runtime behavior of a non-button target is pinned
  // too, since nothing else in the suite mounts one.
  function FormDialog({ busy = false }: { busy?: boolean }) {
    const { dialogRef, initialFocusRef } = useDialogFocus<HTMLInputElement>(true);
    return (
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Rename" tabIndex={-1}>
        <input ref={initialFocusRef} aria-label="New name" disabled={busy} />
        <button type="button" disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }

  it('lands focus on a form dialog"s first field', () => {
    render(<FormDialog />);
    expect(document.activeElement).toBe(screen.getByLabelText('New name'));
  });

  it('still falls back to the container when the initial control is disabled', () => {
    render(<FormDialog busy />);
    // Every control is disabled, so focus must park on the dialog itself rather
    // than stay on the page underneath. The structural `disabled` check must not
    // have been dropped along with the button type.
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});
