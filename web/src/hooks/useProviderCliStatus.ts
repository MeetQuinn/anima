import { useQuery } from '@tanstack/react-query';

import { fetchProviderCliStatus } from '@/api/system';
import { queryKeys } from '@/lib/query-keys';

const STATUS_POLL_MS = 60 * 60 * 1000;

export function useProviderCliStatus() {
  return useQuery({
    queryKey: queryKeys.providerCliStatus(),
    queryFn: fetchProviderCliStatus,
    refetchInterval: STATUS_POLL_MS,
    staleTime: 5 * 60 * 1000,
  });
}
