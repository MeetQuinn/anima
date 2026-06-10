interface QuiescentWaiter {
  cleanup(): void;
  reject(error: unknown): void;
  resolve(): void;
}

export class QuiescentWaiterSet {
  private readonly waiters = new Set<QuiescentWaiter>();

  waitUntilReady(isReady: () => boolean, signal?: AbortSignal): Promise<void> {
    if (isReady()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let waiter!: QuiescentWaiter;
      const onAbort = () => waiter.reject(signal?.reason ?? new Error('Drain wait aborted'));
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Drain wait aborted'));
        return;
      }
      waiter = {
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort);
          this.waiters.delete(waiter);
        },
        reject: (error: unknown) => {
          waiter.cleanup();
          reject(error);
        },
        resolve: () => {
          waiter.cleanup();
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  resolveIfReady(isReady: () => boolean): void {
    if (!isReady()) return;
    for (const waiter of [...this.waiters]) waiter.resolve();
  }

  reject(error: unknown): void {
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }
}
