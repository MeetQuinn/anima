import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AddKbModal, ConfirmDeleteModal, RenameKbModal } from './KbModals';
import type { KbView } from '@shared/kb';

// Focus contract for the three sidebar KB dialogs, which adopt `useDialogFocus`
// in batch B-flat of the residual `aria-modal` work.
//
// What each one had before, measured rather than assumed:
//   - AddKbModal: no focus handling at all. Opening it left focus on the sidebar
//     "+" behind the backdrop, so the first Tab walked the page underneath.
//   - RenameKbModal: `setTimeout(() => inputRef.current?.focus(), 0)` — the right
//     landing spot, a tick late, with no containment and no restore.
//   - ConfirmDeleteModal: no focus handling, on a destructive confirm.
// So every case below is an instrument: it fails against the pre-change file,
// not just against a hypothetical regression.
//
// Each restore case asserts focus LEFT the opener before asserting it comes
// back. Without that first half a restore assertion is not an instrument at all:
// a dialog with no focus handling never moves focus off the opener, so "focus is
// on the opener afterwards" passes trivially. Measured, not assumed — two of
// these cases were green against the pre-change file until the first half went in.
//
// jsdom implements no native Tab movement, so a mid-dialog Tab is unobservable.
// What IS observable is the boundary wrap, where the hook moves focus itself.
//
// NOTE: web vitest is not wired into CI yet (issue #344) - run locally.

// The picker owns its own arrow-key row navigation and fetches directories.
// Stubbed to two plain buttons so these cases measure the dialog's focus
// lifecycle rather than the picker's.
vi.mock('@/components/DirectoryPicker', () => ({
  default: ({ onCancel }: { onCancel: () => void }) => (
    <div>
      <button type="button">Home</button>
      <button type="button" onClick={onCancel}>
        Cancel picking
      </button>
    </div>
  ),
}));

const kb: KbView = { id: 'notes', label: 'Notes', path: '/tmp/notes', teamId: 'team' } as KbView;

/** An outside opener plus the dialog it opens, so restore has somewhere to go. */
function RenameHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Rename knowledge base
      </button>
      {open && (
        <RenameKbModal
          kb={kb}
          busy={false}
          error={null}
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DeleteHost({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Remove knowledge base
      </button>
      {open && (
        <ConfirmDeleteModal
          kb={kb}
          busy={busy}
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AddHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Add knowledge base
      </button>
      {open && <AddKbModal teamId="team" onClose={() => setOpen(false)} onAdded={() => {}} />}
    </>
  );
}

describe('KB sidebar dialogs — focus contract', () => {
  it('lands rename focus on the name field, in the same tick as the dialog', () => {
    // The old `setTimeout(…, 0)` meant focus was still on the page for a tick
    // after the dialog appeared. No timers are advanced here on purpose: this
    // asserts the field has focus by the time the caller can see the dialog.
    render(<RenameHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename knowledge base' }));

    expect(document.activeElement).toBe(screen.getByDisplayValue('Notes'));
  });

  it('keeps Tab inside the rename dialog at its boundaries', () => {
    render(<RenameHost />);
    const opener = screen.getByRole('button', { name: 'Rename knowledge base' });
    fireEvent.click(opener);

    const field = screen.getByDisplayValue('Notes');
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    // Shift+Tab off the first control wraps to the last, instead of landing on
    // the sidebar control behind the backdrop.
    const wrapped = fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
    expect(wrapped).toBe(false);
    expect(document.activeElement).not.toBe(opener);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    // Save is disabled until the label actually changes, so the last control a
    // keyboard can reach is Cancel; a forward Tab from there wraps to the field.
    // The shared `Button` keeps `tabindex="0"` while disabled, so "last" was the
    // disabled Save before the hook started filtering on the property, and the
    // wrap moved nothing at all.
    cancel.focus();
    const forward = fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(field);
  });

  it('wraps past a disabled Save to the control a keyboard can reach', () => {
    render(<RenameHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename knowledge base' }));

    const field = screen.getByDisplayValue('Notes');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(save.getAttribute('tabindex')).toBe('0');

    const wrapped = fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
    expect(wrapped).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('returns focus to the control that opened the rename dialog', () => {
    render(<RenameHost />);
    const opener = screen.getByRole('button', { name: 'Rename knowledge base' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('lands delete focus on Cancel, never on Remove', () => {
    // Also the runtime proof that a ref reaches the DOM node through the shared
    // `Button` wrapper — the typecheck alone would not tell us that.
    render(<DeleteHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove knowledge base' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Remove' }));
  });

  it('falls back to the delete dialog itself while the removal is in flight', () => {
    // Both controls are disabled mid-commit, so there is no safe control to land
    // on. Focus must still leave the page underneath, or the dialog is escapable
    // by Tab while it is doing the destructive thing.
    render(<DeleteHost busy />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove knowledge base' }));

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('returns focus to the control that opened the delete dialog', () => {
    render(<DeleteHost />);
    const opener = screen.getByRole('button', { name: 'Remove knowledge base' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('moves focus into the add dialog, which has no safe control of its own', () => {
    // Every control inside belongs to DirectoryPicker, so the dialog container is
    // the landing spot. It is a real resting place: Tab leaves it immediately,
    // and it is what keeps focus off the sidebar behind the backdrop.
    render(<AddHost />);
    const opener = screen.getByRole('button', { name: 'Add knowledge base' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);

    const forward = fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Home' }));
  });

  it('returns focus to the control that opened the add dialog', () => {
    render(<AddHost />);
    const opener = screen.getByRole('button', { name: 'Add knowledge base' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel picking' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
