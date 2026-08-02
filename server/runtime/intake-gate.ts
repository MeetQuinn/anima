import { isRestartDrainActive as defaultIsRestartDrainActive } from '../services/restart-drain.js';

/**
 * Await the restart-drain probe only. Callers must then **synchronously**
 * re-read closing/intakePaused and start run/append/requeue in the same
 * continuation — no further `await` of a helper that already sampled pause
 * (that would open a second microtask slot for pause to flip).
 */
export async function readRestartDrainActive(
  isRestartDrainActive: () => Promise<boolean> = defaultIsRestartDrainActive,
): Promise<boolean> {
  return isRestartDrainActive();
}
