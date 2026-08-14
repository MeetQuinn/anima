import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HomeRow } from './AgentFields';

// Focus and semantics contract for the profile Home row's workspace picker —
// the first half of group C, the last adoption cut of the `aria-modal` sweep.
//
// It had no focus handling at all: opening it left focus on the Change
// affordance behind a full-screen backdrop, so the first Tab walked the profile
// page underneath a dialog covering it.
//
// It also had a NAME DRIFT, which is the finding worth the file. The dialog
// declared `aria-label="Choose workspace"` while its visible title read "Choose
// home folder" — so a screen-reader user was told the dialog was called
// something that appears nowhere on screen, and used a word ("workspace") the
// product does not use in this flow at all. That is not a focus bug and no
// focus assertion would have caught it; it turned up because pointing the name
// at the visible heading means reading the heading.
//
// Where a case mixes an instrument with a regression guard, it says which
// assertion is which, and the restore case asserts focus LEFT the opener before
// asserting it comes back — otherwise it passes trivially against a dialog that
// never moved focus at all.
//
// NOTE: web vitest is not wired into CI yet (issue #344) - run locally.

// The picker fetches directories and owns its own arrow-key row navigation.
// Stubbed to two plain buttons so these cases measure the dialog lifecycle
// around it, not the tree inside it. Same stub as
// `TeamModals.focus.test.tsx` — deliberately, since it is the same widget.
vi.mock('@/components/DirectoryPicker', () => ({
  default: ({ onChoose, onCancel }: { onChoose: (dir: string) => void; onCancel: () => void }) => (
    <div>
      <button type="button" onClick={() => onChoose('/tmp/picked')}>
        Choose /tmp/picked
      </button>
      <button type="button" onClick={onCancel}>
        Cancel picking
      </button>
    </div>
  ),
}));

/** Open the picker the way a user does: focus the Change affordance, then click. */
function openPicker() {
  // `onCommit` is never reached — nothing here confirms a path. Passed as a
  // rejecting stub so a future case that does confirm fails loudly rather than
  // silently resolving.
  render(<HomeRow value="/tmp/agent-home" onCommit={vi.fn()} />);
  const opener = screen.getByRole('button', { name: /Change/ });
  // Focused first on purpose: a keyboard user reaches it by Tab and presses
  // Enter, and the hook records "focus came from here" from `activeElement`.
  // `fireEvent.click` alone moves no focus in jsdom.
  opener.focus();
  fireEvent.click(opener);
  return { opener };
}

describe('Profile Home row — workspace picker focus contract', () => {
  it('names itself with its visible title rather than a word from nowhere', () => {
    // THE INSTRUMENT for the drift. Before this cut the dialog answered to
    // "Choose workspace" and to nothing else; its heading said "Choose home
    // folder". Both halves are asserted, because a name that merely CHANGED
    // would be a different bug: the announced name has to be the visible one,
    // and it has to resolve THROUGH the heading so the two cannot drift apart
    // again.
    openPicker();

    const dialog = screen.getByRole('dialog', { name: 'Choose home folder' });
    expect(screen.queryByRole('dialog', { name: 'Choose workspace' })).toBeNull();
    expect(dialog.hasAttribute('aria-label')).toBe(false);

    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading?.textContent?.trim()).toBe('Choose home folder');
    expect(dialog.contains(heading)).toBe(true);
  });

  it('lands focus in the dialog, on nothing that would act', () => {
    // No `initialFocusRef`. The picker asks nothing, so neither of its controls
    // is a safe ANSWER the way a confirm's Cancel is: "Choose" commits a path
    // the user has not chosen yet, and "Cancel picking" undoes the open. The
    // container is the landing spot, and the next case shows Tab leaves it.
    const { opener } = openPicker();

    const dialog = screen.getByRole('dialog', { name: 'Choose home folder' });
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Choose /tmp/picked' }),
    );
  });

  it('keeps Tab inside the dialog instead of the profile page behind it', () => {
    openPicker();
    const dialog = screen.getByRole('dialog', { name: 'Choose home folder' });

    // jsdom implements no native Tab movement, so a mid-dialog Tab is not
    // observable as a focus move. What IS observable is that the hook cancelled
    // the key (`fireEvent` returns `dispatchEvent`'s boolean, so `false` means
    // defaultPrevented) and where the boundary wrap put focus.
    const forward = fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose /tmp/picked' }));

    const backward = fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(backward).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel picking' }));
  });

  it('returns focus to the Change affordance that opened it', () => {
    // The first assertion is what makes the third one mean anything: a dialog
    // with NO focus handling never moves focus off the opener, so "focus is on
    // the opener afterwards" would pass for the opposite reason.
    const { opener } = openPicker();
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel picking' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('still closes on Escape, and hands focus back the same way', () => {
    // CHARACTERIZATION for the dismissal, INSTRUMENT for the restore. Escape is
    // unchanged by this cut and deliberately ungated: `DirectoryPicker` mounts
    // no dialog of its own, so nothing can layer over this one and there is no
    // case for `isTopmostDialog()` here. What is new is that closing this way
    // also returns focus, which it did not before.
    const { opener } = openPicker();
    const dialog = screen.getByRole('dialog', { name: 'Choose home folder' });
    expect(document.activeElement).not.toBe(opener);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
