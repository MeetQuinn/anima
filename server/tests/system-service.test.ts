import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  docsUrl,
  liveReasoningMenus,
  parseGrokAcpModelState,
  parseGrokModelsOutput,
  parsePiModelCatalog,
  PI_NO_CREDENTIAL_MESSAGE,
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

// The menus are attributed to the file the probe resolved, so the probe must launch
// that file: looking `grok` up again could reach another program after a relink.
test('Grok live effort menus come from the executable they are attributed to', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-grok-menus-'));
  const previousPath = process.env.PATH;
  try {
    const bin = join(dir, 'bin');
    const version = join(dir, 'versions', 'grok-v1');
    const launches = join(dir, 'launches');
    await mkdir(bin, { recursive: true });
    await mkdir(join(dir, 'versions'), { recursive: true });
    const modelState = {
      availableModels: [
        { _meta: { reasoningEfforts: [{ value: 'high' }], supportsReasoningEffort: true }, modelId: 'grok-4.6' },
      ],
      currentModelId: 'grok-4.6',
    };
    await writeFile(
      version,
      [
        `#!${process.execPath}`,
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(launches)}, process.argv[1] + '\\n');`,
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  for (const line of chunk.split('\\n')) {",
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        `    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { _meta: { modelState: ${JSON.stringify(modelState)} } } }) + '\\n');`,
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );
    await chmod(version, 0o755);
    await symlink(version, join(bin, 'grok'));
    process.env.PATH = bin;

    const menus = await liveReasoningMenus('grok-cli');

    assert.deepEqual(menus, { executable: await realpath(version), modelReasoningEfforts: { 'grok-4.6': ['high'] } });
    assert.equal(await readFile(launches, 'utf8'), `${await realpath(version)}\n`);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { force: true, recursive: true });
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

test('parsePiModelCatalog lists provider/id pairs and prefers pi\'s current model as default', () => {
  const available = {
    models: [
      { id: 'deepseek-v4-flash', provider: 'deepseek', reasoning: true },
      { id: 'deepseek-v4-pro', provider: 'deepseek', reasoning: true },
      { id: 'deepseek-v4-pro', provider: 'deepseek' },
      { id: '', provider: 'google' },
      'not-a-model',
    ],
  };
  assert.deepEqual(
    parsePiModelCatalog(available, { model: { id: 'deepseek-v4-pro', provider: 'deepseek' } }),
    {
      defaultModel: 'deepseek/deepseek-v4-pro',
      // Retired deepseek-v4-flash collapses to deepseek-flash.
      models: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'],
    },
  );
  // pi's current model is not reachable (e.g. the `unknown/unknown` placeholder): first entry wins.
  assert.equal(
    parsePiModelCatalog(available, { model: { id: 'unknown', provider: 'unknown' } }).defaultModel,
    'deepseek/deepseek-flash',
  );
  assert.throws(() => parsePiModelCatalog({ models: [] }, undefined), (error: unknown) => {
    assert.equal((error as Error).message, PI_NO_CREDENTIAL_MESSAGE);
    return true;
  });
});

test('parsePiModelCatalog collapses retired DeepSeek Flash aliases and keeps other providers', () => {
  const available = {
    models: [
      { id: 'deepseek-v4-flash', provider: 'deepseek', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-flash-vision-exp', provider: 'deepseek', name: 'DeepSeek V4 Flash Vision Exp' },
      { id: 'deepseek-flash', provider: 'deepseek', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', provider: 'deepseek', name: 'DeepSeek V4 Pro' },
      { id: 'gemini-2.5-pro', provider: 'google', name: 'Gemini 2.5 Pro' },
    ],
  };
  assert.deepEqual(
    parsePiModelCatalog(available, { model: { id: 'deepseek-v4-flash', provider: 'deepseek' } }),
    {
      defaultModel: 'deepseek/deepseek-flash',
      models: [
        'deepseek/deepseek-flash',
        'deepseek/deepseek-v4-pro',
        'google/gemini-2.5-pro',
      ],
    },
  );
});

test('provider availability asks the live catalog per provider kind', async () => {
  const seen: Array<[string, string]> = [];
  const service = new SystemService({
    commandPresent: async (command) => command === 'pi' || command === 'grok',
    now: () => new Date('2026-08-25T03:00:00.000Z'),
    providerModels: async (command, kind) => {
      seen.push([command, kind]);
      if (kind === 'pi') return { defaultModel: 'deepseek/deepseek-v4-pro', models: ['deepseek/deepseek-v4-pro'] };
      return { defaultModel: 'grok-4.5', models: ['grok-4.5'] };
    },
  });
  const result = await service.providerAvailability();
  assert.deepEqual(result.providers.find((provider) => provider.kind === 'pi'), {
    checkedAt: '2026-08-25T03:00:00.000Z',
    defaultModel: 'deepseek/deepseek-v4-pro',
    kind: 'pi',
    models: ['deepseek/deepseek-v4-pro'],
    present: true,
  });
  assert.deepEqual(seen.sort(), [
    ['grok', 'grok-cli'],
    ['pi', 'pi'],
  ]);
});
