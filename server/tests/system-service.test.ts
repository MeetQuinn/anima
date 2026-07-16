import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  docsUrl,
  parseGrokAcpModelState,
  parseGrokModelsOutput,
  SystemService,
} from '../services/system.service.js';

test('docsUrl uses public docs by default and accepts an explicit override', () => {
  const previous = process.env.ANIMA_DOCS_URL;
  try {
    delete process.env.ANIMA_DOCS_URL;
    assert.equal(docsUrl('dev'), 'http://127.0.0.1:14175/');
    assert.equal(docsUrl('canary'), 'https://anima.meetquinn.ai/');
    assert.equal(docsUrl('stable'), 'https://anima.meetquinn.ai/');

    process.env.ANIMA_DOCS_URL = 'http://127.0.0.1:14175/';
    assert.equal(docsUrl('stable'), 'http://127.0.0.1:14175/');
  } finally {
    if (previous === undefined) delete process.env.ANIMA_DOCS_URL;
    else process.env.ANIMA_DOCS_URL = previous;
  }
});

test('Grok model availability is runtime-checked and timestamped', async () => {
  assert.deepEqual(
    parseGrokModelsOutput(
      [
        'You are logged in with grok.com.',
        'Default model: grok-4.5',
        'Available models:',
        '  * grok-4.5 (default)',
        '  - grok-composer-2.5-fast',
      ].join('\n'),
    ),
    {
      // The text `models` catalog cannot report per-model effort support and must
      // not synthesize it from model names — effort capability comes only from the
      // live ACP modelState (parseGrokAcpModelState).
      defaultModel: 'grok-4.5',
      models: ['grok-4.5', 'grok-composer-2.5-fast'],
    },
  );

  const service = new SystemService({
    commandPresent: async (command) => command === 'grok',
    now: () => new Date('2026-07-13T02:00:00.000Z'),
    providerModels: async (command) => {
      assert.equal(command, 'grok');
      return { defaultModel: 'grok-4.5', models: ['grok-4.5'] };
    },
  });
  const result = await service.providerAvailability();
  assert.deepEqual(
    result.providers.find((provider) => provider.kind === 'grok-cli'),
    {
      checkedAt: '2026-07-13T02:00:00.000Z',
      defaultModel: 'grok-4.5',
      kind: 'grok-cli',
      models: ['grok-4.5'],
      present: true,
    },
  );
  assert.equal(result.providers.find((provider) => provider.kind === 'codex-cli')?.present, false);
});

test('provider availability disables Grok auto-update during its presence probe', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'anima-grok-presence-'));
  const argvPath = join(binDir, 'argv.txt');
  const grokPath = join(binDir, 'grok');
  const previousPath = process.env.PATH;
  const previousArgvPath = process.env.GROK_ARGV_PATH;
  try {
    await writeFile(
      grokPath,
      [
        '#!/bin/sh',
        'if [ "$2" = "--version" ]; then',
        '  printf "%s\\n" "$@" > "$GROK_ARGV_PATH"',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
      'utf8',
    );
    await chmod(grokPath, 0o755);
    process.env.PATH = binDir;
    process.env.GROK_ARGV_PATH = argvPath;

    const result = await new SystemService().providerAvailability();

    assert.equal(result.providers.find((provider) => provider.kind === 'grok-cli')?.present, true);
    assert.equal(await readFile(argvPath, 'utf8'), '--no-auto-update\n--version\n');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousArgvPath === undefined) delete process.env.GROK_ARGV_PATH;
    else process.env.GROK_ARGV_PATH = previousArgvPath;
    await rm(binDir, { force: true, recursive: true });
  }
});

test('Grok model availability reports not checked when the live catalog fails', async () => {
  const service = new SystemService({
    commandPresent: async (command) => command === 'grok',
    now: () => new Date('2026-07-13T02:05:00.000Z'),
    providerModels: async () => {
      throw new Error('Sign in required');
    },
  });
  const result = await service.providerAvailability();
  assert.deepEqual(
    result.providers.find((provider) => provider.kind === 'grok-cli'),
    {
      checkedAt: '2026-07-13T02:05:00.000Z',
      kind: 'grok-cli',
      modelCheckError: 'Sign in required',
      present: true,
    },
  );
});

test('parseGrokAcpModelState extracts per-model effort menus from ACP metadata', () => {
  const catalog = parseGrokAcpModelState({
    currentModelId: 'grok-4.5',
    availableModels: [
      {
        modelId: 'grok-4.5',
        _meta: {
          supportsReasoningEffort: true,
          reasoningEfforts: [
            { id: 'high', value: 'high' },
            { id: 'medium', value: 'medium' },
            { id: 'low', value: 'low' },
          ],
        },
      },
      {
        modelId: 'grok-composer-2.5-fast',
        _meta: { totalContextTokens: 200000 },
      },
    ],
  });
  assert.deepEqual(catalog, {
    defaultModel: 'grok-4.5',
    modelReasoningEfforts: {
      'grok-4.5': ['high', 'medium', 'low'],
      'grok-composer-2.5-fast': [],
    },
    models: ['grok-4.5', 'grok-composer-2.5-fast'],
  });
});
