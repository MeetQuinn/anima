import type { AgentRuntimeInput } from './contract.js';

export class ActiveRuntimeRun {
  private activeItemId?: string;

  start(input: AgentRuntimeInput, label: string, abort: (signal?: NodeJS.Signals) => void): () => void {
    if (this.activeItemId) throw new Error(`${label} runtime is already running ${this.activeItemId}`);
    this.activeItemId = input.itemId;
    const onAbort = (): void => abort('SIGTERM');
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
}
