import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Product rule (totoday / #612): Providers footer never shows the system
 * update red-dot. Server keeps the accent; Providers is quota/accounts only.
 */
const here = dirname(fileURLToPath(import.meta.url));

function buttonContaining(src: string, marker: string): string[] {
  const out: string[] = [];
  let from = 0;
  while (true) {
    const mark = src.indexOf(marker, from);
    if (mark < 0) break;
    const open = src.lastIndexOf('<button', mark);
    expect(open).toBeGreaterThanOrEqual(0);
    const close = src.indexOf('</button>', mark);
    expect(close).toBeGreaterThan(open);
    out.push(src.slice(open, close + '</button>'.length));
    from = mark + marker.length;
  }
  return out;
}

describe('Providers footer update dot', () => {
  it.each(['Sidebar.tsx', 'MobileNavScreen.tsx'] as const)(
    '%s: Providers trigger must not bind updateAvailable',
    (file) => {
      const src = readFileSync(join(here, file), 'utf8');
      const buttons = buttonContaining(src, 'title="Providers"');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
      for (const btn of buttons) {
        expect(btn).not.toMatch(/updateAvailable/);
        expect(btn).not.toMatch(/Update available/);
        expect(btn).not.toMatch(/bg-accent/);
      }
    },
  );
});
