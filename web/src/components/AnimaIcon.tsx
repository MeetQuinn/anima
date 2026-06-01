/**
 * Anima brand mark — the Ember mark (open halo + glowing core), matching the
 * docs favicon/nav logo and the public site. Rendered as an inline SVG so it
 * scales crisply at any size and inherits `currentColor` from its parent
 * context. Uses the wide-gap geometry (116° opening) so the halo notch — the
 * mark's identity — survives at small chrome sizes (~16px).
 *
 * Color is surface-aware via `currentColor`: use `text-accent` (rust) on
 * light surfaces (mobile nav, onboarding) and `text-text-on-spine` (cream) on
 * the dark spine (sidebar) — rust reads muddy on dark, cream stays crisp.
 *
 * Usage: <AnimaIcon className="h-4 w-4 text-accent" />
 */
export default function AnimaIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="currentColor" className={className} aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="5.5"
        d="M48.11 22.93a19 19 0 1 1-32.22 0"
      />
      <circle cx="32" cy="33" r="9" />
    </svg>
  );
}
