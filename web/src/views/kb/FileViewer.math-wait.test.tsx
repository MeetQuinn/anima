import { createElement, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { RenderableFile } from './FileViewer';

// A math document's body waits for KaTeX, so its headings appear after the
// scroll effects first ran. Each test loads the viewer fresh, so KaTeX is not
// loaded yet (it is cached per module).
const DOC = ['# Notes', '', '## Method', '', '$$', '\\int_0^1 x\\,dx', '$$', '', '## Results', '', 'done'].join('\n');

async function renderFresh(content: string) {
  const { FileContent } = await import('./FileViewer');
  const file: RenderableFile = { name: 'notes.md', kind: 'markdown', size: content.length, language: undefined, content, truncated: false };
  return render(
    createElement(FileContent, { id: 'kb', filePath: 'notes.md', file, loading: false, error: null, mode: 'preview', onModeChange: () => {} }),
    { wrapper: ({ children }: { children: ReactNode }) => createElement(BrowserRouter, null, children) },
  );
}

let scrolledTo: Element[];
beforeEach(() => {
  vi.resetModules();
  scrolledTo = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolledTo.push(this);
  });
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

it('lands a heading deep link below math once KaTeX has loaded', async () => {
  window.history.replaceState(null, '', '/kb/kb/notes.md#results');
  await renderFresh(DOC);
  // Held back while KaTeX loads.
  expect(document.getElementById('results')).toBeNull();

  await waitFor(() => expect(scrolledTo.length).toBeGreaterThan(0));
  expect(scrolledTo[0]).toBe(document.getElementById('results'));
  expect(document.querySelector('.katex')).not.toBeNull();
});

it('seeds the contents rail highlight once a math body appears', async () => {
  // Frames run on demand, so the seed's frame can come before KaTeX arrives
  // (in a browser the chunk takes longer than a frame to load).
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  window.history.replaceState(null, '', '/kb/kb/notes.md');
  const { container } = await renderFresh(DOC);
  expect(document.getElementById('results')).toBeNull();
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(container.querySelector('nav a.text-accent')).toBeNull();

  await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
  act(() => {
    vi.advanceTimersToNextFrame();
  });
  expect(container.querySelector('nav a.text-accent')).not.toBeNull();
});
