import { createElement, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { FileContent, type RenderableFile } from './FileViewer';

// The KaTeX chunk cannot load (e.g. a deploy replaced it).
vi.mock('rehype-katex', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

function renderViewer(content: string) {
  const file: RenderableFile = { name: 'notes.md', kind: 'markdown', size: content.length, language: undefined, content, truncated: false };
  return render(
    createElement(FileContent, { id: 'kb', filePath: 'notes.md', file, loading: false, error: null, mode: 'preview', onModeChange: () => {} }),
    { wrapper: ({ children }: { children: ReactNode }) => createElement(BrowserRouter, null, children) },
  );
}

it('still renders a math file when KaTeX cannot load, with the LaTeX left as code', async () => {
  const { container } = renderViewer(['# Notes', '', '$$', 'E = mc^2', '$$', '', 'after the math'].join('\n'));

  await waitFor(() => expect(container.querySelector('.md-prose p')).not.toBeNull());
  expect(container.querySelector('.md-prose p')!.textContent).toBe('after the math');
  // The math shows as a `math` code block.
  expect(container.querySelector('.kb-markdown-code-block pre.language-math')!.textContent).toBe('E = mc^2');
  expect(container.querySelector('.katex')).toBeNull();
});
