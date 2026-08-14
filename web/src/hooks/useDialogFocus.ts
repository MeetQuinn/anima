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

/**
 * Unfinished focus restorations, from dialogs that closed underneath an open one.
 *
 * A dialog that closes while another is open above it must not move focus — its
 * invoker sits behind the dialog the user is looking at. But it still holds the
 * only record of where focus came from, and dropping that record strands focus
 * on `document.body` the moment the dialog above it closes too: by then that one
 * is restoring to an invoker that was inside the dialog already gone. (Milo's
 * second red, on c6030732: the two closes happen in separate commits, so nothing
 * scheduled inside one commit can carry the chain.)
 *
 * So the claim is kept instead, and whichever instance closes while it owns the
 * page's focus — the topmost one — hands focus to the first filed claim whose
 * invoker is still connected. That is the dialog nearest the page, because a
 * deeper dialog's opener lived inside the one that closed under it.
 */
interface PendingRestore {
  invoker: HTMLElement | null;
  dialog: HTMLElement | null;
}

const pendingRestores: PendingRestore[] = [];

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

  // Stack membership and focus live in ONE effect so that "was I topmost when I
  // closed" can be answered at cleanup time. Splitting them meant the answer
  // depended on which cleanup React happened to run first, which is not a fact
  // this hook should be built on.
  useEffect(() => {
    if (!open) return;

    const self = token.current;
    openDialogs.push(self);

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
      const at = openDialogs.lastIndexOf(self);
      const wasTopmost = at === openDialogs.length - 1;
      if (at !== -1) openDialogs.splice(at, 1);

      // Every close files a claim: "focus came from here". A dialog closing
      // underneath an open one files it and stops — moving focus would pull the
      // user out of the dialog above. The claim is what makes that safe rather
      // than lossy; it is still there when the dialog above closes.
      pendingRestores.push({ invoker, dialog });
      if (!wasTopmost) return;

      // Closing while topmost means this instance owned the page's focus, so it
      // is the one that has to hand it back — for itself and for anything that
      // closed underneath it earlier. Claims are consumed in the order they were
      // filed, which is closing order; the last dialog to close is always topmost,
      // so the list never outlives the stack that produced it.
      const claims = pendingRestores.splice(0, pendingRestores.length);

      // Only restore if focus is still ours to move; if something else took it in
      // the meantime, stealing it back would be the more surprising behavior.
      // "Ours" covers every dialog in the chain, not just this one.
      const active = document.activeElement;
      const ours =
        active === document.body ||
        !(active instanceof Node) ||
        claims.some((claim) => claim.dialog?.contains(active));
      if (!ours) return;

      // The first claim with a connected invoker wins. Later claims point at
      // controls that were inside dialogs which have since closed, so they are
      // skipped rather than focused into nothing.
      claims.find((claim) => claim.invoker?.isConnected)?.invoker?.focus();
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
