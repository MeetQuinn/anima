import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import ConfirmModal from './ConfirmModal';
import { BusyConfirmModal } from './restart-shared';

// Focus-lifecycle contract for the two independent destructive-confirm
// implementations (task #177). They keep separate visual and copy APIs, but
// share ONE focus primitive (`useDialogFocus`), so these assertions are written
// against both — a regression in the primitive must not be able to hide behind
// whichever dialog happens not to be covered.
//
// Scope note: this pins `ConfirmModal` and `BusyConfirmModal` ONLY. The other
// `aria-modal` dialogs in web/src are explicitly NOT cleared by this contract,
// including the two independent inline dialogs inside AgentFields.tsx and
// UsagePanel.tsx — files that also render ConfirmModal, and so must not be read
// as "fully accessible" on the strength of these tests.
//
// Runs in CI (`pnpm --dir web test`) and locally the same way.

function ConfirmHarness({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open confirm
      </button>
      <button type="button">decoy after trigger</button>
      <ConfirmModal
        open={open}
        busy={busy}
        title="Delete agent"
        description="This removes the agent and its history."
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}

function BusyHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open restart
      </button>
      <button type="button">decoy after trigger</button>
      {open && (
        <BusyConfirmModal
          kind="restart"
          runningNames={['nora']}
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe('ConfirmModal focus contract', () => {
  it('moves focus to Cancel on open', () => {
    render(<ConfirmHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open confirm' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('falls back to the dialog when Cancel is unavailable during a busy commit', () => {
    render(<ConfirmHarness busy />);
    fireEvent.click(screen.getByRole('button', { name: 'open confirm' }));
    // Cancel is disabled while busy, so focus must land on the dialog itself
    // rather than being left on the page underneath. Assert the real disabled
    // state first: if the button ever stops exposing native `disabled`, the
    // fallback below would silently stop being exercised.
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('names itself via aria-labelledby and aria-describedby', () => {
    render(<ConfirmHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open confirm' }));
    const dialog = screen.getByRole('dialog');

    const labelId = dialog.getAttribute('aria-labelledby');
    const describedId = dialog.getAttribute('aria-describedby');
    expect(labelId).toBeTruthy();
    expect(describedId).toBeTruthy();
    // The ids must resolve to the real title/description, not merely exist.
    expect(document.getElementById(labelId!)?.textContent).toBe('Delete agent');
    expect(document.getElementById(describedId!)?.textContent).toBe(
      'This removes the agent and its history.',
    );
  });

  it('contains Tab and Shift+Tab inside the dialog', () => {
    render(<ConfirmHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open confirm' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });

    // Forward from the last control wraps to the first, never to the page.
    confirm.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    // Backward from the first control wraps to the last.
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('returns focus to the invoker on close', () => {
    render(<ConfirmHarness />);
    const trigger = screen.getByRole('button', { name: 'open confirm' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(trigger);
  });

  // Milo's gate red on 7309dece. Opening while busy legitimately parks focus on
  // the dialog container. If the commit then finishes and the controls become
  // enabled while the dialog stays open, focus is still on the container — and
  // `root.contains(root)` is true, so an "am I inside?" test alone concludes
  // there is nothing to do and lets the key through to the page underneath.
  // The container has to be a boundary in both directions, not an interior.
  it('routes Tab and Shift+Tab off the container after busy clears', () => {
    const props = {
      open: true,
      title: 'Delete agent',
      description: 'This removes the agent and its history.',
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    };
    const { rerender } = render(<ConfirmModal {...props} busy />);

    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);

    // Commit finishes; buttons become enabled, focus stays where it was.
    rerender(<ConfirmModal {...props} busy={false} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(document.activeElement).toBe(dialog);

    // Backward off the container must land on the last control, not escape.
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    // Forward off the container must land on the first control.
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
  });
});

// Notice mode (`hideCancel`, PR #688): a single acknowledge button, nothing to
// decide. The focus contract still holds — the safe answer IS the only button,
// so initial focus, Tab containment and invoker restoration all bind to it.
// Milo's gate red on 02e37a89: removing the OK button's `initialFocusRef` left
// focus on the dialog container and every suite stayed green.
function NoticeHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open notice
      </button>
      <button type="button">decoy after trigger</button>
      <ConfirmModal
        open={open}
        title="Agent is running"
        description="Disabling never interrupts work in progress."
        variant="warn"
        confirmLabel="OK"
        confirmVariant="default"
        hideCancel
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

describe('ConfirmModal notice mode (hideCancel) focus contract', () => {
  it('moves focus to the single OK control on open, not the container', () => {
    render(<NoticeHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open notice' }));
    // There is no Cancel to receive focus; OK is the safe answer now.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));
  });

  it('keeps Tab and Shift+Tab on OK — the only stop in the cycle', () => {
    render(<NoticeHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open notice' }));
    const ok = screen.getByRole('button', { name: 'OK' });
    expect(document.activeElement).toBe(ok);

    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(ok);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ok);
  });

  it('returns focus to the invoker when OK closes the notice', () => {
    render(<NoticeHarness />);
    const trigger = screen.getByRole('button', { name: 'open notice' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(document.activeElement).toBe(trigger);
  });
});

describe('BusyConfirmModal focus contract', () => {
  it('moves focus to Cancel on open', () => {
    render(<BusyHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open restart' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('names itself via aria-labelledby and aria-describedby', () => {
    render(<BusyHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open restart' }));
    const dialog = screen.getByRole('dialog');

    const labelId = dialog.getAttribute('aria-labelledby');
    const describedId = dialog.getAttribute('aria-describedby');
    expect(labelId).toBeTruthy();
    expect(describedId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe('Restart now?');
    expect(document.getElementById(describedId!)?.textContent).toContain('is working');
  });

  it('contains Tab and Shift+Tab inside the dialog', () => {
    render(<BusyHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'open restart' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Restart now' });

    confirm.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('returns focus to the invoker on close', () => {
    render(<BusyHarness />);
    const trigger = screen.getByRole('button', { name: 'open restart' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(trigger);
  });
});

describe('shared primitive', () => {
  it('gives each dialog instance its own title/description ids', () => {
    // Two instances mounted at once must not collide on a fixed id, which is
    // what the retired hardcoded `busy-confirm-title` would have done.
    render(
      <>
        <ConfirmModal
          open
          title="First"
          description="First description"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
        <ConfirmModal
          open
          title="Second"
          description="Second description"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </>,
    );

    const [a, b] = screen.getAllByRole('dialog');
    expect(a!.getAttribute('aria-labelledby')).not.toBe(b!.getAttribute('aria-labelledby'));
    expect(a!.getAttribute('aria-describedby')).not.toBe(b!.getAttribute('aria-describedby'));
    // And each still resolves to its own text.
    expect(document.getElementById(a!.getAttribute('aria-labelledby')!)?.textContent).toBe('First');
    expect(document.getElementById(b!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Second',
    );
  });
});
