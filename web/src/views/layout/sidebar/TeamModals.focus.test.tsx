import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { recordFocusMoves } from '@/test/focus-moves';
import { CreateTeamModal, EditTeamModal } from './TeamModals';
import type { TeamConfig } from '@/api/teams';

// Focus and semantics contract for the team dialog and the home-folder picker
// layered over it — the nested-adoption cut that follows batch B-flat.
//
// This is the app's first pair of its OWN dialogs open at once. The picker
// portals to `document.body` at `z-[60]`, so it is not inside the team dialog's
// subtree; the shared hook's topmost-only Tab trap is what keeps the lower
// instance from hauling focus back out of the picker the user is looking at.
// `dialog-focus-stack.test.tsx` pins that mechanism with purpose-built doubles.
// This file is the first time the real components stand in for them.
//
// What each one had before, measured rather than assumed:
//   - TeamModal: `setTimeout(() => inputRef.current?.focus(), 0)` — the right
//     landing spot, a tick late, with no containment and no restore, and an
//     anonymous `role="dialog"`.
//   - The picker: no focus handling at all, and anonymous too. Opening it left
//     focus on Browse behind its backdrop, so the first Tab walked the team form
//     underneath a dialog covering it.
//
// Where a case mixes an instrument with a regression guard, it says which
// assertion is which. A restore case asserts focus LEFT the opener first:
// without that half it passes trivially against a dialog that never moved focus
// at all, which is the opposite of what it claims to measure.
//
// jsdom implements no native Tab movement, so a mid-dialog Tab is unobservable.
// What IS observable is whether the hook cancelled the key (`fireEvent` returns
// `dispatchEvent`'s boolean, so `false` is defaultPrevented) and where the
// boundary wrap put focus.
//
// Runs in CI (`pnpm --dir web test`) and locally the same way.

// The picker fetches directories and owns its own arrow-key row navigation.
// Stubbed to two plain buttons so these cases measure the dialog lifecycle
// around it, not the tree inside it.
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

// Never reached by these cases — mocked so a stray render cannot put a team
// write on the wire.
vi.mock('@/api/teams', () => ({
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
}));

const team = { id: 'content', name: 'Content', home: '/tmp/content' } as TeamConfig;

/** An outside opener plus the dialog it opens, so restore has somewhere to go. */
function CreateHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        New team
      </button>
      {open && <CreateTeamModal onClose={() => setOpen(false)} onCreated={() => setOpen(false)} />}
    </>
  );
}

function EditHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Edit this team
      </button>
      {open && (
        <EditTeamModal team={team} onClose={() => setOpen(false)} onSaved={() => setOpen(false)} />
      )}
    </>
  );
}

/** Open the create dialog and its folder picker, in the order a user does it. */
function openPicker() {
  render(<CreateHost />);
  fireEvent.click(screen.getByRole('button', { name: 'New team' }));
  const browse = screen.getByRole('button', { name: 'Browse' });
  // Focused first on purpose: a keyboard user reaches Browse by Tab and presses
  // Enter, and the hook records "focus came from here" from `activeElement`.
  // `fireEvent.click` alone moves no focus in jsdom, so without this the picker
  // would record the team dialog container and the restore case would be
  // measuring the harness instead of the app.
  browse.focus();
  fireEvent.click(browse);
  return { browse };
}

