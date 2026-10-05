import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Write a server answer into a key that may also be polled.
 *
 * TanStack applies every fetch result it has not cancelled, so a poll that
 * left BEFORE this write would land after it and put the older answer back.
 * Cancel only this exact key, wait for the cancel, then write.
 *
 * This orders an out-of-band write against in-flight query fetches only. It
 * does not order two out-of-band fetches against each other (see the tick in
 * `useRuntimeUpgradeAction`, which inlines these steps to keep its unmount
 * guard between them).
 */
export async function cancelThenSetQueryData<T>(
  client: QueryClient,
  queryKey: QueryKey,
  value: T,
): Promise<void> {
  await client.cancelQueries({ queryKey, exact: true });
  client.setQueryData<T>(queryKey, value);
}
