import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function runWrapper(source: string): Promise<{
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
  // child test, so do not leak the parent harness marker into it.
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  const child = spawn(process.execPath, [wrapper], {
    env,
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
