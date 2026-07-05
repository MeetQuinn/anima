import { useQuery } from '@tanstack/react-query';

import { fetchAgents, fetchAgentStatuses } from '@/api/agents';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';

export function useAgents() {
  return useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
}

export function useAgentStatuses(options?: { poll?: boolean }) {
  return useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
    ...(options?.poll ? { refetchInterval: refetchIntervals.agentStatuses } : {}),
  });
}
