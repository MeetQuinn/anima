import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `docs/activity-events.md` claims to list every module that writes to the activity
 * log. This test IS that claim's falsifier.
 *
 * The doc table is the claim. It is not cached here: the test parses the table out
 * of the markdown and compares it to a set re-derived from the sources. There is no
 * third list to drift. Update the doc, or the test reds.
 *
 * Enumerate by MODULE SPECIFIER, never by imported name. `server/reminders/` writes
 * through a `ReminderActivityRecorder` and never mentions `activityServiceForAgent`;
 * a grep for the symbol misses it entirely.
 */

/**
 * These tests run from `dist/` against the TypeScript SOURCES. A path relative to
 * import.meta.url resolves into dist, where there are no .ts files, and the scan
 * would find zero emitters and pass. Walk up until we find the sink itself.
 */
function findRepoRoot(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'server', 'activities', 'activity.service.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot locate server/ sources from ' + import.meta.url);
}

const REPO_ROOT = findRepoRoot();
const SERVER_ROOT = join(REPO_ROOT, 'server');
const SERVICE_SOURCE = join(SERVER_ROOT, 'activities', 'activity.service.ts');
const DOC = join(REPO_ROOT, 'docs', 'activity-events.md');

/** The service is the sink, not a source. */
const SINK = 'activities/activity.service.ts';

const WRITE_METHODS = ['record'] as const;
const READ_METHODS = [
  'readAll',
  'readLastN',
  'readNewestMatching',
  'readNewestUntil',
  'listActivityFeed',
] as const;

/** Both quote styles. Prettier normalizes to single, but a check that relies on a formatter is not a check. */
const SERVICE_SPECIFIER = /from\s+(['"])[^'"]*activities\/activity\.service\.js\1/;

/**
 * A method call only counts when its RECEIVER is the activity service. Three shapes
 * reach the log, and a bare `.record(` matches none of them reliably - it also
 * matches `SubscriptionStore.list()` and a parameter named `record`.
 *
 *   1. direct     activityServiceForAgent(id).record(...)
 *   2. DI service private readonly activity: ActivityService = activityServiceForAgent(id)
 *   3. DI recorder private readonly activity: ActivityRecorder = defaultActivityRecorder
 */
const viaFactory = (methods: readonly string[]) =>
  new RegExp(`activityServiceForAgent\\([^)]*\\)\\s*\\.\\s*(?:${methods.join('|')})\\s*\\(`);

/** Names bound to the activity service by a type annotation, e.g. `activity` in `activity: ActivityService`. */
function serviceAliases(src: string): string[] {
  const names = new Set<string>();
  const decl = /(\w+)\s*:\s*(?:ActivityService|ActivityRecorder)\b/g;
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    const name = m[1];
    if (name) names.add(name);
  }
  return [...names];
}

function callsOnService(src: string, methods: readonly string[]): boolean {
  if (viaFactory(methods).test(src)) return true;
  return serviceAliases(src).some((alias) =>
    new RegExp(`\\b(?:this\\.)?${alias}\\s*\\.\\s*(?:${methods.join('|')})\\s*\\(`).test(src),
  );
}

const writes = (src: string) => callsOnService(src, WRITE_METHODS);
const reads = (src: string) => callsOnService(src, READ_METHODS);

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'tests' || e.name === 'node_modules' || e.name === 'dist') continue;
      out.push(...(await tsFiles(full)));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every non-test module that imports the activity service, classified. */
async function survey() {
  const importers: string[] = [];
  const emitters: string[] = [];
  const readers: string[] = [];
  for (const file of await tsFiles(SERVER_ROOT)) {
    const rel = relative(SERVER_ROOT, file);
    if (rel === SINK) continue;
    const src = await readFile(file, 'utf8');
    if (!SERVICE_SPECIFIER.test(src)) continue;
    importers.push(rel);
    if (writes(src)) emitters.push(rel);
    if (reads(src)) readers.push(rel);
  }
  return { importers: importers.sort(), emitters: emitters.sort(), readers: readers.sort() };
}

/** Pull `server/...` paths out of a named markdown table in the doc. */
function tableRows(doc: string, heading: string): string[] {
  const section = doc.split(`#### ${heading}`)[1];
  assert.ok(section, `docs/activity-events.md has no "#### ${heading}" table`);
  const rows: string[] = [];
  for (const line of section.split('\n')) {
    if (line.startsWith('##')) break;
    const m = /^\|\s*`server\/([^`]+)`/.exec(line);
    const path = m?.[1];
    if (path) rows.push(path);
  }
  return rows.sort();
}

test('the method names this test keys on still exist on ActivityService', async () => {
  const svc = await readFile(SERVICE_SOURCE, 'utf8');
  for (const m of [...WRITE_METHODS, ...READ_METHODS]) {
    assert.match(
      svc,
      new RegExp(`^\\s{2}(?:async\\s+)?${m}\\s*\\(`, 'm'),
      `ActivityService no longer has a ${m}() method; the classifier is keyed on a ghost`,
    );
  }
});

test('every emitter in docs/activity-events.md is real, and every real emitter is in the doc', async () => {
  const { emitters } = await survey();
  const doc = await readFile(DOC, 'utf8');
  const claimed = tableRows(doc, 'Emitters');

  // Positive control: a broken scan finds nothing and would otherwise pass silently.
  assert.ok(emitters.length >= 10, `scan found only ${emitters.length} emitters; the specifier regex has stopped matching`);
  assert.ok(claimed.length >= 10, `parsed only ${claimed.length} rows from the doc table; the parser has stopped matching`);

  assert.deepEqual(
    emitters,
    claimed,
    'The emitter set and docs/activity-events.md disagree. Update the doc table in the ' +
      'same commit. An emitter missing from the doc is a source of activity rows that ' +
      'no reader of the doc knows exists.',
  );
});

test('the reader split in the doc matches the sources, bound to the activity service', async () => {
  const { readers } = await survey();
  const doc = await readFile(DOC, 'utf8');
  assert.deepEqual(readers, tableRows(doc, 'Readers'));
});

test('every importer of the activity service is classified as a writer or a reader', async () => {
  const { importers, emitters, readers } = await survey();
  const classified = new Set([...emitters, ...readers]);
  const escaped = importers.filter((f) => !classified.has(f));
  assert.deepEqual(
    escaped,
    [],
    'These modules import the activity service but neither write nor read by any known ' +
      'method. Either they reach it a new way the classifier cannot see, or a method was ' +
      'renamed. Do not add them to the doc until you know which.',
  );
});
