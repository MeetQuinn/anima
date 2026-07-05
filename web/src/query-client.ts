import { QueryClient } from '@tanstack/react-query';

// App-level defaults. `retry: 1` instead of TanStack's default 3: the server
// is local, so a failure is a real outage, not a transient network blip —
// surface error states after one retry instead of several seconds of backoff.
// Everything else (staleTime 0, refetchOnWindowFocus) stays at defaults;
// per-query polling policy lives with the queries (see lib/query-keys.ts).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
    },
  },
});
