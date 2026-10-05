import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { cancelThenSetQueryData } from './query-write';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

it('cancels the in-flight fetch of the exact key it writes, and no other', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const target = deferred<string>();
  const child = deferred<string>();
  const sibling = deferred<string>();
  const fetches = [
    client.fetchQuery({ queryKey: ['race', 'a'], queryFn: () => target.promise }).catch(() => 'cancelled'),
    client.fetchQuery({ queryKey: ['race', 'a', 'child'], queryFn: () => child.promise }),
    client.fetchQuery({ queryKey: ['race', 'b'], queryFn: () => sibling.promise }),
  ];

  await cancelThenSetQueryData(client, ['race', 'a'], 'written');
  target.resolve('stale');
  child.resolve('child-fresh');
  sibling.resolve('sibling-fresh');

  expect(await Promise.all(fetches)).toEqual(['cancelled', 'child-fresh', 'sibling-fresh']);
  expect(client.getQueryData(['race', 'a'])).toBe('written');
  expect(client.getQueryData(['race', 'a', 'child'])).toBe('child-fresh');
  expect(client.getQueryData(['race', 'b'])).toBe('sibling-fresh');
  client.clear();
});
