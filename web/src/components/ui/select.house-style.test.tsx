/**
 * House-style pin for the select menu rows (totoday 08-18: 一般dropdown是这样的吗).
 *
 * `ui/select.tsx` is vendored from shadcn, whose default row highlight is
 * `focus:bg-accent focus:text-accent-foreground`. That default assumes `--accent`
 * is a subtle neutral; our theme redefines `--accent` as the brand ink red
 * (#b3401f, the primary-button fill), so the vendored default painted every
 * hovered row as a CTA-strength slab and left the selected row unmarked once the
 * pointer moved on. The regression surface is a future upstream re-sync silently
 * restoring those classes.
 *
 * Instrument note: jsdom applies no Tailwind CSS, so class strings are the only
 * thing assertable here — these pin the CLASSES, not the pixels. The rendered
 * result was measured in a browser (computed backgroundColor rgb(239,234,224) on
 * the highlighted row, color rgb(179,64,31) on the selected row) and that
 * measurement lives in the PR, not in this file.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Select, SelectContent, SelectItem, SelectTrigger } from './select';

function renderOpenSelect() {
  render(
    <Select defaultValue="b" open>
      <SelectTrigger>trigger</SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Alpha</SelectItem>
        <SelectItem value="b">Bravo</SelectItem>
      </SelectContent>
    </Select>,
  );
  const items = screen.getAllByRole('option');
  expect(items.length).toBe(2);
  return items;
}

describe('select menu rows keep the house idiom', () => {
  afterEach(cleanup);

  it('highlights with the paper tint, never the ink-red CTA fill', () => {
    const [item] = renderOpenSelect();
    const className = item!.getAttribute('class') ?? '';

    // The house menu highlight, shared with the ⋯ menu and every other menu row.
    expect(className).toContain('focus:bg-surface-elevated');
    // shadcn's default, which our accent redefinition turns into a CTA slab.
    expect(className).not.toContain('focus:bg-accent');
    expect(className).not.toContain('focus:text-accent-foreground');
  });

  it('marks the selected row so it survives the highlight moving away', () => {
    const [item] = renderOpenSelect();
    // Base UI drives the highlight off DOM focus, so it follows the pointer;
    // without a selected-state mark the current value reads as unselected.
    expect(item!.getAttribute('class') ?? '').toContain('data-selected:text-accent');
  });

  it('drops below the trigger instead of covering it', () => {
    // shadcn's `alignItemWithTrigger` default floated the popup OVER the
    // trigger. Measured in a browser, the popup's FIRST row landed on the
    // trigger at every position tried, so a select showing "Codex CLI" put
    // "Claude Code" exactly where the value had been and hid the trigger
    // (totoday 08-18: 展开之后当前位置就变成 claude code 了).
    renderOpenSelect();
    const popup = document.querySelector('[data-slot=select-content]');
    expect(popup).toBeTruthy();
    expect(popup!.getAttribute('data-align-trigger')).toBe('false');
  });

  it('insets the rows so a highlighted row never collides with the popup border', () => {
    renderOpenSelect();
    const popup = document.querySelector('[data-slot=select-content]');
    expect(popup).toBeTruthy();
    const className = popup!.getAttribute('class') ?? '';
    expect(className.split(/\s+/)).toContain('p-1');
  });
});
