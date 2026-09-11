import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TocButton, ViewModeToggle } from './FileChrome';

// The touch-target floor is a PAIR: `min-h-[44px]` for the mobile floor and a
// `md:` override that restores the desktop density (#680/#683 house rule,
// enforced on PR #705). A bare bump to 44 would pass the first assertion and
// silently regress desktop; a bare desktop value would pass the second and
// leave 28px tabs under a thumb. Both halves are pinned on purpose.
function expectFloorPair(el: Element, desktop: string) {
  expect(el.classList.contains('min-h-[44px]')).toBe(true);
  expect(el.classList.contains(`md:min-h-[${desktop}]`)).toBe(true);
}

describe('FileChrome touch-target floor', () => {
  it('view-mode tabs carry the 44px floor and keep their 28px desktop height', () => {
    render(<ViewModeToggle mode="preview" onChange={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expectFloorPair(tab, '28px');
  });

  it('TOC entries carry the 44px floor and keep their 40px desktop height', () => {
    render(
      <TocButton
        entries={[
          { id: 'intro', text: 'Introduction', depth: 1, line: 1 },
          { id: 'setup', text: 'Setup', depth: 2, line: 5 },
        ]}
      />,
    );
    fireEvent.click(screen.getByTitle('Table of contents'));
    const entries = screen.getAllByRole('link');
    expect(entries).toHaveLength(2);
    for (const entry of entries) expectFloorPair(entry, '40px');
  });
});
