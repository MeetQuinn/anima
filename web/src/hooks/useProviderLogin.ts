import { useQuery } from '@tanstack/react-query';

import { fetchProviderLogin } from '@/api/system';
import { queryKeys } from '@/lib/query-keys';

const ACTIVE_POLL_MS = 2_000; // a sign-in is running — follow it to the result

/**
 * Provider sign-in state for the Providers panel. The server runs each
 * provider's own `login status` (cached briefly), so this only polls while a
 * sign-in is in flight; the rest of the time the panel's refresh re-reads it.
 */
export function useProviderLogin() {
  return useQuery({
    queryKey: queryKeys.providerLogin(),
    queryFn: () => fetchProviderLogin(),
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.providers.some((row) => row.operation.status === 'running') ? ACTIVE_POLL_MS : false,
  });
}
