import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentChannelListResponse } from '@shared/messages';
import { fetchAgentChannels } from '@/api/agents';
import Channels from './index';

vi.mock('@/api/agents', () => ({
  fetchAgentChannels: vi.fn(),
  fetchAgentMessages: vi.fn(),
}));

const mockedFetchAgentChannels = vi.mocked(fetchAgentChannels);

function renderChannels(response: AgentChannelListResponse) {
  mockedFetchAgentChannels.mockResolvedValue(response);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/scout/channels']}>
        <Routes>
          <Route path="/agents/:agentId/channels" element={<Channels />} />
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
