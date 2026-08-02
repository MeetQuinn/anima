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

test('Grok Grep surfaces pattern + path + glob, not path alone', () => {
  // Live ACP Grep rawInput (sessions): pattern/path/glob — path-only targets hide the query.
  assert.deepEqual(
    summarizeGrokToolInput('Grep', {
      pattern: 'config.?reload|isQuiescent',
      path: '/Users/totoday/anima',
      glob: '**/*.{ts,js}',
      head_limit: 50,
    }),
    { target: 'config.?reload|isQuiescent in /Users/totoday/anima (**/*.{ts,js})' },
  );
  assert.deepEqual(
    summarizeGrokToolInput('Grep', { pattern: 'foo', path: 'server' }),
    { target: 'foo in server' },
  );
  // Meta input fill-in when the outer rawInput is thin.
  assert.deepEqual(
    summarizeGrokToolInput(
      'Grep',
      {},
      {
        title: 'grep',
        _meta: { 'x.ai/tool': { input: { pattern: 'from-meta', path: 'notes' } } },
      },
    ),
    { target: 'from-meta in notes' },
  );
});

test('Grok Glob and ListDir recover params from input / title', () => {
  assert.deepEqual(
    summarizeGrokToolInput('Glob', { glob_pattern: '**/*.ts', path: 'server' }),
    { target: '**/*.ts in server' },
  );
  assert.deepEqual(
    summarizeGrokToolInput('Glob', {}, { title: 'Glob `web/src/**/*.tsx`' }),
    { target: 'web/src/**/*.tsx' },
  );
  assert.deepEqual(
    summarizeGrokToolInput('ListDir', {}, { title: 'List `notes`' }),
    { target: 'notes' },
  );
});

test('Grok WebSearch recovers query from title when rawInput is backend-only', () => {
  // Live empty WebSearch frames often only have { variant, backend: true }.
  assert.deepEqual(
    summarizeGrokToolInput(
      'WebSearch',
      { variant: 'WebSearch', backend: true },
      { title: 'Web search: Claude background task quiescence' },
    ),
    { target: 'Claude background task quiescence' },
  );
  assert.deepEqual(
    summarizeGrokToolInput('WebSearch', { query: 'explicit query' }),
    { target: 'explicit query' },
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

test('Grok TodoWrite summarizes count and status mix into target', () => {
  assert.deepEqual(
    summarizeGrokToolInput('TodoWrite', {
      todos: [
        { content: 'Fix path extract', status: 'completed' },
        { content: 'Wire UI', status: 'in_progress' },
        { content: 'Open PR', status: 'pending' },
      ],
    }),
    { target: '3 items · 1 in progress · 1 pending · 1 done' },
  );
  // Meta input + title count fallback when rawInput is empty.
  assert.deepEqual(
    summarizeGrokToolInput(
      'TodoWrite',
      {},
      {
        title: 'Update todos (2 items)',
        _meta: {
          'x.ai/tool': {
            input: {
              todos: [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }],
            },
          },
        },
      },
    ),
    { target: '2 items · 2 pending' },
  );
  assert.deepEqual(
    summarizeGrokToolInput('TodoWrite', {}, { title: 'Update todos (4 items)' }),
    { target: '4 items' },
  );
});

test('Grok StrReplaceFile recovers path from content diffs / locations when input omits it', () => {
  assert.deepEqual(
    summarizeGrokToolInput(
      'StrReplaceFile',
      { old_string: 'a', new_string: 'b' },
      {
        content: [
          { type: 'diff', path: 'server/providers/grok.ts', oldText: 'a', newText: 'b' },
        ],
      },
    ),
    {
      target: 'server/providers/grok.ts',
      diff: '--- old\na\n+++ new\nb',
    },
  );
  assert.deepEqual(
    summarizeGrokToolInput(
      'StrReplaceFile',
      {},
      { locations: [{ path: 'web/src/lib/activities.ts' }], title: 'Edit `other.ts`' },
    ),
    { target: 'web/src/lib/activities.ts' },
  );
  // Bare title without backticks.
  assert.deepEqual(
    summarizeGrokToolInput('StrReplaceFile', {}, { title: 'Edit path/to/file.ts' }),
    { target: 'path/to/file.ts' },
  );
});
