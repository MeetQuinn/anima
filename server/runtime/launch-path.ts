import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
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

/**
 * Real path of the executable that a child spawned as `command`, with this PATH and
 * this cwd, runs. The lookup happens in the child after it changes to `cwd`, so a
 * relative command or PATH entry resolves there. Undefined when nothing matches.
 */
export async function launchExecutable(command: string, path: string, cwd: string): Promise<string | undefined> {
  const candidates = command.includes('/')
    ? [resolve(cwd, command)]
    : path.split(delimiter).filter(Boolean).map((entry) => resolve(cwd, entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return await realpath(candidate);
    } catch {
      // try the next PATH entry
    }
  }
  return undefined;
}
