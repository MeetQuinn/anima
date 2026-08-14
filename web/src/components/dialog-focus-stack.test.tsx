import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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
// WHICH CASES ARE INSTRUMENTS: three cases below are red against the pre-change
// hook — "leaves a mid-dialog Tab alone", "moves focus nowhere", and "never
// touches a control in the dialog underneath". The rest are regression guards:
// they pass before and after by design, and exist so the fix cannot buy topmost
// behavior by breaking single-dialog containment or invoker restore. The two
// initial-focus cases are typecheck instruments, not runtime ones — a button ref
// on an <input> is a compile error, which is the whole point of the widening.
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

  it('leaves focus alone when the dialog underneath it closes', () => {
    // The hook's restore path deliberately has no stack check. This is why it
    // does not need one: the existing "focus is still mine to move" condition
    // already refuses, because focus is inside the other dialog.
    function TwoSiblingDialogs() {
      const [panelOpen, setPanelOpen] = useState(true);
      const [confirmOpen, setConfirmOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setPanelOpen(false)}>
            Dismiss panel from outside
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

    render(<TwoSiblingDialogs />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss panel from outside' }));
    expect(screen.queryByRole('button', { name: 'Close server panel' })).toBeNull();
    expect(document.activeElement).toBe(cancel);
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
