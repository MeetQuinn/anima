import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Sources line in `docs/activity-events.md` is a completeness claim: it tells a
 * reader where activity rows come from. A claim nothing can falsify goes stale in
 * silence, so this test is the thing that falsifies it.
 *
 * Enumerate by MODULE SPECIFIER, never by imported name. `server/reminders/` records
 * activity through a `ReminderActivityRecorder` and never mentions
 * `activityServiceForAgent`; a grep for the symbol misses it entirely.
 *
 * When this test fails you have added an emitter. Add it to BOTH lists below and to
 * the Sources line in `docs/activity-events.md`, or the doc starts lying.
 */

/**
 * These tests run from `dist/` against the TypeScript SOURCES. A path relative to
 * import.meta.url resolves into dist, where there are no .ts files, and the scan
 * would find zero emitters and pass. Walk up until we find the sink itself.
 */
function findServerRoot(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'server');
    if (existsSync(join(candidate, 'activities', 'activity.service.ts'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot locate server/ sources from ' + import.meta.url);
}

const SERVER_ROOT = findServerRoot();

/** Every module that writes to the activity log. Keep sorted. */
const EMITTERS = [
  'agents/agent.service.ts',
  'asks/interactive-ask.service.ts',
  'inbox/attention-suggestion-activity.ts',
  'inbox/slack-subscriber.ts',
  'inbox/subscription.service.ts',
  'memory/memory-coherence-outcome.ts',
  'reminders/reminder.activity.ts',
  'runtime/activity.ts',
  'slack-interactions/shortcut.service.ts',
  'tools/tool-context.ts',
] as const;

/** Modules that import the service only to read it. Listed so the split stays honest. */
const READERS = [
  'diagnostics/agent-diagnostics.service.ts',
  'inbox/subscription.service.ts',
  'memory/memory-coherence-scheduler.ts',
  'runtime/item-activities.ts',
  'web/agent-routes.ts',
] as const;

const SERVICE_SPECIFIER = /from\s+'[^']*activities\/activity\.service\.js'/;
const WRITES = /\.record\(|ActivityRecorder/;
const READS = /\.readAll\(|\.readLastN\(|\.list\(/;

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

async function classify() {
  const files = await tsFiles(SERVER_ROOT);
  const emitters: string[] = [];
  const readers: string[] = [];
  for (const file of files) {
    const rel = relative(SERVER_ROOT, file);
    // The service defines the recorder; it is the sink, not a source.
    if (rel === 'activities/activity.service.ts') continue;
    const src = await readFile(file, 'utf8');
    if (!SERVICE_SPECIFIER.test(src)) continue;
    if (WRITES.test(src)) emitters.push(rel);
    if (READS.test(src)) readers.push(rel);
  }
  return { emitters: emitters.sort(), readers: readers.sort() };
}

test('the activity emitter set is exactly what docs/activity-events.md claims', async () => {
  const { emitters } = await classify();

  // Positive control: the enumeration must actually find things. A check that
  // reports nothing and a check that ran nothing look identical.
  assert.ok(
    emitters.length >= 10,
    `enumeration found ${emitters.length} emitters; the specifier regex has probably stopped matching`,
  );

  assert.deepEqual(
    emitters,
    [...EMITTERS],
    'Activity emitter set changed. Update EMITTERS here AND the Sources line in ' +
      'docs/activity-events.md. A new emitter that is not in the doc is a source ' +
      'of activity rows no reader of the doc knows exists.',
  );
});

test('reader modules are not silently emitting', async () => {
  const { readers } = await classify();
  assert.deepEqual(readers, [...READERS]);
});

test('every listed emitter still imports the activity service by specifier', async () => {
  for (const rel of EMITTERS) {
    const src = await readFile(join(SERVER_ROOT, rel), 'utf8');
    assert.match(
      src,
      SERVICE_SPECIFIER,
      `${rel} is listed as an emitter but no longer imports activity.service.js`,
    );
    assert.match(src, WRITES, `${rel} is listed as an emitter but no longer writes`);
  }
});
