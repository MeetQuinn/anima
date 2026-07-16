import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeGrokToolInput } from '../providers/grok.js';

test('Grok ReadFile uses target_file (live ACP field), not only Claude-style path keys', () => {
  assert.deepEqual(
    summarizeGrokToolInput('ReadFile', { variant: 'ReadFile', target_file: 'PROBE.txt' }),
    { target: 'PROBE.txt' },
  );
  assert.deepEqual(
    summarizeGrokToolInput('ReadFile', { targetFile: 'src/main.ts' }),
    { target: 'src/main.ts' },
  );
  // Prefer explicit input over locations/title.
  assert.deepEqual(
    summarizeGrokToolInput(
      'ReadFile',
      { target_file: 'from-input.ts' },
      { locations: [{ path: 'from-locations.ts' }], title: 'Read `from-title.ts`' },
    ),
    { target: 'from-input.ts' },
  );
});

test('Grok ReadFile falls back to locations, meta input, and titled backticks', () => {
  assert.deepEqual(
    summarizeGrokToolInput('ReadFile', {}, { locations: [{ path: 'loc/path.ts' }] }),
    { target: 'loc/path.ts' },
  );
  assert.deepEqual(
    summarizeGrokToolInput(
      'ReadFile',
      {},
      { _meta: { 'x.ai/tool': { input: { path: 'meta/path.ts' } } } },
    ),
    { target: 'meta/path.ts' },
  );
  assert.deepEqual(
    summarizeGrokToolInput('ReadFile', {}, { title: 'Read `titled/path.ts`' }),
    { target: 'titled/path.ts' },
  );
});

test('Grok ListDir uses target_directory', () => {
  assert.deepEqual(
    summarizeGrokToolInput('ListDir', { target_directory: 'server/providers' }),
    { target: 'server/providers' },
  );
});

test('Grok Shell still prefers command and description', () => {
  assert.deepEqual(
    summarizeGrokToolInput('Shell', { command: 'ls -la', description: 'List files' }),
    { command: 'ls -la', target: 'List files' },
  );
});
