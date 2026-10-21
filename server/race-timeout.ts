/**
 * Resolves with `promise`'s value, or with `fallback` once `ms` pass. The timer
 * is cleared as soon as either side wins, so a promise that settles quickly
 * leaves no timer holding the process open.
 */
export async function raceWithTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
