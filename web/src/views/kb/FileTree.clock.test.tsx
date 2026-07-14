import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchKbDirectory } from '@/api/kb';
import Kb from './index';

// Stale-clock regression (#508 gate, Milo). The tree's relative mtime labels
// ("60 min ago") must keep advancing while the list stays open. The broken
// shape computed them from a render-time `new Date()`: TanStack structural
// sharing keeps `data` identity stable across polls with unchanged payloads,
// so nothing re-renders and a label can read "60 min ago" long past the hour.
// The fix owns one `useNow()` clock per tree surface and threads `now` through
// the recursive TreeRow. This test renders the REAL Kb view (not a synthetic
// harness) against a mocked API whose tree payload is deep-equal on every
// poll - the exact no-re-render condition - and asserts the labels cross the
// minute→hour boundary purely via the clock. Reverting the surface's useNow
// wiring, or the `now` prop threading, makes it fail.
//
// NOTE: web vitest is not wired into CI yet (#344) - run locally via
// `pnpm --dir web test`.

const h = vi.hoisted(() => {
  const MTIME = '2026-01-02T00:00:00.000Z';
  // 59m40s after MTIME: formatRelativeShort rounds to "60 min ago" - the
  // stuck label from the gate repro, one interval tick from the hour branch.
  const MOUNT = '2026-01-02T00:59:40.000Z';
  const kb = { id: 'team', label: 'Team KB', teamId: 'default' };
  // Factory: every poll returns a FRESH object that is deep-equal to the
  // last, so react-query's structural sharing preserves data identity and
  // the data itself never triggers a re-render (the production condition).
  const directory = (path: string) => ({
    kb,
    path,
    entries: path === 'docs'
      ? [{ name: 'guide.md', path: 'docs/guide.md', type: 'file' as const, mtime: MTIME }]
      : [
          { name: 'docs', path: 'docs', type: 'dir' as const, mtime: MTIME },
          { name: 'notes.md', path: 'notes.md', type: 'file' as const, mtime: MTIME },
        ],
  });
  return { MTIME, MOUNT, kb, directory };
});

vi.mock('@/api/kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/kb')>();
  return {
    ...actual,
    fetchKb: vi.fn(async () => h.kb),
    fetchKbDirectory: vi.fn(async (_id: string, path: string) => h.directory(path)),
    fetchKbFile: vi.fn(async () => {
      throw new Error('fetchKbFile should not be called (no file selected)');
    }),
  };
});

function renderKb() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/kb/team']}>
        <Routes>
          <Route path="/kb/:id/*" element={<Kb />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // shouldAdvanceTime keeps mocked timers firing in step with real time so
  // testing-library's polling and react-query's promise plumbing still run;
  // the boundary itself is crossed only by the explicit advance below (the
  // real-time drift is milliseconds against a 20s margin).
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(h.MOUNT));
  // jsdom lacks both; the view's use-mobile hook and TreeRow's truncation
  // probe need inert stands-ins (per-test mocks per the harness agreement).
  window.matchMedia = ((query: string) => ({
    matches: false,
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('tree mtime labels while the list stays open', () => {
  it('advances "60 min ago" to "1 hr ago" across the hour boundary with unchanged data', async () => {
    renderKb();

    // Tree loaded; expand the dir so the recursive child row is on screen too.
    const dirRow = await screen.findByText('docs');
    expect(vi.mocked(fetchKbDirectory)).toHaveBeenCalledWith('team', '', undefined, expect.any(AbortSignal));
    expect(vi.mocked(fetchKbDirectory).mock.calls.some(([, path]) => path === 'docs')).toBe(false);
    fireEvent.click(dirRow);
    await screen.findByText('guide.md');
    expect(vi.mocked(fetchKbDirectory).mock.calls.some(([, path]) => path === 'docs')).toBe(true);

    // dir + nested file + root file: all three read the stuck-repro label.
    expect(screen.getAllByText('60 min ago')).toHaveLength(3);

    // Cross the boundary by clock alone: one useNow tick (60s interval) plus
    // two 30s tree polls whose deep-equal payloads must NOT be what saves us.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(screen.queryByText('60 min ago')).toBeNull();
    expect(screen.getAllByText('1 hr ago')).toHaveLength(3);
  });
});
