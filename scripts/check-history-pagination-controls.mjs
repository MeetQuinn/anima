// Run after the server build. Mutations affect only generated files and are
// restored in finally; do not run concurrently with another test/build task.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const base = '4e97d36e6ee15ff60a7028c42505fb5d64adb7c9';
const files = [
  'server/messages/message.service', 'server/activities/activity.service',
  'server/storage/jsonl-log', 'server/storage/history-cursor',
];
const originals = new Map(files.map((name) => [`dist/${name}.js`, readFileSync(`dist/${name}.js`, 'utf8')]));
function restore() { for (const [path, bytes] of originals) writeFileSync(path, bytes); }
function run(label, pattern, expectedStatus) {
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`,
    'dist/server/tests/history-pagination.test.js'], { encoding: 'utf8' });
  process.stdout.write(`\n${label}\n${result.stdout}${result.stderr}`);
  assert.equal(result.status, expectedStatus, `${label} did not exercise the expected boundary`);
}
function mutate(path, before, after) {
  const bytes = originals.get(path);
  assert.ok(bytes.includes(before), 'mutation site changed; update the control');
  writeFileSync(path, bytes.replace(before, after));
}
try {
  run('current implementation', '.', 0);
  for (const name of files.slice(0, 2)) {
    const source = execFileSync('git', ['show', `${base}:${name}.ts`], { encoding: 'utf8' });
    writeFileSync(`dist/${name}.js`, ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
    } }).outputText);
  }
  run('pre-fix services: ordered control passes; tie and late timestamp fail', 'both feeds', 1);
  restore();
  mutate('dist/server/storage/jsonl-log.js',
    'failure instanceof SegmentChanged || JSON.stringify(segments) !== JSON.stringify(after)',
    'failure instanceof SegmentChanged');
  run('remove whole-scan consistency check', 'real append rotation during first|persistent real rotation', 1);
  restore();
  mutate('dist/server/storage/history-cursor.js', 'return { anchor, filters: anchor.f };',
    'return { anchor, filters };');
  run('drop inherited filters', 'ISO to cursor', 1);
  restore();
  run('restored implementation', '.', 0);
} finally {
  restore();
  for (const [path, bytes] of originals) assert.equal(readFileSync(path, 'utf8'), bytes);
}
