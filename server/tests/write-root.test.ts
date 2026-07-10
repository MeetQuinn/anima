import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { withAnimaHome } from '../anima-home.js';
import { AgentHealthStore } from '../runtime/agent-health.store.js';
import { AgentRestartCommandStore } from '../runtime/agent-restart-command.store.js';
import { JsonFile } from '../storage/json-file.js';
import { JsonStore } from '../storage/json-store.js';
import { JsonlAppendLog } from '../storage/jsonl-log.js';
import { RuntimeHost } from '../runtime/host.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';
import { ensureAnimaHome, ensureParentDirectory } from '../storage/write-root.js';

const scratch: string[] = [];

async function tempHome(): Promise<string> {
  // realpath: on macOS mkdtemp yields /var/... while process.cwd() reports the
  // resolved /private/var/..., and a root captured from cwd must compare equal
  // to the paths built from it.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nora-write-root-')));
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
      /does not exist/,
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

    await assert.rejects(() => log.append({ event: 'late' }), /does not exist/);
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

    await assert.rejects(() => file.update((c) => ({ n: c.n + 1 })), /does not exist/);
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
    await ensureParentDirectory(target, home);
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
    await ensureParentDirectory(sibling, home); // must not throw
    await writeFile(sibling, '{}', 'utf8');
    assert.ok(await exists(sibling));
  });
});

// --- Milo's code-gate findings on bbcea268. Each of these passes a resurrection
// --- through the first version of the guard. All three fail against it.

// BLOCKER 2. resolveAnimaHome() selects a cwd-local `.anima` only while that
// directory exists, and falls back to ~/.anima once it does not. A guard that
// re-derives the root on every write therefore decides, *after* teardown, that
// the doomed path was never inside the root - and recreates it recursively.
// Root identity has to outlive the directory it names.
test('the write root is captured at construction, not re-derived after the root is deleted', async () => {
  const parent = await tempHome();
  const home = join(parent, '.anima');
  await mkdir(home, { recursive: true });

  // No ANIMA_HOME, no scope: the root is chosen by looking at the filesystem.
  const previousCwd = process.cwd();
  const previousEnv = process.env.ANIMA_HOME;
  delete process.env.ANIMA_HOME;
  process.chdir(parent);
  try {
    const file = new JsonFile<{ n: number }>(join(home, 'run', 'health.json'), () => ({ n: 0 }));
    await file.write({ n: 1 });

    await rm(home, { force: true, recursive: true });

    // Re-deriving here yields ~/.anima, which does not contain `home`.
    await assert.rejects(
      () => file.write({ n: 2 }),
      /does not exist/,
      'a late write must not be re-homed onto a different root and recreated',
    );
    assert.equal(await exists(home), false, 'the deleted local home must stay deleted');
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousEnv;
  }
});

// SHOULD-FIX. `relative()` returning a string that starts with '..' does not mean
// the path escaped the root: `<home>/..state` is a descendant whose relative path
// is '..state'. String-prefix semantics classified it as outside and recreated it.
test('a descendant whose name begins with dots is inside the root, not outside it', async () => {
  const parent = await tempHome();
  const home = join(parent, 'home');
  await withAnimaHome(home, async () => {
    assert.equal(await exists(home), false, 'precondition: home absent');
    const file = new JsonFile<{ n: number }>(join(home, '..state', 'x.json'), () => ({ n: 0 }));
    await assert.rejects(() => file.write({ n: 1 }), /does not exist/);
    assert.equal(await exists(home), false, 'a `..`-prefixed descendant must not resurrect the root');
  });

  // ...and it is still a normal, creatable descendant when the root is alive.
  await mkdir(home, { recursive: true });
  await withAnimaHome(home, async () => {
    const file = new JsonFile<{ n: number }>(join(home, '..state', 'x.json'), () => ({ n: 0 }));
    await file.write({ n: 7 });
    assert.deepEqual(await file.read(), { n: 7 }, 'dot-prefixed descendants still work');
  });
});

// BLOCKER 1. The guard used to stat() the root and then call
// mkdir(parent, { recursive: true }). A delete landing between those two awaits
// walks straight through - which is exactly this defect: an operator's `rm`
// racing a late flush.
//
// There is deliberately NO black-box race test here, and that is a finding.
//
// The old guard and this one differ only *inside* the window between the root
// check and the recursive mkdir. I tried three ways to open that window from
// outside and measured every one of them:
//
//   - delete scheduled with setImmediate: passed locally, never interleaved on
//     CI (its own "did we actually race?" assertion caught that).
//   - delete triggered causally off the walk's first mkdir, 120 segments deep,
//     25 attempts: the watcher fired 19 times and the walk threw 0 times. The
//     rm never finished before the walk did.
//   - the same, against the OLD guard: it "failed", but only on the runs where
//     the watcher never fired and the root was therefore never deleted. A
//     vacuous failure, not a caught resurrection.
//
// A test that never establishes the condition it names does not pin it, however
// green or red it happens to come out. That is the {ok:true} stub again, wearing
// a race's clothes. So the race is pinned where it is actually decidable: by the
// invariant below. No recursive mkdir exists inside the root, so there is no
// window to lose - not a narrower window, none.

