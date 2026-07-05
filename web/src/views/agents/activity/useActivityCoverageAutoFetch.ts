import { useEffect } from 'react';

export function useActivityCoverageAutoFetch(input: {
  shouldFetchMoreActivity: boolean;
  fetchNextActivityPage: () => Promise<unknown>;
}) {
  const { shouldFetchMoreActivity, fetchNextActivityPage } = input;
  useEffect(() => {
    if (!shouldFetchMoreActivity) return;
    void fetchNextActivityPage();
  }, [shouldFetchMoreActivity, fetchNextActivityPage]);
}
