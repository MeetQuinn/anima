import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { withAnimaHome } from '../anima-home.js';
import { JsonFile } from '../storage/json-file.js';
import { JsonlAppendLog } from '../storage/jsonl-log.js';
import { ensureAnimaHome, ensureParentDirectory } from '../storage/write-root.js';

const scratch: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nora-write-root-'));
  scratch.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

after(async () => {
  for (const dir of scratch) await rm(dir, { force: true, recursive: true });
});

// The defect this file exists for: a write after teardown rebuilt the ANIMA_HOME
// an operator had just deleted. `mkdir(..., { recursive: true })` in the write
// path manufactured every missing ancestor, so the home came back holding
// whatever that one late writer emitted. Anything reading "the home exists" as
// "this runtime is provisioned" then read a directory invented by a dying process.

test('a write into a deleted ANIMA_HOME fails loudly instead of recreating it', async () => {
  const home = await tempHome();
  await withAnimaHome(home, async () => {
    const file = new JsonFile<{ n: number }>(join(home, 'run', 'health.json'), () => ({ n: 0 }));
    await file.write({ n: 1 });
    assert.ok(await exists(join(home, 'run', 'health.json')), 'first write should create run/ under a live home');

    // Operator decommissions the runtime.
    await rm(home, { force: true, recursive: true });

    // A late flush arrives. It must not resurrect the home.
    await assert.rejects(
      () => file.write({ n: 2 }),
      /ANIMA_HOME .* does not exist/,
      'a post-teardown write must reject, not rebuild the home',
    );
    assert.equal(await exists(home), false, 'the home must stay deleted');
  });
});

test('the append log also refuses to resurrect a deleted home', async () => {
  const home = await tempHome();
  await withAnimaHome(home, async () => {
    const log = new JsonlAppendLog<{ event: string }>(join(home, 'run', 'activity.jsonl'));
    await log.append({ event: 'started' });
    assert.ok(await exists(join(home, 'run', 'activity.jsonl')));

    await rm(home, { force: true, recursive: true });

    await assert.rejects(() => log.append({ event: 'late' }), /ANIMA_HOME .* does not exist/);
    assert.equal(await exists(home), false, 'the home must stay deleted');
  });
});

// The lock runs before writeAtomic and used to mkdir the parent itself. Guarding
// only json-file.ts would have left the resurrection path wide open, because the
// lock rebuilt the tree before the write ever ran.
test('the file lock does not recreate the home either', async () => {
  const home = await tempHome();
  await withAnimaHome(home, async () => {
    const file = new JsonFile<{ n: number }>(join(home, 'run', 'locked.json'), () => ({ n: 0 }));
    await file.write({ n: 1 });
    await rm(home, { force: true, recursive: true });

    await assert.rejects(() => file.update((c) => ({ n: c.n + 1 })), /ANIMA_HOME .* does not exist/);
    assert.equal(await exists(home), false, 'the lock must not rebuild the home');
    assert.equal(await exists(`${join(home, 'run', 'locked.json')}.lock`), false, 'no lock dir left behind');
  });
});

// Cold start must still work: creating a home is a deliberate act, and
// directories beneath a live home are still created on demand.
test('subdirectories beneath a live home are still created on demand', async () => {
  const home = await tempHome();
  await withAnimaHome(home, async () => {
    const file = new JsonFile<{ ok: boolean }>(join(home, 'deep', 'nested', 'x.json'), () => ({ ok: false }));
    await file.write({ ok: true });
    assert.deepEqual(await file.read(), { ok: true }, 'nested dirs under a live home are created as before');
  });
});

test('ensureAnimaHome creates the root deliberately, and then writes succeed', async () => {
  const parent = await tempHome();
  const home = join(parent, 'fresh-home');
  await withAnimaHome(home, async () => {
    assert.equal(await exists(home), false, 'precondition: home absent');
    await ensureAnimaHome();
    assert.ok(await exists(home), 'ensureAnimaHome creates the root');

    const file = new JsonFile<{ n: number }>(join(home, 'run', 'a.json'), () => ({ n: 0 }));
    await file.write({ n: 7 });
    assert.deepEqual(await file.read(), { n: 7 });
  });
});

// Paths outside ANIMA_HOME are none of this guard's business.
test('paths outside ANIMA_HOME are unaffected and still create parents', async () => {
  const home = await tempHome();
  const elsewhere = await tempHome();
  await withAnimaHome(home, async () => {
    await rm(home, { force: true, recursive: true });
    const target = join(elsewhere, 'sub', 'dir', 'out.txt');
    await ensureParentDirectory(target);
    await writeFile(target, 'hi', 'utf8');
    assert.ok(await exists(target), 'a write outside a missing home is allowed');
  });
});

// A sibling directory whose name merely starts with the home path is not "under" it.
test('a sibling path sharing the home prefix is not treated as inside the home', async () => {
  const parent = await tempHome();
  const home = join(parent, 'home');
  const sibling = join(parent, 'home-backup', 'f.json');
  await mkdir(join(parent, 'home-backup'), { recursive: true });
  await withAnimaHome(home, async () => {
    assert.equal(await exists(home), false, 'home absent');
    await ensureParentDirectory(sibling); // must not throw
    await writeFile(sibling, '{}', 'utf8');
    assert.ok(await exists(sibling));
  });
});
