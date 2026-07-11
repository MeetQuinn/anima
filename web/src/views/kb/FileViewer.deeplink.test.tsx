import { createElement, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileContent, type RenderableFile } from './FileViewer';

// Fresh-load deep-link regression (#493 gate, Milo). A URL that arrives with a
// hash pointing BELOW the first heading must land there — historically the
// scroll-sync geometry seed ran before the deep-link scroll and rewrote the
// hash from scrollTop 0. jsdom is the perfect adversary here: every
// getBoundingClientRect() reads 0, so under the old code EVERY heading sits
// "above the fold" and the seed resolves the active heading to the LAST one,
// rewriting the incoming hash. The fixed code never writes the URL from the
// seed pass, so these tests fail loudly on any regression of that ordering.
//
// NOTE: web vitest is not wired into CI yet (#344) — run locally via
// `pnpm --filter web test`.

const DOC = [
  '# Roadmap',
  '',
  'intro text',
  '',
  '## Axis A agents',
  '',
  'body a',
  '',
  '## Axis H humans',
  '',
  'body h',
  '',
  '## Open questions',
  '',
  'tail',
].join('\n');

const FILE: RenderableFile = {
  name: 'roadmap.md',
  kind: 'markdown',
  size: DOC.length,
  language: null,
  content: DOC,
  truncated: false,
};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(BrowserRouter, null, children);
}

function renderViewer() {
  return render(
    createElement(FileContent, {
      id: 'kb',
      filePath: 'roadmap.md',
      file: FILE,
      loading: false,
      error: null,
      mode: 'preview',
      onModeChange: () => {},
    }),
    { wrapper },
  );
}

// jsdom has no scrollIntoView; the spy doubles as the landing assertion.
let scrolledTo: Element[];

beforeEach(() => {
  scrolledTo = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolledTo.push(this);
  });
});

afterEach(() => {
  // Reset the URL so cases stay independent (jsdom keeps history per file).
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('fresh-load heading deep link (#493)', () => {
  it('lands a non-H1 hash: scrolls to the target and preserves the hash', async () => {
    window.history.replaceState(null, '', '/kb/kb/roadmap.md#axis-h-humans');

    renderViewer();

    // The landing effect defers the scroll briefly so ReactMarkdown settles.
    await waitFor(() => expect(scrolledTo.length).toBeGreaterThan(0));

    expect(scrolledTo[0]).toBe(document.getElementById('axis-h-humans'));
    // The regression: the geometry seed used to rewrite this to another
    // heading (in jsdom's zero-rect world, the LAST one) before landing.
    expect(window.location.hash).toBe('#axis-h-humans');
  });

  it('preserves an unknown hash verbatim instead of rewriting it', async () => {
    // A stale/truncated slug (e.g. from an old share link) matches no heading.
    // It must survive: never be replaced by a heading id the reader is not at.
    window.history.replaceState(null, '', '/kb/kb/roadmap.md#axis-h-humans-old-slug');

    renderViewer();

    // Give the (rAF-scheduled) seed pass a chance to run — it paints the rail
    // but must not touch the URL.
    await waitFor(() =>
      expect(document.getElementById('axis-h-humans')).not.toBeNull(),
    );
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    expect(window.location.hash).toBe('#axis-h-humans-old-slug');
    expect(scrolledTo.length).toBe(0);
  });

  it('leaves a hashless load alone (no hash invented by the seed)', async () => {
    window.history.replaceState(null, '', '/kb/kb/roadmap.md');

    renderViewer();

    await waitFor(() =>
      expect(document.getElementById('axis-h-humans')).not.toBeNull(),
    );
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    expect(window.location.hash).toBe('');
  });
});
