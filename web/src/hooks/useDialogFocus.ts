import { useEffect, useId, useRef } from 'react';

/**
 * Focus lifecycle for modal confirm dialogs.
 *
 * Two independent confirm implementations exist — `ConfirmModal` (per-agent and
 * global destructive actions) and `BusyConfirmModal` (restart / upgrade). They
 * keep separate visual and copy APIs on purpose, but the focus contract must not
 * drift between them, so it lives here once:
 *
 *   - on open, focus moves into the dialog, landing on the safe choice (Cancel);
 *   - Tab and Shift+Tab stay inside the dialog;
 *   - on close, focus returns to whatever opened it.
 *
 * Returns per-instance `titleId` / `descriptionId` from `useId()` rather than
 * fixed strings: five call sites render these dialogs, and a hardcoded id would
 * make `aria-labelledby` ambiguous the moment two instances coexist.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogFocusResult {
  /** Attach to the element carrying `role="dialog"`. Needs `tabIndex={-1}`. */
  dialogRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the cancel/dismiss control — the safe landing spot on open. */
  initialFocusRef: React.RefObject<HTMLButtonElement | null>;
  /** Wire to the title element's `id` and the dialog's `aria-labelledby`. */
  titleId: string;
  /** Wire to the description element's `id` and the dialog's `aria-describedby`. */
  descriptionId: string;
}

export function useDialogFocus(open: boolean): DialogFocusResult {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();

  // Move focus in on open, and hand it back to the invoker on close/unmount.
  useEffect(() => {
    if (!open) return;

    // Captured for the cleanup: by the time it runs the dialog is usually
    // already unmounted, so reading the ref there would see null.
    const dialog = dialogRef.current;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Cancel is the safe default for a destructive confirm. When it is
    // unavailable — ConfirmModal disables both buttons while a commit is in
    // flight — fall back to the dialog container so focus is never stranded on
    // the page underneath, which is what makes the dialog escapable by Tab.
    const cancel = initialFocusRef.current;
    const target = cancel && !cancel.disabled ? cancel : dialog;
    target?.focus();

    return () => {
      // Only restore if focus is still ours to move; if something else took it
      // in the meantime, stealing it back would be the more surprising behavior.
      const active = document.activeElement;
      const stillInside = active instanceof Node && dialog?.contains(active);
      if (invoker && (stillInside || active === document.body)) invoker.focus();
    };
  }, [open]);

  // Contain Tab / Shift+Tab. Listener sits on the window in capture phase so it
  // still fires if focus has escaped the dialog subtree.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;

      const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (nodes.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }

      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);

      // The container itself is a reachable resting place, not just a wrapper:
      // opening while busy focuses it, and it keeps focus if the controls are
      // enabled later while the dialog stays open. `root.contains(root)` is
      // true, so treating that as "already inside" would let Tab fall through
      // to the page underneath — it must be handled as a boundary in both
      // directions instead.
      const atRoot = active === root;

      if (event.shiftKey) {
        if (!inside || atRoot || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || atRoot || active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  return {
    dialogRef,
    initialFocusRef,
    titleId: `${baseId}-title`,
    descriptionId: `${baseId}-description`,
  };
}
