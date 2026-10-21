import { createElement, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { FileContent, type RenderableFile } from './FileViewer';

// Counts how often the KaTeX plugin module is loaded.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('rehype-katex', async (importOriginal) => {
  loads.count += 1;
  return importOriginal();
});

function renderViewer(content: string, container?: HTMLElement) {
  const file: RenderableFile = { name: 'notes.md', kind: 'markdown', size: content.length, language: undefined, content, truncated: false };
  return render(
    createElement(FileContent, { id: 'kb', filePath: 'notes.md', file, loading: false, error: null, mode: 'preview', onModeChange: () => {} }),
    { container, wrapper: ({ children }: { children: ReactNode }) => createElement(BrowserRouter, null, children) },
  );
}

it('loads KaTeX only once a file has math, and holds that body back until it has', async () => {
  const plain = renderViewer('# Notes\n\nBudget: $5 today and $10 tomorrow.');
  await waitFor(() => expect(plain.container.querySelector('.md-prose p')).not.toBeNull());
  expect(loads.count).toBe(0);
  plain.unmount();

  // Watch every DOM change while KaTeX loads: raw LaTeX (a `math` code block)
  // must never show, so the page does not reflow when it is typeset.
  const host = document.body.appendChild(document.createElement('div'));
  let rawMathSeen = false;
  const observer = new MutationObserver(() => {
    if (host.querySelector('.language-math')) rawMathSeen = true;
  });
  observer.observe(host, { childList: true, subtree: true });
  const withMath = renderViewer(['$$', 'x^2', '$$'].join('\n'), host);
  await waitFor(() => expect(withMath.container.querySelector('.katex-display')).not.toBeNull());
  observer.disconnect();
  expect(loads.count).toBe(1);
  expect(rawMathSeen).toBe(false);
});
