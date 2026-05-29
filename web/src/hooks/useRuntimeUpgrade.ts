import { useQuery } from '@tanstack/react-query';
import { fetchRuntimeUpgrade } from '@/api/system';
import { queryKeys } from '@/lib/query-keys';

const IDLE_POLL_MS = 5 * 60_000; // resting: pick up a newly-available update
const ACTIVE_POLL_MS = 3_000; // an upgrade is scheduled/running — track it to completion

/**
 * Shared system-update status query. The panel and the sidebar resting dot both
 * read it; TanStack dedupes by key so it's a single request. The endpoint
 * returns cached state immediately and refreshes in the background, so a modest
 * resting poll is cheap; it tightens automatically while an upgrade is in flight.
 */
export function useRuntimeUpgrade() {
  return useQuery({
    queryKey: queryKeys.runtimeUpgrade(),
    queryFn: fetchRuntimeUpgrade,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const status = query.state.data?.operation.status;
      return status === 'scheduled' || status === 'running' ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    },
  });
}

/** Resting indicator — true only when an update is actually available. */
export function useUpdateAvailable(): boolean {
  const { data } = useRuntimeUpgrade();
  return data?.state === 'available';
}
