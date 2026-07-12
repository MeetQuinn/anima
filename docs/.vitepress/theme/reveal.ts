/*
  Landing scroll-reveal lifecycle.

  CSS (landing.css) hides `.landing-home [data-reveal]` elements only while
  <html> carries `reveal-ready`, so the contract here is safety-first:

  - The hidden state is armed ONLY after the current document's reveal
    targets are registered with a live IntersectionObserver. A node that is
    never observed must never be hidden.
  - Leaving the landing page (VitePress keeps the Layout mounted across
    client-side navigation, so nothing remounts) must disarm the hidden
    state and drop the observer: the old observer only knows detached nodes,
    and a still-armed `reveal-ready` would blank a future landing tree that
    no observer is watching.
  - `refresh()` is therefore idempotent and route-driven: call it after
    every completed route change (next DOM tick) and it either re-arms
    against the nodes that exist now, or fully disarms when the current
    page is not the landing page.

  No-JS boundary: none of this runs without JS, so the static render never
  carries `reveal-ready` and is always fully visible.
*/

export interface RevealController {
  /** Re-arm against the current DOM (or disarm if no targets). */
  refresh(): void;
  /** Disarm and drop the observer. */
  dispose(): void;
}

export function createRevealController(): RevealController {
  let observer: IntersectionObserver | undefined;

  const dispose = () => {
    observer?.disconnect();
    observer = undefined;
    document.documentElement.classList.remove("reveal-ready");
  };

  const refresh = () => {
    dispose();
    if (typeof IntersectionObserver === "undefined") return;
    const targets = document.querySelectorAll<HTMLElement>(
      ".landing-home [data-reveal]",
    );
    if (targets.length === 0) return;
    observer = new IntersectionObserver(
      (entries, self) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-revealed");
          self.unobserve(entry.target);
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );
    for (const target of targets) observer.observe(target);
    // Arm the hidden state only now that every current target is observed.
    document.documentElement.classList.add("reveal-ready");
  };

  return { refresh, dispose };
}
