import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const scratch: string[] = [];

test.after(async () => {
  await Promise.all(scratch.map((path) => rm(path, { force: true, recursive: true })));
});

test('the runner rejects unsupported Node before starting a test process', async () => {
  const result = await runWrapper(`
    Object.defineProperty(process, 'version', { value: 'v22.22.0' });
    Object.defineProperty(process.versions, 'node', { value: '22.22.0' });
    await import(${JSON.stringify(runnerUrl())});
  `);

  assert.equal(result.code, 1);
  assert.match(result.output, /require Node\.js 24 or newer/);
  assert.match(result.output, /current runtime is v22\.22\.0/);
  assert.doesNotMatch(result.output, /Running .* tests/);
});

test('runtime timeout profile separates one test from the serial suite budget', async () => {
  const result = await runWrapper(`
    import { testTimeoutsFor } from ${JSON.stringify(runnerUrl())};
    console.log(JSON.stringify(testTimeoutsFor('runtime', Array(12).fill('runtime-fixture.test.js'))));
  `);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    perTestMs: 60_000,
    suiteMs: 240_000,
  });
});

test('the derived suite budget stays above the per-test timeout with no files', async () => {
  const result = await runWrapper(`
    import { testTimeoutsFor } from ${JSON.stringify(runnerUrl())};
    console.log(JSON.stringify(testTimeoutsFor('api', [])));
  `);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    perTestMs: 30_000,
    suiteMs: 60_000,
  });
});

test('composite suite budgets charge each file at its owning tier rate', async () => {
  const result = await runWrapper(`
    import { testTimeoutsFor } from ${JSON.stringify(runnerUrl())};
    const unitFiles = Array(20).fill('state-cache.test.js');
    const apiFiles = Array(4).fill('web-api-server.test.js');
    const runtimeFiles = Array(4).fill('runtime-worker-failures.test.js');
    const all = testTimeoutsFor('all', [...unitFiles, ...apiFiles, ...runtimeFiles]);
    const allPlusApi = testTimeoutsFor('all', [...unitFiles, ...apiFiles, ...runtimeFiles, 'web-api-server.test.js']);
    const allPlusRuntime = testTimeoutsFor('all', [...unitFiles, ...apiFiles, ...runtimeFiles, 'runtime-worker-failures.test.js']);
    const allPlusUnit = testTimeoutsFor('all', [...unitFiles, ...apiFiles, ...runtimeFiles, 'state-cache.test.js']);
    const fast = testTimeoutsFor('fast', [...unitFiles, ...apiFiles]);
    const fastPlusApi = testTimeoutsFor('fast', [...unitFiles, ...apiFiles, 'web-api-server.test.js']);
    const fastPlusUnit = testTimeoutsFor('fast', [...unitFiles, ...apiFiles, 'state-cache.test.js']);
    console.log(JSON.stringify({ all, allPlusApi, allPlusRuntime, allPlusUnit, fast, fastPlusApi, fastPlusUnit }));
  `);

  assert.equal(result.code, 0);
  const budgets = JSON.parse(result.stdout.trim()) as Record<string, { perTestMs: number; suiteMs: number }>;
  assert.equal(budgets.fastPlusUnit!.suiteMs - budgets.fast!.suiteMs, 2_000);
  assert.equal(budgets.fastPlusApi!.suiteMs - budgets.fast!.suiteMs, 5_000);
  assert.equal(budgets.allPlusUnit!.suiteMs - budgets.all!.suiteMs, 2_000);
  assert.equal(budgets.allPlusApi!.suiteMs - budgets.all!.suiteMs, 5_000);
  assert.equal(budgets.allPlusRuntime!.suiteMs - budgets.all!.suiteMs, 15_000);
});

test('the runner rejects a suite watchdog that can preempt the per-test timeout', async () => {
  const result = await runWrapper(`
    import { runTestFiles } from ${JSON.stringify(runnerUrl())};
    await runTestFiles({
      group: 'invalid fixture',
      testPaths: [],
      perTestMs: 100,
      suiteMs: 100,
    });
  `);

  assert.equal(result.code, 1);
  assert.match(result.output, /suiteMs must exceed perTestMs/);
});

test('a hanging test reaches Node timeout and names itself before the suite watchdog', async () => {
  const dir = await fixtureDir();
  const fixture = join(dir, 'named-hang.test.mjs');
  await writeFile(fixture, `
    import test from 'node:test';
    test('named hanging fixture', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
  `, 'utf8');

  const result = await runWrapper(runFilesSource([fixture], 100, 1_000));

  assert.equal(result.code, 1);
  assert.match(result.output, /named hanging fixture/);
  assert.match(result.output, /timed out after 100ms/);
  assert.doesNotMatch(result.output, /exceeded suite budget/);
});