describe('Team dialog + home-folder picker — focus contract', () => {
  it('lands focus on the name field, in the same tick as the dialog', () => {
    // The old `setTimeout(…, 0)` left focus on the page for a tick after the
    // dialog appeared. No timers are advanced here on purpose: this asserts the
    // field holds focus by the time the caller can see the dialog at all.
    render(<CreateHost />);
    fireEvent.click(screen.getByRole('button', { name: 'New team' }));

    expect(document.activeElement).toBe(screen.getByPlaceholderText('e.g. Content'));
  });

  it('keeps Tab inside the team dialog at its boundaries', () => {
    render(<CreateHost />);
    const opener = screen.getByRole('button', { name: 'New team' });
    fireEvent.click(opener);

    const field = screen.getByPlaceholderText('e.g. Content');
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    // Shift+Tab off the first control wraps to the last one a keyboard can
    // reach, instead of landing on the sidebar behind the backdrop. "Create
    // team" is disabled until both fields are filled, so that last control is
    // Cancel — the shared `Button` keeps `tabindex="0"` while disabled, which is
    // why the hook filters on the property rather than the attribute.
    const backward = fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
    expect(backward).toBe(false);
    expect(document.activeElement).toBe(cancel);
    expect(document.activeElement).not.toBe(opener);

    const forward = fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(field);
  });

  it('returns focus to the control that opened it', () => {
    render(<CreateHost />);
    const opener = screen.getByRole('button', { name: 'New team' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('names itself with its heading and describes itself with the copy that carries the decision', () => {
    // Edit mode, because that is where the description is load-bearing: the
    // sentence that says a rename does not touch existing agents. Both ids are
    // resolved through the DOM rather than read back as strings — an
    // `aria-labelledby` pointing at nothing passes a string check and announces
    // nothing.
    render(<EditHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit this team' }));

    const dialog = screen.getByRole('dialog', { name: 'Edit team' });
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toContain("won't affect existing agents");
  });

  it('moves focus into the picker, which has no safe control of its own', () => {
    // Landing on the picker's own Close would mean Enter-on-open dismisses the
    // dialog the user just asked for, and everything below Close belongs to
    // DirectoryPicker. So the container is the landing spot — and it is a real
    // resting place, not a wrapper: Tab leaves it immediately.
    const { browse } = openPicker();

    const picker = screen.getByRole('dialog', { name: 'Choose home folder' });
    expect(document.activeElement).toBe(picker);
    expect(document.activeElement).not.toBe(browse);

    const forward = fireEvent.keyDown(picker, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('leaves the team dialog inert while the picker is over it', () => {
    // The reason the shared stack exists. Both instances have a capture-phase
    // Tab listener on `window`, and the picker is not inside the team dialog's
    // subtree, so without the topmost check the LOWER dialog also answers this
    // keypress: it sees "focus is outside me", cancels the key, and moves focus
    // to its own last control behind a dialog the user cannot see through.
    //
    // Asserted on the TRAIL, not the end state — measured, after the end-state
    // version of this case came out green against a hook with the topmost check
    // deleted. The team dialog registered first, so its listener runs first and
    // the picker's listener then pulls focus back: the final resting place is
    // identical either way, and the only difference is the control focus passed
    // through on the way. That control is behind an overlay, which is exactly
    // the defect.
    const { browse } = openPicker();
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();

    const teamDialog = screen.getByRole('dialog', { name: 'New team' });
    const moves = recordFocusMoves();
    const backward = fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    moves.stop();

    expect(backward).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel picking' }));
    expect(moves.targets.some((el) => teamDialog.contains(el))).toBe(false);
    expect(moves.targets).not.toContain(browse);
  });

  it('hands focus back to Browse when the picker closes, with the team dialog still open', () => {
    // Two halves, and they are not the same kind of assertion:
    //   - "focus left Browse, and comes back to it" is the INSTRUMENT. The
    //     picker had no focus handling at all, so focus never left Browse and
    //     the second half alone would have passed against the old file for the
    //     opposite reason.
    //   - "the team dialog is still open underneath" is a REGRESSION GUARD. It
    //     held before too. It is here because the close path that restores focus
    //     is the same one that could take the wrong dialog down with it.
    const { browse } = openPicker();
    expect(document.activeElement).not.toBe(browse);

    fireEvent.click(screen.getByRole('button', { name: 'Choose /tmp/picked' }));

    expect(screen.queryByRole('dialog', { name: 'Choose home folder' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New team' })).toBeTruthy();
    expect(document.activeElement).toBe(browse);
    // The pick landed, so the restore is not a consolation prize for a lost edit.
    expect(screen.getByPlaceholderText('e.g. ~/content')).toHaveProperty('value', '/tmp/picked');
  });
});

describe('Team dialog + home-folder picker — Escape dismissal', () => {
  // CHARACTERIZATION ONLY. This cut does not touch TeamModals; the pair is here
  // because it is the second answer to the same question the Server panel now
  // asks, and the reason the answer stays at the call site rather than in the
  // hook.
  //
  // Both layers are dismissed by ONE listener, on the team dialog, which routes
  // by its own state: picker first, dialog second. That is a different rule from
  // the panel's ("ignore Escape while covered") and reaches the same outcome,
  // because here the lower dialog owns the upper one's existence. A hook that
  // decided dismissal would have to encode both, plus the confirm's third rule
  // of refusing Escape mid-commit.
  //
  // Pinned so that giving the picker its own Escape handler later — an easy and
  // reasonable-looking change — cannot silently close both layers at once.

  it('closes the picker on the first Escape and the team dialog on the second', () => {
    const { browse } = openPicker();
    expect(screen.getByRole('dialog', { name: 'Choose home folder' })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Choose home folder' }), {
      key: 'Escape',
    });

    expect(screen.queryByRole('dialog', { name: 'Choose home folder' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New team' })).toBeTruthy();
    expect(document.activeElement).toBe(browse);

    fireEvent.keyDown(browse, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'New team' })).toBeNull();
  });

  it('closes the team dialog on Escape when no picker is open', () => {
    render(<CreateHost />);
    fireEvent.click(screen.getByRole('button', { name: 'New team' }));
    const dialog = screen.getByRole('dialog', { name: 'New team' });

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'New team' })).toBeNull();
  });
});
