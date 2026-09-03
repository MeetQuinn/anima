import type { AgentStatusSummary } from '@shared/snapshot';

export type AgentDisplayState = 'background' | 'idle' | 'queued' | 'working';

export interface AgentWorkState {
  backgroundTaskCount?: number;
  state: AgentDisplayState;
}

export function agentWorkState(status: AgentStatusSummary | undefined): AgentWorkState {
  const providerWork = status?.health?.runtime?.providerWork;
  if (status?.currentItemId || providerWork?.state === 'working') {
    return {
      ...(providerWork?.backgroundTaskCount !== undefined
        ? { backgroundTaskCount: providerWork.backgroundTaskCount }
        : {}),
      state: 'working',
    };
  }
  if (providerWork?.state === 'background') {
    return {
      ...(providerWork.backgroundTaskCount !== undefined
        ? { backgroundTaskCount: providerWork.backgroundTaskCount }
        : {}),
      state: 'background',
    };
  }
  if ((status?.queueDepth ?? 0) > 0) return { state: 'queued' };
  return { state: 'idle' };
}

export function agentWorkStateLabel(work: AgentWorkState): string {
  if (work.state !== 'background') {
    return work.state === 'working'
      ? work.backgroundTaskCount
        ? `Working · Background ${work.backgroundTaskCount}`
        : 'Working'
      : work.state === 'queued'
        ? 'Queued'
        : 'Idle';
  }
  return work.backgroundTaskCount
    ? `Background · ${work.backgroundTaskCount}`
    : 'Background';
}
