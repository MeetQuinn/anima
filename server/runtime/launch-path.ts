import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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
 * this cwd, runs. Node's spawn looks the command up the way execvp does, in the
 * child after it changes to `cwd`: a command with a slash is used as given, and
 * otherwise each PATH entry in turn, an empty entry meaning the cwd. Candidates are
 * joined as strings, not normalized, so the file system resolves `..` after a
 * directory link the same way it does for the child. Undefined when nothing matches.
 */
export async function launchExecutable(command: string, path: string, cwd: string): Promise<string | undefined> {
  const fromCwd = (file: string) => (isAbsolute(file) ? file : `${cwd}/${file}`);
  const candidates = command.includes('/')
    ? [fromCwd(command)]
    : path.split(delimiter).map((entry) => fromCwd(entry ? `${entry}/${command}` : command));
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
