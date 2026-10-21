import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ActivityFeedItem } from '@/lib/activity-feed';
import type { Activity as ActivityRecord } from '@shared/activity';
import type { AgentStatusSummary } from '@shared/snapshot';
import Activity from './index';

function read(activityId: string, createdAt: string, target: string): ActivityRecord {
  return {
    activityId,
    type: 'tool.call.started',
    createdAt,
    payload: { tool: 'claude.read', providerToolName: 'Read', target },
  };
}

// A command longer than the 120-character inline cap, so its row can expand and
// is rendered as a focusable row button.
const LONG_COMMAND = `pnpm --filter web exec vitest run ${'src/views/agents/activity/'.repeat(5)}`;
function ran(activityId: string, createdAt: string): ActivityRecord {
  return {
    activityId,
    type: 'tool.call.started',
    createdAt,
    payload: { tool: 'claude.bash', providerToolName: 'Bash', command: LONG_COMMAND },
  };
}

function said(text: string, timestamp: string): ActivityFeedItem {
  return { kind: 'message-out', text, timestamp, surface: { kind: 'dm', label: 'totoday' }, isEdit: false };
}

const EVENTS = [ran('a1', '2026-10-20T10:01:00.000Z'), read('a2', '2026-10-20T10:02:00.000Z', 'web/src/router.tsx')];
const STEPS = EVENTS.map((activity) => ({ kind: 'step', activity, timestamp: activity.createdAt }));
const STARTING = said('starting', '2026-10-20T10:00:00.000Z');
const DONE = said('done', '2026-10-20T10:03:00.000Z');

// What the mocked hooks return; each test sets it before rendering.
const feed = vi.hoisted(() => {
  const noop = () => Promise.resolve();
  const query = { hasNextPage: false, isFetchingNextPage: false, isLoading: false, isFetching: false, fetchNextPage: noop };
  return { query, conversationItems: [] as unknown[], statuses: [] as unknown[] };
});

vi.mock('./useActivityFeeds', () => ({
  useActivityFeeds: () => ({
    activityQuery: { ...feed.query, data: { pages: [{ events: EVENTS }] } },
    messageQuery: { ...feed.query, error: null, data: { pages: [{}] } },
    liveError: null,
    activitiesData: { events: EVENTS },
    conversationItems: feed.conversationItems,
    stepItems: STEPS,
  }),
}));
vi.mock('./useStickToBottom', () => ({ useStickToBottom: () => ({ revealed: true }) }));
vi.mock('@/hooks/useAgentDirectory', () => ({
  useAgents: () => ({ data: [{ id: 'nora', name: 'Nora' }] }),
  useAgentStatuses: () => ({ data: feed.statuses }),
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

function view() {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/nora']}>
        <Routes>
          <Route path="/agents/:agentId" element={<Activity />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function longRow() {
  const row = screen.getByText('Ran').closest<HTMLElement>('[tabindex="0"]');
  expect(row).not.toBeNull();
  return row!;
}

it('keeps a collapsed step fold out of the tab order until it is opened', () => {
  // A message on either side, so the fold between them starts collapsed.
  feed.conversationItems = [STARTING, DONE];
  feed.statuses = [];
  render(view());

  const disclosure = screen.getByRole('button', { name: '2 steps' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  expect(disclosure.closest('[inert]')).toBeNull();
  // The collapsed rows are still in the DOM (the grid animates their height),
  // and the long command's row is a tabIndex=0 button, so only `inert` keeps it out.
  const row = longRow();
  expect(row.closest('[inert]')).not.toBeNull();

  fireEvent.click(disclosure);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  expect(row.closest('[inert]')).toBeNull();
});

it('moves focus to the toggle when the live fold shuts on its own', () => {
  // The fold is the day's last entry and the run is current, so it is forced open.
  feed.conversationItems = [STARTING];
  const live: AgentStatusSummary = {
    agentId: 'nora',
    currentItemId: 'dm:totoday',
    currentItemStartedAt: '2026-10-20T10:00:30.000Z',
    health: { state: 'healthy', updatedAt: '2026-10-20T10:02:00.000Z' },
    itemCount: 1,
    queueDepth: 0,
  };
  feed.statuses = [live];
  const { rerender } = render(view());

  const disclosure = screen.getByRole('button', { name: '2 steps' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  const row = longRow();
  row.focus();
  expect(document.activeElement).toBe(row);

  // The run completes: the status poll clears the current item.
  feed.statuses = [{ ...live, currentItemId: undefined, currentItemStartedAt: undefined, itemCount: 0 }];
  rerender(view());

  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  expect(row.closest('[inert]')).not.toBeNull();
  expect(document.activeElement).toBe(disclosure);
});