// The structural claim behind BLOCKER 1's fix, stated directly: inside the root
// the walk creates one segment at a time and never with `recursive: true`, so no
// single call in it is *capable* of manufacturing a missing parent. A property
// nobody pins is a property somebody reintroduces.
test('the in-root walk never uses a recursive mkdir', async () => {
  // Tests run compiled, from the repo root; read the TypeScript source.
  const source = await readFile(join(process.cwd(), 'server', 'storage', 'write-root.ts'), 'utf8');
  const walk = source.slice(source.indexOf('let current = writeRoot;'), source.indexOf('export async function ensureAnimaHome'));
  assert.ok(walk.length > 0, 'located the in-root walk');
  assert.equal(walk.includes('recursive: true'), false, 'the in-root walk must not contain a recursive mkdir');
});

// --- Milo's re-gate finding on ba72e43e. Capturing the root inside JsonFile put
// --- it one layer too low: JsonStore built a new JsonFile per operation, so the
// --- capture lasted exactly one call and every write re-derived the root. The
// --- production wrappers all go through JsonStore, so the guard was live only
// --- for code that held a JsonFile directly - which nothing does.

const healthSummary = { agentId: 'a1', state: 'healthy' as const, updatedAt: new Date(0).toISOString() };

test('AgentHealthStore refuses to resurrect its home across operations', async () => {
  const parent = await tempHome();
  const home = join(parent, '.anima');
  await mkdir(join(home, 'run'), { recursive: true });

  const store = new AgentHealthStore({ animaHome: home });
  await store.update('a1', () => healthSummary);
  assert.ok(await exists(store.path()), 'precondition: the first update wrote the snapshot file');

  await rm(home, { force: true, recursive: true });

  await assert.rejects(() => store.update('a1', () => healthSummary), /does not exist/);
  assert.equal(await exists(home), false, 'the health store must not rebuild the home');
});

test('AgentRestartCommandStore refuses to resurrect its home across operations', async () => {
  const parent = await tempHome();
  const home = join(parent, '.anima');
  await mkdir(join(home, 'run'), { recursive: true });

  const store = new AgentRestartCommandStore({ animaHome: home });
  await store.request('a1');
  assert.ok(await exists(store.path()), 'precondition: the first request wrote the file');

  await rm(home, { force: true, recursive: true });

  await assert.rejects(() => store.request('a1'), /does not exist/);
  assert.equal(await exists(home), false, 'the restart store must not rebuild the home');
});

