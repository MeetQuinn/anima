import { useEffect, useId, useRef } from 'react';

/**
 * Focus lifecycle for modal dialogs.
 *
 * Several independent dialog implementations share this primitive — the two
 * destructive confirms (`ConfirmModal`, `BusyConfirmModal`), the Activity image
 * lightbox and the token usage sheet, with the remaining `aria-modal` dialogs
 * migrating in batches. They keep separate visual and copy APIs on purpose, but
 * the focus contract must not drift between them, so it lives here once:
 *
 *   - on open, focus moves into the dialog, landing on the safe control;
 *   - Tab and Shift+Tab stay inside the dialog;
 *   - on close, focus returns to whatever opened it.
 *
 * Deliberately NOT here: Escape. Dismissal rules differ per dialog (some gate it
 * on a busy commit, one closes a nested picker first), so each call site owns its
 * own Esc handling and this hook owns focus only.
 *
 * The count of call sites is deliberately not written down — it changes with
 * every batch, and a number in a comment is a claim the next commit falsifies.
 * `git grep -l useDialogFocus -- web/src` is the answer that cannot go stale.
 *
 * Returns per-instance `titleId` / `descriptionId` from `useId()` rather than
 * fixed strings: a hardcoded id would make `aria-labelledby` ambiguous the
 * moment two instances coexist, which they now do.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Open instances, oldest first. Only the last one — the topmost dialog — traps
 * Tab and restores focus on close.
 *
 * Without this, every open instance ran its own `window` capture-phase Tab
 * listener and contained focus to its own dialog unconditionally. Two live
 * instances then both handled one keypress: a Tab pressed mid-way through a
 * nested confirm was cancelled by the OUTER instance and dragged through the
 * outer dialog's own first control on the way, because the confirm portals to
 * `document.body` and so is not inside the outer dialog's subtree. The visible
 * result is a Tab that does not advance inside the confirm the user is looking
 * at, plus focus/blur on a control they cannot see.
 *
 * "Topmost" is "most recently opened", which is what a modal stack means and
 * what every real sequence in this app produces: a dialog is opened by a control
 * inside the dialog under it, one commit later. The one ordering this does NOT
 * model is a parent and child dialog opening in the SAME commit — React runs
 * child effects first, so the child would register first and the parent would
 * win. No call site does that today; a call site that needs it should say so
 * rather than rely on this comment being read.
 */
const openDialogs: object[] = [];

function isTopmost(token: object): boolean {
  return openDialogs.length > 0 && openDialogs[openDialogs.length - 1] === token;
}

export interface DialogFocusResult<InitialFocus extends HTMLElement = HTMLButtonElement> {
  /**
   * Attach to the element carrying `role="dialog"`. Needs `tabIndex={-1}`.
   *
   * Stays `HTMLDivElement`: a narrower ref object goes into any wider element's
   * `ref` slot, so this already fits the `<section>` sheet as well as the `<div>`
   * dialogs. The only root it would not fit is a native `<dialog>`, which no call
   * site uses — and if one appears, its `ref` type is a compile error, not a
   * silent focus bug.
   */
  dialogRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Attach to the control that should hold focus when the dialog opens: the
   * cancel/dismiss button on a confirm, the first field on a form.
   *
   * Defaults to a button because every dialog on the hook today opens on one, but
   * a form dialog passes its own element type (`useDialogFocus<HTMLInputElement>`)
   * — landing a rename dialog's focus on Cancel instead of the field is a keyboard
   * user typing into nothing.
   */
  initialFocusRef: React.RefObject<InitialFocus | null>;
  /** Wire to the title element's `id` and the dialog's `aria-labelledby`. */
  titleId: string;
  /** Wire to the description element's `id` and the dialog's `aria-describedby`. */
  descriptionId: string;
}

export function useDialogFocus<InitialFocus extends HTMLElement = HTMLButtonElement>(
  open: boolean,
): DialogFocusResult<InitialFocus> {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<InitialFocus | null>(null);
  // Identity only — never read, only compared. A ref keeps it stable across
  // renders so the same instance keeps its place in the stack.
  const token = useRef<object>({});
  const baseId = useId();

  // Registration is its own effect on purpose: membership is about which dialog
  // owns the keyboard, not about focus, and keeping the push and its splice in
  // one place means neither of the effects below can leave a stale entry behind
  // by returning early.
  useEffect(() => {
    if (!open) return;
    const self = token.current;
    openDialogs.push(self);
    return () => {
      const at = openDialogs.lastIndexOf(self);
      if (at !== -1) openDialogs.splice(at, 1);
    };
  }, [open]);

  // Move focus in on open, and hand it back to the invoker on close/unmount.
  useEffect(() => {
    if (!open) return;

    // Captured for the cleanup: by the time it runs the dialog is usually
    // already unmounted, so reading the ref there would see null.
    const dialog = dialogRef.current;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // The safe control is the call site's choice. When it is unavailable —
    // ConfirmModal disables both buttons while a commit is in flight — fall back
    // to the dialog container so focus is never stranded on the page underneath,
    // which is what makes the dialog escapable by Tab.
    // Checked structurally rather than as `initial.disabled`: the element type is
    // the call site's choice now, and a `<div role="button">` has no such property
    // at all.
    const initial = initialFocusRef.current;
    const unavailable = initial !== null && 'disabled' in initial && Boolean(initial.disabled);
    const target = initial && !unavailable ? initial : dialog;
    target?.focus();

    return () => {
      // Restore deliberately does NOT consult the stack. A dialog closing while
      // another is open above it must not pull focus out of that one — and the
      // condition below already refuses, because focus is then inside the other
      // dialog: neither inside this one nor on `document.body`. Adding a
      // "something is above me" branch here would be a second gate for a case the
      // first one already holds, and an untestable one. Covered by "leaves focus
      // alone when the dialog underneath it closes".
      //
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
    const self = token.current;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      // A dialog under an open one is inert: it must not cancel keys, and it
      // must not move focus. Its own listener is still attached because it is
      // still mounted, which is exactly the bug this guard fixes.
      if (!isTopmost(self)) return;
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
