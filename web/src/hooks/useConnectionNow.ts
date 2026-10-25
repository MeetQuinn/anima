import { focusManager } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';

// All connection surfaces must cross the stale/attention boundaries together.
let clock = { now: new Date(), resumedAt: Date.now() };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribeFocus: (() => void) | undefined;
const getSnapshot = () => clock;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    clock = { now: new Date(), resumedAt: Date.now() };
    timer = setInterval(() => {
      clock = { ...clock, now: new Date() };
      notify();
    }, 5_000);
    unsubscribeFocus = focusManager.subscribe((focused) => {
      if (!focused) return;
      clock = { now: new Date(), resumedAt: Date.now() };
      notify();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
      unsubscribeFocus?.();
      unsubscribeFocus = undefined;
    }
  };
}

export function useConnectionNow(): Date {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).now;
}

// A cached snapshot predating this view or foreground visit is not a new
// runtime observation. Allow its refresh to settle before reporting staleness.
export function useConnectionRevalidation(query: {
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}): number | undefined {
  const [mountedAt] = useState(Date.now);
  const { now, resumedAt } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const since = Math.max(mountedAt, resumedAt);
  const pending =
    query.dataUpdatedAt < since && query.errorUpdatedAt < since && now.getTime() - since < 10_000;
  return pending ? query.dataUpdatedAt : undefined;
}
