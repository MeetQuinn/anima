import { realpath, stat } from 'node:fs/promises';
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
 * A fingerprint of every file `command` could start as on this PATH: for each entry
 * in order, the real path, inode, size and change time of `<entry>/<command>`, or a
 * gap. Relinking or reinstalling any candidate changes it. It does not say which
 * candidate a child runs (exec falls through a candidate whose interpreter is gone,
 * and a shim can pick a version per directory); it only tells whether the files a
 * launch could reach are still the ones they were.
 */
export async function launchCandidatesFingerprint(command: string, path: string, cwd: string): Promise<string> {
  const files = command.includes('/')
    ? [command]
    : path.split(delimiter).map((entry) => (entry ? `${entry}/${command}` : command));
  const parts = await Promise.all(
    files.map(async (file) => {
      try {
        const real = await realpath(isAbsolute(file) ? file : `${cwd}/${file}`);
        const info = await stat(real);
        return [real, info.ino, info.size, info.ctimeMs].join(':');
      } catch {
        return '-';
      }
    }),
  );
  return parts.join('\n');
}
