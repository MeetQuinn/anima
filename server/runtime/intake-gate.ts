import { isRestartDrainActive as defaultIsRestartDrainActive } from '../services/restart-drain.js';

/**
 * Fail-closed intake gate for config-reload pause / restart-drain.
 *
 * Always awaits the restart-drain probe first, then re-reads pause/closing
 * synchronously with **no further await**. That closes the race where
 * `if (paused || await drain)` samples pause before the drain await and can
 * still proceed after pause flips mid-flight.
 */
export async function isIntakeBlocked(input: {
  isPaused: () => boolean;
  isClosing?: () => boolean;
  isRestartDrainActive?: () => Promise<boolean>;
}): Promise<boolean> {
  const drainActive = await (input.isRestartDrainActive ?? defaultIsRestartDrainActive)();
  // Synchronous re-read only from here to return.
  if (input.isClosing?.()) return true;
  if (input.isPaused()) return true;
  return drainActive;
}
