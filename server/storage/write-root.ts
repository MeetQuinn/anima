import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { resolveAnimaHome } from '../anima-home.js';

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  // '' means path === root. A relative path that climbs out ('..') or is
  // absolute (different volume on win32) is outside the root.
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Create the parent directory of `path`, but never manufacture the ANIMA_HOME
 * root itself.
 *
 * `mkdir(..., { recursive: true })` on a write path will happily rebuild every
 * missing ancestor, including a home an operator just deleted. That turns a
 * write into a thing that creates its own precondition, so a write issued after
 * teardown silently resurrects the runtime's home instead of failing. The home
 * then half-exists, and any check of the form "the home exists, so this runtime
 * is provisioned" reads a directory that one dying writer invented.
 *
 * Creating a home is a deliberate act (install, init, start). Writing a health
 * snapshot is not. So: directories *beneath* an existing home are created on
 * demand as before; a missing home is an error, loudly, at the point of use.
 *
 * Paths outside ANIMA_HOME (temp dirs, explicit destinations) are unaffected.
 */
export async function ensureParentDirectory(path: string): Promise<void> {
  const target = resolve(path);
  const home = resolve(resolveAnimaHome());

  if (isUnder(home, target) && !(await isDirectory(home))) {
    throw new Error(
      `Refusing to write ${target}: ANIMA_HOME ${home} does not exist. ` +
        'A write must not recreate the home it belongs to. If this runtime should be ' +
        'running, start it so the home is created deliberately; if it was decommissioned, ' +
        'this write is arriving after teardown.',
    );
  }

  await mkdir(dirname(target), { recursive: true });
}

/**
 * Create the ANIMA_HOME root deliberately. Called once at startup, so that
 * every later write can assert the root rather than manufacture it.
 */
export async function ensureAnimaHome(): Promise<void> {
  await mkdir(resolve(resolveAnimaHome()), { recursive: true });
}
