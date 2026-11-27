import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchKb, fetchKbDirectory, searchKb } from '@/api/kb';
import type { KbTreeNode } from '@shared/kb';
import { CodeView } from './CodeView';
import { TreeSummary } from './FileTree';
import { FileContent, type RenderableFile } from './FileViewer';
import Kb from './index';

vi.mock('@/api/kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/kb')>();
  return {
    ...actual,
    fetchKb: vi.fn(),
    fetchKbDirectory: vi.fn(),
    fetchKbFile: vi.fn(),
    searchKb: vi.fn(),
  };
});

const mockedFetchKb = vi.mocked(fetchKb);
const mockedFetchKbDirectory = vi.mocked(fetchKbDirectory);
const mockedSearchKb = vi.mocked(searchKb);

function renderKb(id: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/kb/${id}`]}>
        <Routes>
          <Route path="/kb/:id/*" element={<Kb />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KB copy and empty-state regressions', () => {
  it('shows empty KB guidance, omits right-pane prompt on error, and prompts to select when non-empty', async () => {
    const kb = { id: 'empty-kb', label: 'Team KB', teamId: 'default' };
    mockedFetchKb.mockResolvedValue(kb);
    mockedFetchKbDirectory.mockResolvedValue({ kb, path: '', entries: [] });

    renderKb('empty-kb');
    expect(await screen.findByText('No files')).toBeTruthy();
    expect(
      screen.getByText('This knowledge base is empty. Files added to its folder appear here.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Select a file/i)).toBeNull();

    cleanup();
    mockedFetchKbDirectory.mockRejectedValue(new Error('disk error'));
    renderKb('errored-kb');
    expect(await screen.findByText('disk error')).toBeTruthy();
    expect(screen.queryByText(/Select a file/i)).toBeNull();
    expect(screen.queryByText(/This knowledge base is empty/i)).toBeNull();

    cleanup();
    mockedFetchKbDirectory.mockResolvedValue({
      kb,
      path: '',
      entries: [{ name: 'notes.md', path: 'notes.md', type: 'file' }],
    });
    renderKb('filled-kb');
    expect(await screen.findByText('Select a file to preview')).toBeTruthy();
  });

  it('labels KB search input for file names and states partial search results accurately', async () => {
    const kb = { id: 'search-kb', label: 'Team KB', teamId: 'default' };
    mockedFetchKb.mockResolvedValue(kb);
    mockedFetchKbDirectory.mockResolvedValue({
      kb,
      path: '',
      entries: [{ name: 'notes.md', path: 'notes.md', type: 'file' }],
    });
    mockedSearchKb.mockResolvedValue({
      kb,
      query: 'note',
      matches: [{ name: 'notes.md', path: 'notes.md', type: 'file' }],
      scanned: 500,
      truncated: true,
    });

    renderKb('search-kb');
    const input = await screen.findByRole('textbox', { name: 'Search file names' });
    expect(input.getAttribute('placeholder')).toBe('Search file names…');

    fireEvent.change(input, { target: { value: 'note' } });
    expect(
      await screen.findByText('Showing partial results. Some matches may be missing.'),
    ).toBeTruthy();
  });

  it.each([
    ['html', { name: 'report.html', kind: 'html' as const, size: 100 }],
    ['video', { name: 'demo.mp4', kind: 'video' as const, size: 2048 }],
    ['pdf', { name: 'spec.pdf', kind: 'pdf' as const, size: 4096 }],
  ])('labels %s pop-out link as Open in new tab without redundant title', (_kind, file: RenderableFile) => {
    render(
      <MemoryRouter>
        <FileContent
          id="kb"
          filePath={file.name}
          file={file}
          loading={false}
          error={null}
          mode="preview"
          onModeChange={() => {}}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Open in new tab' });
    expect(link.getAttribute('title')).toBeNull();
    expect(screen.queryByText(/Open full page/i)).toBeNull();
  });

  it('uses accurate action labels for binary and truncated files', () => {
    const { rerender } = render(
      <MemoryRouter>
        <FileContent
          id="kb"
          filePath="archive.bin"
          file={{ name: 'archive.bin', kind: 'binary', size: 1024 }}
          loading={false}
          error={null}
          mode="preview"
          onModeChange={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/This file can’t be previewed \(1\.0 KB\)\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();

    rerender(
      <MemoryRouter>
        <FileContent
          id="kb"
          filePath="huge.log"
          file={{ name: 'huge.log', kind: 'text', size: 2048, truncated: true }}
          loading={false}
          error={null}
          mode="preview"
          onModeChange={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/This file is too large to preview \(2\.0 KB\)\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open raw file' })).toBeTruthy();
  });

  it('omits zero counts in TreeSummary', () => {
    const filesOnly: KbTreeNode[] = [
      { name: 'a.md', path: 'a.md', type: 'file' },
      { name: 'b.md', path: 'b.md', type: 'file' },
    ];
    const dirsOnly: KbTreeNode[] = [{ name: 'docs', path: 'docs', type: 'dir' }];
    const { rerender } = render(<TreeSummary nodes={filesOnly} />);
    expect(screen.getByText('2 files')).toBeTruthy();
    expect(screen.queryByText(/0 folders/)).toBeNull();

    rerender(<TreeSummary nodes={dirsOnly} />);
    expect(screen.getByText('1 folder')).toBeTruthy();
    expect(screen.queryByText(/0 files/)).toBeNull();
  });

  it('keeps a static Wrap lines aria-label on CodeView wrap toggle', () => {
    render(<CodeView body="hello world\n" language="text" />);
    const toggle = screen.getByRole('button', { name: 'Wrap lines' });
    const initiallyPressed = toggle.getAttribute('aria-pressed') === 'true';
    expect(toggle.getAttribute('title')).toBe(initiallyPressed ? 'Unwrap lines' : 'Wrap lines');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-label')).toBe('Wrap lines');
    expect(toggle.getAttribute('title')).toBe(initiallyPressed ? 'Wrap lines' : 'Unwrap lines');
  });
});
