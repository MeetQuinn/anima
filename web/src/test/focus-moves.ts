/**
 * Records every element focus lands on, in order.
 *
 * jsdom implements no native Tab movement, so "focus moved to the next control"
 * is not observable for a mid-dialog keypress — nothing moves either way. What
 * IS observable is every focus the code under test performs itself, and for the
 * shared dialog focus stack that is the whole bug: a dialog underneath an open
 * one used to answer a keypress that was nobody's boundary and drag focus
 * through one of its own controls on the way. The end state can look correct
 * while that happened, because the dialog above then pulls focus back — so a
 * final-state assertion cannot see it and the trail has to be recorded.
 *
 * Capture phase, on `document`, because `focusin` from a portaled dialog does
 * not bubble through the React tree the test rendered.
 */
export function recordFocusMoves(): { targets: Element[]; stop: () => void } {
  const targets: Element[] = [];
  const onFocusIn = (event: Event) => {
    if (event.target instanceof Element) targets.push(event.target);
  };
  document.addEventListener('focusin', onFocusIn, true);
  return { targets, stop: () => document.removeEventListener('focusin', onFocusIn, true) };
}
