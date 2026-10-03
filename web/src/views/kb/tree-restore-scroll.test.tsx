import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Kb from './index';

// Mobile KB regression (totoday 10-03): coming back from a file to the list
// centres the last-opened row once. Expanding a folder after that must not
// scroll the list back to that row; it did on every toggle, because the
// restore effect re-ran whenever the expanded set changed.

const h = vi.hoisted(() => {
  const MTIME = '2026-01-02T00:00:00.000Z';
  const kb = { id: 'team', label: 'Team KB', teamId: 'default' };
  const file = (path: string, name: string) => ({ name, path, type: 'file' as const, mtime: MTIME });
  const dir = (path: string) => ({ name: path, path, type: 'dir' as const, mtime: MTIME });
  const directory = (path: string) => ({
    kb,
    path,
    entries:
      path === 'docs'
        ? [file('docs/guide.md', 'guide.md')]
        : path === 'other'
          ? [file('other/more.md', 'more.md')]
          : [dir('docs'), dir('other'), file('notes.md', 'notes.md')],
  });
  // A test can hold the `docs` listing back to model a slow folder load.
  const gate: { docs: Promise<void> | null } = { docs: null };
  return { kb, directory, gate };
});

vi.mock('@/api/kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/kb')>();
  return {
    ...actual,
    fetchKb: vi.fn(async (id: string) => ({ ...h.kb, id })),
    fetchKbDirectory: vi.fn(async (_id: string, path: string) => {
      if (path === 'docs' && h.gate.docs) await h.gate.docs;
      return h.directory(path);
    }),
    searchKb: vi.fn(async (_id: string, query: string) => ({ kb: h.kb, query, matches: [], scanned: 0, truncated: false })),
    fetchKbFile: vi.fn(async (_id: string, path: string) => ({
      kbId: _id,
      path,
      name: path.split('/').pop() ?? path,
      kind: 'markdown',
      size: 7,
      content: '# Guide',
    })),
  };
});

let treeScrolls: string[] = [];
const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  treeScrolls = [];
  h.gate.docs = null;
  // useIsMobile reads innerWidth at mount: this is the phone layout.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom has no scrollIntoView; record which tree rows get scrolled to.
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    if (this instanceof HTMLElement && this.dataset.treeRow !== undefined) {
      treeScrolls.push(this.dataset.path ?? '');
    }
  });
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  vi.restoreAllMocks();
});

// The page keeps the last-opened file and the expanded folders per KB id in
// module memory, so each test uses its own id.
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('mobile KB list after returning from a file', () => {
  it('centres the last-opened row once, then leaves folder toggles alone', async () => {
    renderKb('team-a');

    // Open docs/guide.md from the list, then go back to the list.
    fireEvent.click(await screen.findByText('docs'));
    fireEvent.click(await screen.findByText('guide.md'));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to file list' }));

    // Positive control: the return itself restores the row.
    await waitFor(() => expect(treeScrolls).toEqual(['docs/guide.md']));

    // Clearing a filter does not repeat it: the restore is done for this return.
    const filter = screen.getByPlaceholderText('Filter files…');
    fireEvent.change(filter, { target: { value: 'g' } });
    await settle();
    fireEvent.change(filter, { target: { value: '' } });
    await screen.findByText('guide.md');
    await settle();
    expect(treeScrolls).toEqual(['docs/guide.md']);

    // Expanding another folder must not pull the list back to that row.
    fireEvent.click(await screen.findByText('other'));
    await screen.findByText('more.md');
    await settle();
    expect(treeScrolls).toEqual(['docs/guide.md']);

    // Nor collapsing and re-expanding the folder that holds it.
    fireEvent.click(screen.getByText('docs'));
    await settle();
    fireEvent.click(screen.getByText('docs'));
    await screen.findByText('guide.md');
    await settle();
    expect(treeScrolls).toEqual(['docs/guide.md']);
  });

  it('gives up the restore once the user toggles a folder, even if the row appears later', async () => {
    const first = renderKb('team-c');
    fireEvent.click(await screen.findByText('docs'));
    fireEvent.click(await screen.findByText('guide.md'));
    await screen.findByRole('button', { name: 'Back to file list' });
    first.unmount();

    // Come back to the list on a fresh mount (new query cache) while the
    // folder holding the last-opened row is still loading.
    let release = () => {};
    h.gate.docs = new Promise<void>((resolve) => { release = resolve; });
    renderKb('team-c');
    fireEvent.click(await screen.findByText('other'));
    await screen.findByText('more.md');
    release();
    await screen.findByText('guide.md');
    fireEvent.click(screen.getByText('other'));
    await settle();
    expect(treeScrolls).toEqual([]);
  });

  it('restores again on the next return from a file', async () => {
    renderKb('team-b');

    fireEvent.click(await screen.findByText('docs'));
    fireEvent.click(await screen.findByText('guide.md'));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to file list' }));
    await waitFor(() => expect(treeScrolls).toEqual(['docs/guide.md']));

    fireEvent.click(await screen.findByText('other'));
    fireEvent.click(await screen.findByText('more.md'));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to file list' }));
    await waitFor(() => expect(treeScrolls).toEqual(['docs/guide.md', 'other/more.md']));
  });
});
