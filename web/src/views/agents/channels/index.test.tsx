import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentChannelListResponse, AgentChannelSummary } from '@shared/messages';
import { fetchAgentChannels, fetchAgentMessages } from '@/api/agents';
import Channels from './index';

vi.mock('@/api/agents', () => ({
  fetchAgentChannels: vi.fn(),
  fetchAgentMessages: vi.fn(),
  // Reached only once a channel is actually open (ConversationPane → useAgents).
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

const mockedFetchAgentChannels = vi.mocked(fetchAgentChannels);
const mockedFetchAgentMessages = vi.mocked(fetchAgentMessages);

function renderAt(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/agents/:agentId/channels" element={<Channels />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderChannels(response: AgentChannelListResponse) {
  mockedFetchAgentChannels.mockResolvedValue(response);
  return renderAt('/agents/scout/channels');
}

beforeEach(() => {
  // jsdom has no layout, so it ships no scrollIntoView; the conversation pane
  // calls it on mount. Supplying the missing DOM API, not a product state.
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Slack membership degradation', () => {
  it('keeps a short local list visible with restrained incomplete-list copy', async () => {
    renderChannels({
      channels: [{
        id: 'C-local',
        name: 'product',
        platform: 'slack',
        kind: 'channel',
        status: 'following',
      }],
      slackMembershipDegraded: true,
    });

    expect(await screen.findByText('product')).toBeTruthy();
    expect(screen.getByText(
      'Slack membership could not be refreshed. This list may be incomplete.',
    )).toBeTruthy();
    expect(screen.queryByText('Could not load channels')).toBeNull();
  });

  it('does not claim a degraded empty list is a healthy empty state', async () => {
    renderChannels({ channels: [], slackMembershipDegraded: true });

    expect(await screen.findByText(
      'Slack membership could not be refreshed. This list may be incomplete.',
    )).toBeTruthy();
    expect(screen.queryByText('No local Slack conversations yet.')).toBeNull();

    cleanup();
    renderChannels({ channels: [] });
    expect(await screen.findByText('No local Slack conversations yet.')).toBeTruthy();
  });

  it('leaves healthy rows unchanged and omits the degradation notice', async () => {
    renderChannels({
      channels: [{
        id: 'C-healthy',
        name: 'general',
        platform: 'slack',
        kind: 'channel',
        status: 'following',
      }],
    });

    expect(await screen.findByText('general')).toBeTruthy();
    expect(screen.queryByText(
      'Slack membership could not be refreshed. This list may be incomplete.',
    )).toBeNull();
  });
});

// #593. The detail pane may never instruct an action that has no object.
//
// Pinned as a property of the rendered text rather than as the two sentences
// that happened to violate it: a detector that only knows today's copy cannot
// fail on tomorrow's. Any imperative pointing at a list row counts, whichever
// branch renders it.
const INSTRUCTS_PICKING_A_ROW = /\b(select|pick|choose)\b/i;

const ROWS: AgentChannelSummary[] = [{
  id: 'C-prod',
  name: 'prod',
  platform: 'slack',
  kind: 'channel',
  status: 'following',
}];

/** Text of the detail pane only — the left list is the state surface and is read separately. */
function detailText(container: HTMLElement): string {
  return container.querySelector('section')?.textContent ?? '';
}

function setViewportMatches(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

describe('detail pane never instructs an action with no object', () => {
  it('stays silent while the rows have not arrived (pending is not empty)', () => {
    mockedFetchAgentChannels.mockReturnValue(new Promise(() => {}));
    const { container } = renderAt('/agents/scout/channels');

    // The window this state occupies is set by the server, not by a frame, so
    // it cannot be dismissed as transient. No substitute copy either: the left
    // column's loader is the whole story.
    expect(detailText(container)).not.toMatch(INSTRUCTS_PICKING_A_ROW);
    expect(detailText(container).trim()).toBe('');
  });

  it('stays silent on a healthy empty list, degraded empty list, and load failure', async () => {
    const { container: healthy } = renderChannels({ channels: [] });
    expect(await screen.findByText('No local Slack conversations yet.')).toBeTruthy();
    expect(detailText(healthy)).not.toMatch(INSTRUCTS_PICKING_A_ROW);

    cleanup();
    const { container: degraded } = renderChannels({
      channels: [],
      slackMembershipDegraded: true,
    });
    expect(await screen.findByText(
      'Slack membership could not be refreshed. This list may be incomplete.',
    )).toBeTruthy();
    expect(detailText(degraded)).not.toMatch(INSTRUCTS_PICKING_A_ROW);

    cleanup();
    mockedFetchAgentChannels.mockRejectedValue(new Error('boom'));
    const { container: failed } = renderAt('/agents/scout/channels');
    expect(await screen.findByText('Could not load channels')).toBeTruthy();
    expect(detailText(failed)).not.toMatch(INSTRUCTS_PICKING_A_ROW);
  });

  it('keeps the missing-deep-link explanation but drops its instruction when nothing is selectable', async () => {
    mockedFetchAgentChannels.mockResolvedValue({ channels: [], slackMembershipDegraded: true });
    const { container } = renderAt('/agents/scout/channels?c=C-gone');

    // Settle on a left-pane string that only exists after the response lands,
    // so this is the empty state and not the pending one.
    expect(await screen.findByText(
      'Slack membership could not be refreshed. This list may be incomplete.',
    )).toBeTruthy();
    expect(screen.getByText(/That conversation isn't in this list/)).toBeTruthy();
    expect(detailText(container)).not.toMatch(INSTRUCTS_PICKING_A_ROW);
  });

  // The other side of the same property: this is a conditional, not a deletion.
  // Pinning only the negative half would grade over-removal as green and lose a
  // sentence that is honest whenever it has an object.
  it('still offers the instruction when there are rows to pick from', async () => {
    mockedFetchAgentChannels.mockResolvedValue({ channels: ROWS });
    const { container } = renderAt('/agents/scout/channels');

    expect(await screen.findByText('prod')).toBeTruthy();
    expect(detailText(container)).toMatch(INSTRUCTS_PICKING_A_ROW);
    expect(screen.getByText('Select a channel to read its conversation.')).toBeTruthy();
  });

  it('still offers the instruction on a missing deep link when rows exist', async () => {
    mockedFetchAgentChannels.mockResolvedValue({ channels: ROWS });
    const { container } = renderAt('/agents/scout/channels?c=C-gone');

    // Wait on the row, not on the explanation: the explanation also renders in
    // the pending frame, when there is still nothing to pick. Asserting on it
    // would read the loading state and call it settled.
    expect(await screen.findByText('prod')).toBeTruthy();
    // Byte-identical to the sentence before it was split: this change subtracts
    // under a condition, it does not reword.
    expect(detailText(container).replace(/\s+/g, ' ').trim()).toBe(
      "That conversation isn't in this list. The agent may have left the channel,"
      + ' or it has no history here. Pick one from the list to read it.',
    );
  });

  // Whether a sentence is true must not depend on how wide the screen is. 375
  // never showed the defect only because `hidden md:flex` covers the whole pane
  // — concealment, not correctness. The guard is on the rows, so both viewports
  // must render identical detail text.
  it('decides on the rows, not on the viewport', async () => {
    setViewportMatches(false);
    const { container: narrow } = renderChannels({ channels: [] });
    expect(await screen.findByText('No local Slack conversations yet.')).toBeTruthy();
    const narrowText = detailText(narrow);

    cleanup();
    setViewportMatches(true);
    const { container: wide } = renderChannels({ channels: [] });
    expect(await screen.findByText('No local Slack conversations yet.')).toBeTruthy();

    expect(detailText(wide)).toBe(narrowText);
    expect(narrowText.trim()).toBe('');
  });

  // Positive control for the settled non-empty path: on a desktop viewport the
  // instruction disappears because a channel got auto-opened, which is a
  // different mechanism from the guard above and must keep working.
  it('auto-opens the first channel on desktop rather than resting on the instruction', async () => {
    setViewportMatches(true);
    mockedFetchAgentMessages.mockResolvedValue({ entries: [] });
    mockedFetchAgentChannels.mockResolvedValue({ channels: ROWS });
    const { container } = renderAt('/agents/scout/channels');

    expect(await screen.findByText('prod')).toBeTruthy();
    await screen.findByRole('button', { name: /back/i });
    expect(detailText(container)).not.toMatch(/Select a channel to read its conversation\./);
  });
});
