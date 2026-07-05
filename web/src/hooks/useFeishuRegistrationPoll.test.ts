import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAgentFeishuAppRegistration } from '@/api/agents';
import { useFeishuRegistrationPoll } from './useFeishuRegistrationPoll';
import type { AgentFeishuRegisterAppStatus } from '@shared/agent-config';

vi.mock('@/api/agents', () => ({
  fetchAgentFeishuAppRegistration: vi.fn(),
}));

const fetchRegistration = vi.mocked(fetchAgentFeishuAppRegistration);

function status(
  state: AgentFeishuRegisterAppStatus['state'],
  extra: Partial<AgentFeishuRegisterAppStatus> = {},
): AgentFeishuRegisterAppStatus {
  return {
    registrationId: 'reg-1',
    state,
    ...extra,
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

describe('useFeishuRegistrationPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchRegistration.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops polling after a terminal state', async () => {
    const onStatus = vi.fn();
    fetchRegistration.mockResolvedValue(status('connected'));

    renderHook(() =>
      useFeishuRegistrationPoll({
        agentId: 'agent-1',
        registration: status('waiting'),
        onStatus,
      }),
    );

    await advance(2000);
    await advance(2000);

    expect(fetchRegistration).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(status('connected'));
  });

  it('stops polling on unmount', async () => {
    const onStatus = vi.fn();
    fetchRegistration.mockResolvedValue(status('waiting'));

    const view = renderHook(() =>
      useFeishuRegistrationPoll({
        agentId: 'agent-1',
        registration: status('waiting'),
        onStatus,
      }),
    );

    view.unmount();
    await advance(2000);

    expect(fetchRegistration).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('reports refresh errors and continues polling', async () => {
    const onError = vi.fn();
    fetchRegistration
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(status('connected'));

    renderHook(() =>
      useFeishuRegistrationPoll({
        agentId: 'agent-1',
        registration: status('waiting'),
        onError,
      }),
    );

    await advance(2000);
    await advance(2000);

    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('temporary failure');
    expect(fetchRegistration).toHaveBeenCalledTimes(2);
  });
});
