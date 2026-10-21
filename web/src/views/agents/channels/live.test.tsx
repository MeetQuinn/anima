import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';
import { fetchAgentChannels, fetchAgentMessages } from '@/api/agents';
import Channels from './index';

vi.mock('@/api/agents', () => ({
  fetchAgentChannels: vi.fn(),
  fetchAgentMessages: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));
// A short poll, so the test runs on real timers.
vi.mock('@/lib/query-keys', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/query-keys')>();
  return { ...mod, refetchIntervals: { ...mod.refetchIntervals, agentActivities: 40 } };
});

const mockedFetchAgentChannels = vi.mocked(fetchAgentChannels);
const mockedFetchAgentMessages = vi.mocked(fetchAgentMessages);

// The channel's message log, oldest first. Pages are served newest first, the
// cursor being the log position the page stops at (like the real route).
let log: AgentMessageRecord[] = [];
function said(i: number): AgentMessageRecord {
  return {
    direction: 'out',
    kind: 'message',
    messageId: `m${i}`,
    source: { id: `s${i}`, kind: 'activity' },
    text: `message ${i}`,
    timestamp: new Date(Date.UTC(2026, 9, 20, 2, 0) + i * 60_000).toISOString(),
    channelId: 'C-prod',
    platform: 'slack',
  };
}
function append(count: number) {
  const from = log.length;
  for (let i = from; i < from + count; i += 1) log.push(said(i));
}
function page(input: { before?: string; limit?: number }): AgentMessageHistoryPage {
  const end = input.before === undefined ? log.length : Number(input.before);
  const start = Math.max(0, end - (input.limit ?? 100));
  return { entries: log.slice(start, end).reverse(), nextCursor: start > 0 ? String(start) : null };
}

beforeEach(() => {
  log = [];
  mockedFetchAgentChannels.mockResolvedValue({
    channels: [{ id: 'C-prod', name: 'prod', platform: 'slack', kind: 'channel', status: 'following' }],
  });
  mockedFetchAgentMessages.mockImplementation(async (_agentId, input = {}) => page(input));
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.clearAllMocks();
});

function renderChannel(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/scout/channels?c=C-prod']}>
        <Routes>
          <Route path="/agents/:agentId/channels" element={<Channels />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, unmount: view.unmount };
}

// Message reads (not the channel list) made from call `from` on.
function readsSince(from: number) {
  return mockedFetchAgentMessages.mock.calls.slice(from).map(([, input]) => ({ ...input }));
}

async function openWithOlderPage() {
  append(450);
  const view = renderChannel();
  await screen.findByText('message 449');
  fireEvent.click(await screen.findByRole('button', { name: 'Load older messages' }));
  await screen.findByText('message 50');
  return { ...view, loaded: mockedFetchAgentMessages.mock.calls.length };
}

// Reads that re-fetch history pages (the probe always reads 50 newest rows).
function historyReadsSince(from: number) {
  return readsSince(from).filter((read) => read.limit !== 50);
}

it('polls only the newest rows once older history is loaded, and merges what is new', async () => {
  const { loaded } = await openWithOlderPage();

  append(1);
  await screen.findByText('message 450');
  await waitFor(() => expect(readsSince(loaded).length).toBeGreaterThanOrEqual(4));

  // Every poll is one newest-rows read: no page is re-read by its cursor.
  expect(readsSince(loaded).every((read) => read.before === undefined && read.limit === 50)).toBe(true);
  expect(readsSince(loaded).every((read) => read.channel === 'C-prod')).toBe(true);
  // The older page is still there.
  expect(screen.getByText('message 50')).toBeTruthy();
});

it('re-fetches the history when more new rows arrive than one poll reads', async () => {
  const { loaded } = await openWithOlderPage();

  append(60);
  await screen.findByText('message 509');
  // No hole between what was loaded and what arrived.
  for (const i of [449, 450, 480, 508]) expect(screen.getByText(`message ${i}`)).toBeTruthy();
  expect(readsSince(loaded).some((read) => read.limit === 200)).toBe(true);
});

it('does not re-read loaded history pages on window focus or remount', async () => {
  const { client, unmount, loaded } = await openWithOlderPage();

  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  // Several 40ms polls run meanwhile, so the probe is live throughout.
  await waitFor(() => expect(readsSince(loaded).length).toBeGreaterThanOrEqual(3));
  expect(historyReadsSince(loaded)).toEqual([]);

  unmount();
  const remounted = mockedFetchAgentMessages.mock.calls.length;
  renderChannel(client);
  await screen.findByText('message 50');
  await waitFor(() => expect(readsSince(remounted).length).toBeGreaterThanOrEqual(2));
  expect(historyReadsSince(remounted)).toEqual([]);
});

it('retries a failed first history read from the probe', async () => {
  append(10);
  let failFirst = true;
  mockedFetchAgentMessages.mockImplementation(async (_agentId, input = {}) => {
    if (failFirst && input.limit === 200) {
      failFirst = false;
      throw new Error('HTTP 503');
    }
    return page(input);
  });
  renderChannel();

  // No user action: the probe sees the failed history and re-fetches it.
  await screen.findByText('message 9');
  expect(screen.getByText('message 0')).toBeTruthy();
});
