import { terminateChildProcess } from './child-process.js';
import { watchProviderCompletion } from './completion-watch.js';

interface SlotController {
  completion: Promise<unknown>;
  kill(signal?: NodeJS.Signals): void;
}

// Owns a provider runtime's single long-lived controller: installs it, clears
// the reference once the child settles, and tears it down on reset. Claude,
// Codex, Grok, and Kimi share this lifecycle.
export class ProviderControllerSlot<C extends SlotController> {
  private current?: C;

  get(): C | undefined {
    return this.current;
  }

  install(controller: C): C {
    this.current = controller;
    watchProviderCompletion(controller.completion, () => {
      if (this.current === controller) this.current = undefined;
    });
    return controller;
  }

  async reset(signal: NodeJS.Signals = 'SIGTERM', options: { forceAfterMs?: number } = {}): Promise<void> {
    const controller = this.current;
    if (!controller) return;
    this.current = undefined;
    await terminateChildProcess(controller, {
      signal,
      ...(options.forceAfterMs === undefined ? {} : { forceAfterMs: options.forceAfterMs }),
    });
  }
}