test('slow serial files may exceed one test allowance without hitting the suite watchdog', async () => {
  const dir = await fixtureDir();
  const fixtures = [join(dir, 'slow-a.test.mjs'), join(dir, 'slow-b.test.mjs')];
  for (const [index, fixture] of fixtures.entries()) {
    await writeFile(fixture, `
      import test from 'node:test';
      test('slow fixture ${index + 1}', async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    `, 'utf8');
  }

  const result = await runWrapper(runFilesSource(fixtures, 200, 1_000));

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /slow fixture 1/);
  assert.match(result.output, /slow fixture 2/);
  assert.doesNotMatch(result.output, /exceeded suite budget/);
});

test('each run gets its own provider CLI lock directory and removes it afterwards', async () => {
  // A blank value would send launch-gate back to the machine-wide default, so
  // the runner must replace it just as it fills in a missing one.
  for (const inherited of [undefined, '', '   ']) {
    const dir = await fixtureDir();
    const fixture = join(dir, 'lock-dir.test.mjs');
    const seen = join(dir, 'seen.txt');
    await writeFile(fixture, `
      import { writeFileSync } from 'node:fs';
      import test from 'node:test';
      test('records the lock directory', () => {
        writeFileSync(${JSON.stringify(seen)}, process.env.ANIMA_PROVIDER_CLI_LOCK_DIR ?? '');
      });
    `, 'utf8');

    const result = await runWrapper(
      runFilesSource([fixture], 1_000, 5_000),
      inherited === undefined ? {} : { ANIMA_PROVIDER_CLI_LOCK_DIR: inherited },
    );

    const label = JSON.stringify(inherited);
    assert.equal(result.code, 0, `${label}: ${result.output}`);
    const lockDir = await readFile(seen, 'utf8');
    assert.ok(lockDir.startsWith(join(tmpdir(), 'anima-test-provider-cli-locks-')), `${label}: ${lockDir}`);
    assert.equal(existsSync(lockDir), false, `${label}: the lock directory is removed when the run ends`);
  }
});

test('the runner keeps a lock directory that is already set', async () => {
  const dir = await fixtureDir();
  const fixture = join(dir, 'lock-dir.test.mjs');
  const seen = join(dir, 'seen.txt');
  const lockDir = join(dir, 'locks');
  await writeFile(fixture, `
    import { writeFileSync } from 'node:fs';
    import test from 'node:test';
    test('records the lock directory', () => {
      writeFileSync(${JSON.stringify(seen)}, process.env.ANIMA_PROVIDER_CLI_LOCK_DIR ?? '');
    });
  `, 'utf8');

  const result = await runWrapper(runFilesSource([fixture], 1_000, 5_000), { ANIMA_PROVIDER_CLI_LOCK_DIR: lockDir });

  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(seen, 'utf8'), lockDir);
});

test('the runner runs when started through a symlinked path', async () => {
  const link = join(await fixtureDir(), 'repo');
  await symlink(process.cwd(), link);
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  const child = spawn(process.execPath, [join(link, 'scripts', 'run-tests.mjs'), 'no-such-group'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.equal(code, 2, stderr);
  assert.match(stderr, /Unknown test group "no-such-group"/);
});

function runFilesSource(testPaths: string[], perTestMs: number, suiteMs: number): string {
  return `
    import { runTestFiles } from ${JSON.stringify(runnerUrl())};
    process.exitCode = await runTestFiles({
      group: 'fixture',
      testPaths: ${JSON.stringify(testPaths)},
      perTestMs: ${perTestMs},
      suiteMs: ${suiteMs},
    });
  `;
}

async function runWrapper(source: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{
  code: number | null;
  output: string;
  stderr: string;
  stdout: string;
}> {
  const dir = await fixtureDir();
  const wrapper = join(dir, 'runner.mjs');
  await writeFile(wrapper, source, 'utf8');
  // Node marks descendants of `node --test` and refuses to recursively run a
  // second test harness. The wrapper is an independent runner process, not a
  // child test, so do not leak the parent harness marker into it, nor the
  // lock directory this run was given.
  const {
    NODE_TEST_CONTEXT: _testContext,
    ANIMA_PROVIDER_CLI_LOCK_DIR: _lockDir,
    ...env
  } = process.env;
  const child = spawn(process.execPath, [wrapper], {
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { code, output: `${stdout}\n${stderr}`, stderr, stdout };
}

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anima-test-runner-'));
  scratch.push(dir);
  return dir;
}

function runnerUrl(): string {
  return pathToFileURL(join(process.cwd(), 'scripts', 'run-tests.mjs')).href;
}
