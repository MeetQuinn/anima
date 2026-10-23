import { useSyncExternalStore } from 'react';

// All connection surfaces must cross the stale/attention boundaries together.
let now = new Date();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const getSnapshot = () => now;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = new Date();
    timer = setInterval(() => {
      now = new Date();
      for (const notify of listeners) notify();
    }, 5_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useConnectionNow(): Date {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
