import { terminateChildProcess } from './child-process.js';
import { watchProviderCompletion } from './completion-watch.js';

const TERMINATION_GRACE_MS = 5_000;

interface SlotController {
  completion: Promise<unknown>;
  kill(signal?: NodeJS.Signals): void;
}

// Owns a provider runtime's single long-lived controller: installs it, clears
// the reference once the child settles, and tears it down on reset. Claude,
// Codex, Grok, Kimi, and OpenCode share this lifecycle.
export class ProviderControllerSlot<C extends SlotController> {
  private current?: C;
  private resetting?: Promise<void>;

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

  pendingReset(): Promise<void> | undefined {
    return this.resetting;
  }

  reset(signal: NodeJS.Signals = 'SIGTERM', options: { forceAfterMs?: number } = {}): Promise<void> {
    const controller = this.current;
    if (!controller) return this.resetting ?? Promise.resolve();
    // Keep ownership until exit: a concurrent restart must still be able to
    // escalate an earlier abort, and health must still expose the live child.
    const resetting = terminateChildProcess(controller, {
      signal,
      forceAfterMs: options.forceAfterMs ?? TERMINATION_GRACE_MS,
    }).then(() => {}).finally(() => {
      if (this.current === controller) this.current = undefined;
      if (this.resetting === resetting) this.resetting = undefined;
    });
    this.resetting = resetting;
    return resetting;
  }
}
