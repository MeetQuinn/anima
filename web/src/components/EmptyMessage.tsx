import type { ReactNode } from 'react';

// Centered serif-italic empty/loading line used by the timeline surfaces
// (Activity, Channels — previously verbatim copies). The mt-20 drops the line
// into the upper third of the scroll area instead of hugging the toolbar.
// Other empty states in the app use the same register at different sizes;
// they stay local until a size variant is actually needed.
export function EmptyMessage({ children }: { children: ReactNode }) {
  return (
    <div className="mt-20 text-center">
      <p className="font-serif italic text-[15px] text-text-subtle">{children}</p>
    </div>
  );
}
