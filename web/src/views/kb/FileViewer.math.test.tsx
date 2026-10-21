import { createElement, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { render, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';

import { FileContent, type RenderableFile } from './FileViewer';

function markdown(content: string): RenderableFile {
  return { name: 'notes.md', kind: 'markdown', size: content.length, language: undefined, content, truncated: false };
}

function renderViewer(content: string) {
  return render(
    createElement(FileContent, {
      id: 'kb',
      filePath: 'notes.md',
      file: markdown(content),
      loading: false,
      error: null,
      mode: 'preview',
      onModeChange: () => {},
    }),
    { wrapper: ({ children }: { children: ReactNode }) => createElement(BrowserRouter, null, children) },
  );
}


it('reads single dollar signs as prose, not math', async () => {
  const { container } = renderViewer('Budget: $5 today and $10 tomorrow.');

  await waitFor(() => expect(container.querySelector('.md-prose p')).not.toBeNull());
  expect(container.querySelector('.md-prose p')!.textContent).toBe('Budget: $5 today and $10 tomorrow.');
  expect(container.querySelector('code.language-math, .katex')).toBeNull();
});

it('typesets double-dollar and fenced math once KaTeX has loaded', async () => {
  const { container } = renderViewer(['Inline $$x^2$$ here.', '', '$$', 'E = mc^2', '$$', '', '```math', 'a + b', '```'].join('\n'));

  await waitFor(() => expect(container.querySelectorAll('.katex').length).toBe(3));
  expect(container.querySelectorAll('.katex-display').length).toBe(2);
  // Rendered once, already typeset: no raw LaTeX code left behind.
  expect(container.querySelector('code.language-math')).toBeNull();
});
