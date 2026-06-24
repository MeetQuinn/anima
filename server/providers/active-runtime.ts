import type { AgentRuntimeInput } from './contract.js';
import { errorMessage } from '../ids.js';

export class ActiveRuntimeRun {
  private activeItemId?: string;

  start(input: AgentRuntimeInput, label: string, abort: (signal?: NodeJS.Signals) => Promise<void> | void): () => void {
    if (this.activeItemId) throw new Error(`${label} runtime is already running ${this.activeItemId}`);
    this.activeItemId = input.itemId;
    const onAbort = (): void => {
      try {
        void Promise.resolve(abort('SIGTERM')).catch((error: unknown) => {
          console.error(`${label} runtime abort failed: ${errorMessage(error)}`);
        });
      } catch (error) {
        console.error(`${label} runtime abort failed: ${errorMessage(error)}`);
      }
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }
    return () => {
      if (input.signal) input.signal.removeEventListener('abort', onAbort);
      if (this.activeItemId === input.itemId) this.activeItemId = undefined;
    };
  }

  accepts(input: { activeItemId: string }): boolean {
    return this.activeItemId === input.activeItemId;
  }

  isActive(): boolean {
    return Boolean(this.activeItemId);
  }
}
