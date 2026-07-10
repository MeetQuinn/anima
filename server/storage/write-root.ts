import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveAnimaHome } from '../anima-home.js';

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function rootIsGone(root: string, target: string): Error {
  return new Error(
    `Refusing to write ${target}: write root ${root} does not exist. ` +
      'A write must not recreate the root it belongs to. If this runtime should be ' +
      'running, start it so the root is created deliberately; if it was decommissioned, ' +
      'this write is arriving after teardown.',
  );
}

/**
 * True when `path` is `root` itself or a descendant of it.
 *
 * Segment semantics, not string-prefix semantics. `relative()` returning
 * something that starts with the two characters '..' does not mean the path
 * escapes the root: `home/..state` is a legitimate descendant whose relative
 * path is '..state'. Only a leading '..' *segment* climbs out.
 */
export function isUnderRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false; // different volume on win32
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * The write root currently in effect. Capture this once, when a storage object
 * is constructed, and hold it for that object's lifetime.
 *
 * `resolveAnimaHome()` picks a cwd-local `.anima` *only while that directory
 * exists*, and otherwise falls back to `~/.anima`. So the root is not a stable
 * fact about the process: delete the local home and the "root" silently becomes
 * a different directory. A guard that re-derives the root on every write will,
 * after teardown, decide the doomed path was never inside the root at all - and
 * happily recreate it. Root identity must outlive the directory it names.
 */
export function currentWriteRoot(): string {
  return resolve(resolveAnimaHome());
}

/**
 * Create the parent directory of `path` without ever creating `root`.
 *
 * Inside the root, directories are created one segment at a time with
 * **non-recursive** `mkdir`, anchored at the root. A non-recursive `mkdir`
 * cannot manufacture its own parent, so no call in this walk is capable of
 * recreating the root: if the root vanishes before or during the walk, the very
 * next `mkdir` fails with ENOENT. That is a structural property, not a checked
 * one - there is no window between "we looked" and "we wrote" in which a delete
 * can slip through, because the dangerous operation does not exist here.
 *
 * (`mkdir(dirname(path), { recursive: true })` is exactly that dangerous
 * operation, and it is why an operator's `rm -rf` raced a late health flush and
 * lost.)
 *
 * Paths outside the root are none of this guard's business and keep the old
 * recursive behavior.
 */
export async function ensureParentDirectory(path: string, root: string): Promise<void> {
  const target = resolve(path);
  const writeRoot = resolve(root);
  const parent = dirname(target);

  if (!isUnderRoot(writeRoot, parent)) {
    await mkdir(parent, { recursive: true });
    return;
  }

  const rel = relative(writeRoot, parent);
  const segments = rel === '' ? [] : rel.split(sep);

  // parent === root: nothing to create. The root must already exist.
  if (segments.length === 0) {
    if (!(await isDirectory(writeRoot))) throw rootIsGone(writeRoot, target);
    return;
  }

  let current = writeRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current); // non-recursive: cannot create `current`'s parent
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST') continue;
      // The parent of `current` is missing, which - walking down from the root -
      // means the root (or a segment we just made) was removed underneath us.
      if (code === 'ENOENT') throw rootIsGone(writeRoot, target);
      throw error;
    }
  }
}

/**
 * Create the write root deliberately. Called by the acts that genuinely
 * provision - runtime startup, and the CLI commands that write config - so that
 * every later write can assert the root rather than manufacture it.
 */
export async function ensureAnimaHome(): Promise<void> {
  await mkdir(currentWriteRoot(), { recursive: true });
}
