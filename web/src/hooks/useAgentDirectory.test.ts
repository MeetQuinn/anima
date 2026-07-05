import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { fetchAgents, fetchAgentStatuses } from '@/api/agents';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useAgents, useAgentStatuses } from './useAgentDirectory';
import { useQuery } from '@tanstack/react-query';

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({})),
}));

vi.mock('@/api/agents', () => ({
  fetchAgents: vi.fn(),
  fetchAgentStatuses: vi.fn(),
}));

const useQueryMock = vi.mocked(useQuery);

describe('useAgentDirectory', () => {
  it('subscribes to the agents query', () => {
    renderHook(() => useAgents());

    expect(useQueryMock).toHaveBeenCalledWith({
      queryKey: queryKeys.agents(),
      queryFn: fetchAgents,
    });
  });

  it('subscribes to agent statuses without polling by default', () => {
    renderHook(() => useAgentStatuses());

    expect(useQueryMock).toHaveBeenCalledWith({
      queryKey: queryKeys.agentStatuses(),
      queryFn: fetchAgentStatuses,
    });
  });

  it('adds the agent status polling interval when requested', () => {
    renderHook(() => useAgentStatuses({ poll: true }));

    expect(useQueryMock).toHaveBeenCalledWith({
      queryKey: queryKeys.agentStatuses(),
      queryFn: fetchAgentStatuses,
      refetchInterval: refetchIntervals.agentStatuses,
    });
  });
});
