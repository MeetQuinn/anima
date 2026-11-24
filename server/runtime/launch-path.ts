import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The PATH a provider child runs with: Anima's own `bin` first, then the agent's
 * provider env PATH, or the service's when the agent sets none. The provider
 * command itself is looked up on it.
 */
export function runtimeLaunchPath(env?: Record<string, string>): string {
  const binDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'bin');
  return [binDir, env?.['PATH'] ?? process.env.PATH ?? ''].filter(Boolean).join(':');
}
