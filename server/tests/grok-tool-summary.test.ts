import assert from 'node:assert/strict';
import test from 'node:test';

import { grokToolName, summarizeGrokToolInput } from '../providers/grok.js';

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

test('Grok ListDir tool name comes from live ACP meta/title, not ListServerProviders', () => {
  // Live Grok shape (tool_calls.rs): title List `path`, kind Other, meta name list_dir.
  assert.equal(
    grokToolName({
      kind: 'Other',
      title: 'List `server/providers`',
      rawInput: { target_directory: 'server/providers' },
      _meta: { 'x.ai/tool': { name: 'list_dir', kind: 'other' } },
    }),
    'ListDir',
  );
  // Title alone must not camelCase into ListServerProviders.
  assert.equal(grokToolName({ kind: 'Other', title: 'List `server/providers`' }), 'ListDir');
  assert.equal(grokToolName({ title: 'list_dir' }), 'ListDir');
});

test('Grok Shell still prefers command and description', () => {
  assert.deepEqual(
    summarizeGrokToolInput('Shell', { command: 'ls -la', description: 'List files' }),
    { command: 'ls -la', target: 'List files' },
  );
});
