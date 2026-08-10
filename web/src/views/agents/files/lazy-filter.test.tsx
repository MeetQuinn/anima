import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAgentHomeDirectory } from '@/api/agent-files';
import AgentFiles, { matchesLazyHomeFilter } from './index';
import type { KbTreeNode } from '@shared/kb';

// HOLD #643: filtering must not cascade-fetch every directory under a lazy
// agent home. Typing a filter character used to mark every unloaded dir as a
// match and auto-expand it, mounting AgentHomeDirectoryRows recursively
// through worktrees/node_modules. This test pins request count to the root
// listing only (notes is expanded by default on first visit).

// TreeRow uses ResizeObserver for truncation; jsdom does not ship it.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', StubResizeObserver);

const h = vi.hoisted(() => {
  const rootEntries = [
    { path: 'MEMORY.md', name: 'MEMORY.md', kind: 'file' as const, size: 10 },
    { path: '_worktrees', name: '_worktrees', kind: 'dir' as const },
    { path: 'notes', name: 'notes', kind: 'dir' as const },
  ];
  const notesEntries = [
    { path: 'notes/topic.md', name: 'topic.md', kind: 'file' as const, size: 4 },
  ];
  const worktreesEntries = Array.from({ length: 50 }, (_v, i) => ({
    path: `_worktrees/pkg-${i}`,
    name: `pkg-${i}`,
    kind: 'dir' as const,
  }));
  return { rootEntries, notesEntries, worktreesEntries };
});

vi.mock('@/api/agent-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/agent-files')>();
  return {
    ...actual,
    fetchAgentHomeDirectory: vi.fn(async (_agentId: string, dir = '') => {
      if (dir === '') {
        return { root: '/tmp/home', dir: '', entries: h.rootEntries, truncated: false };
      }
      if (dir === 'notes') {
        return { root: '/tmp/home', dir: 'notes', entries: h.notesEntries, truncated: false };
      }
      if (dir === '_worktrees') {
        return {
          root: '/tmp/home',
          dir: '_worktrees',
          entries: h.worktreesEntries,
          truncated: false,
        };
      }
      // Nested worktree packages — must not be requested during filter alone.
      return { root: '/tmp/home', dir, entries: [], truncated: false };
    }),
    fetchAgentHomeFile: vi.fn(async () => ({
      path: 'MEMORY.md',
      name: 'MEMORY.md',
      kind: 'markdown' as const,
      size: 10,
      content: '# Memory\n',
    })),
  };
});

function renderFiles() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/juno/files']}>
        <Routes>
          <Route path="/agents/:agentId/files/*" element={<AgentFiles />} />
          <Route path="/agents/:agentId/files" element={<AgentFiles />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('agent home Files lazy filter', () => {
  beforeEach(() => {
    vi.mocked(fetchAgentHomeDirectory).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('matchesLazyHomeFilter keeps dirs visible and filters files by name', () => {
    const dir: KbTreeNode = { name: 'notes', path: 'notes', type: 'dir' };
    const file: KbTreeNode = { name: 'topic.md', path: 'notes/topic.md', type: 'file' };
    expect(matchesLazyHomeFilter(dir, 'zzz')).toBe(true);
    expect(matchesLazyHomeFilter(file, 'topic')).toBe(true);
    expect(matchesLazyHomeFilter(file, 'zzz')).toBe(false);
  });

  it('does not cascade-fetch unexpanded dirs when the operator types a filter', async () => {
    renderFiles();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Filter files…')).toBeTruthy();
    });

    // Root always loads; first visit also expands notes/ by default.
    await waitFor(() => {
      const dirs = vi.mocked(fetchAgentHomeDirectory).mock.calls.map((c) => c[1] ?? '');
      expect(dirs).toContain('');
      expect(dirs).toContain('notes');
    });

    const callsBeforeFilter = vi.mocked(fetchAgentHomeDirectory).mock.calls.length;

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Filter files…'), {
        target: { value: 'x' },
      });
    });

    // Allow any microtasks from react-query / effects.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const calls = vi.mocked(fetchAgentHomeDirectory).mock.calls.map((c) => c[1] ?? '');
    expect(calls).not.toContain('_worktrees');
    // No nested package dirs under worktrees.
    expect(calls.some((d) => d.startsWith('_worktrees/'))).toBe(false);
    // Filtering must not issue additional directory listings.
    expect(vi.mocked(fetchAgentHomeDirectory).mock.calls.length).toBe(callsBeforeFilter);
  });

  it('fetches a directory only after explicit expand, even while filtering', async () => {
    renderFiles();
    await waitFor(() => expect(screen.getByText('_worktrees')).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Filter files…'), {
        target: { value: 'pkg' },
      });
    });
    expect(vi.mocked(fetchAgentHomeDirectory).mock.calls.map((c) => c[1] ?? '')).not.toContain(
      '_worktrees',
    );

    await act(async () => {
      fireEvent.click(screen.getByText('_worktrees'));
    });

    await waitFor(() => {
      expect(vi.mocked(fetchAgentHomeDirectory).mock.calls.map((c) => c[1] ?? '')).toContain(
        '_worktrees',
      );
    });
    // Expanding one level must not auto-fetch every package child.
    const nested = vi
      .mocked(fetchAgentHomeDirectory)
      .mock.calls.map((c) => c[1] ?? '')
      .filter((d) => d.startsWith('_worktrees/'));
    expect(nested).toEqual([]);
  });
});