// Milo's second re-gate finding. RuntimeHost captures deps.animaHome and hands
// that authority to every store it owns, but start() provisioned the *ambient*
// root. With an explicit home X and an ambient home Y, startup created Y and
// then the X-rooted stores correctly refused to write to an X nobody made. The
// same cross-authority hole, one layer above the stores.
test('startup provisions the home the host was given, not the ambient one', async () => {
  const parent = await tempHome();
  const explicitHome = join(parent, 'host-home'); // X: absent, must be created
  const ambient = join(parent, '.anima'); // Y: absent, must stay absent

  // The ambient root has to be a real, nameable directory or the assertion below
  // is vacuous: with no .anima present, resolveAnimaHome() falls back to
  // ~/.anima, and "the ambient root was not created" is then trivially true of
  // `parent/.anima` no matter what the code did. (It also means a regression
  // would mkdir the developer's real home.)
  const previousEnv = process.env.ANIMA_HOME;
  process.env.ANIMA_HOME = ambient;
  try {
    await ensureAnimaHome(explicitHome);
    assert.ok(await exists(explicitHome), 'the explicit home is created');
    assert.equal(await exists(ambient), false, 'the ambient home is left untouched');

    // And the stores built with that authority can now write into it.
    const store = new AgentHealthStore({ animaHome: explicitHome });
    await store.update('a1', () => healthSummary);
    assert.ok(await exists(store.path()), 'a store rooted at the provisioned home writes');
    assert.equal(await exists(ambient), false, 'still nothing at the ambient root');
  } finally {
    if (previousEnv === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousEnv;
  }
});

// The test above pins ensureAnimaHome(root). It would still pass if start() kept
// calling the parameterless form, so it does not pin the caller. This one drives
// the real RuntimeHost.start() and fails if start() provisions the ambient root.
test('RuntimeHost.start() creates its own explicit home and no other', async () => {
  const parent = await tempHome();
  const explicitHome = join(parent, 'host-home');
  const ambient = join(parent, '.anima');

  const previousEnv = process.env.ANIMA_HOME;
  process.env.ANIMA_HOME = ambient; // a real ambient root, so its creation is detectable
  const host = new RuntimeHost({}, {
    animaHome: explicitHome,
    loadAgents: async () => [],
    logger: { error: () => {}, log: () => {} },
    startAgent: async () => {
      throw new Error('no agents in this fixture');
    },
    validateAgent: async () => {},
  });
  try {
    await host.start();
    assert.ok(await exists(explicitHome), 'start() provisions the home the host was given');
    assert.equal(await exists(ambient), false, 'start() must not provision the ambient root');
  } finally {
    await host.stop();
    if (previousEnv === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousEnv;
  }
});

// Milo measured the real symptom of the mismatch: startup provisioned the
// ambient root, and then `ensureDirectory()` - a recursive mkdir of <home>/run -
// quietly manufactured the runtime root a moment later. Both homes ended up on
// disk and nothing failed. Deliberate provisioning belongs to ensureAnimaHome
// and to nothing else, so these stores must not be able to create a root.
test('store ensureDirectory() creates beneath the root but never the root itself', async () => {
  const parent = await tempHome();
  const home = join(parent, 'runtime-home'); // never created

  const health = new AgentHealthStore({ animaHome: home });
  await assert.rejects(() => health.ensureDirectory(), /does not exist/);
  assert.equal(await exists(home), false, 'the health store must not provision the root');

  const restart = new AgentRestartCommandStore({ animaHome: home });
  await assert.rejects(() => restart.ensureDirectory(), /does not exist/);
  assert.equal(await exists(home), false, 'the restart store must not provision the root');

  // With the root provisioned deliberately, both create their run/ directory.
  await ensureAnimaHome(home);
  await health.ensureDirectory();
  await restart.ensureDirectory();
  assert.ok(await exists(join(home, 'run')), 'run/ is created beneath a live root');
});

// Found while auditing every JsonStore construction for the same shape: this one
// was not in the gate findings. It writes config.json, directly under the home.
test('ServerConfigStore refuses to resurrect its home across operations', async () => {
  const parent = await tempHome();
  const home = join(parent, '.anima');
  await mkdir(home, { recursive: true });

  const store = new ServerConfigStore(home);
  await store.write({});
  assert.ok(await exists(join(home, 'config.json')), 'precondition: the first write created config.json');

  await rm(home, { force: true, recursive: true });

  await assert.rejects(() => store.write({}), /does not exist/);
  assert.equal(await exists(home), false, 'the config store must not rebuild the home');
});

// The shared mechanism behind the rows above: one JsonFile per path, for the
// life of the store, so the root is captured once rather than per operation.
test('JsonStore captures the ambient write root once per path, not per operation', async () => {
  const parent = await tempHome();
  const home = join(parent, '.anima');
  await mkdir(home, { recursive: true });

  const previousCwd = process.cwd();
  const previousEnv = process.env.ANIMA_HOME;
  delete process.env.ANIMA_HOME;
  process.chdir(parent);
  try {
    const path = join(home, 'run', 'x.json');
    const store = new JsonStore<{ n: number }>({
      empty: () => ({ n: 0 }),
      parse: (value) => value as { n: number },
      path: () => path,
    });
    await store.write({ n: 1 });

    await rm(home, { force: true, recursive: true });

    await assert.rejects(() => store.write({ n: 2 }), /does not exist/);
    assert.equal(await exists(home), false, 'the deleted local home must stay deleted');
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousEnv;
  }
});

// A store told its home explicitly must protect *that* home, even while a
// perfectly healthy ambient root exists somewhere else. Capturing the ambient
// root here would classify the store's own target as "outside the root" and
// recreate it recursively - the resurrection, reached by the opposite door.
test('an explicit animaHome is the protected root, not the ambient one', async () => {
  const parent = await tempHome();
  const ambient = join(parent, '.anima'); // alive for the whole test
  const explicitHome = join(parent, 'explicit-home');
  await mkdir(ambient, { recursive: true });
  await mkdir(join(explicitHome, 'run'), { recursive: true });

  const previousCwd = process.cwd();
  const previousEnv = process.env.ANIMA_HOME;
  delete process.env.ANIMA_HOME;
  process.chdir(parent);
  try {
    const store = new AgentHealthStore({ animaHome: explicitHome });
    await store.update('a1', () => healthSummary);

    await rm(explicitHome, { force: true, recursive: true });

    await assert.rejects(() => store.update('a1', () => healthSummary), /does not exist/);
    assert.equal(await exists(explicitHome), false, 'the store must protect the home it was given');
    assert.ok(await exists(ambient), 'the ambient root is untouched either way');
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousEnv;
  }
});

test('a deep descendant chain is created segment by segment under a live root', async () => {
  const home = await tempHome();
  await withAnimaHome(home, async () => {
    await ensureParentDirectory(join(home, 'a', 'b', 'c', 'd.json'), home);
    assert.ok(await exists(join(home, 'a', 'b', 'c')), 'every intermediate segment is created');
  });
});
