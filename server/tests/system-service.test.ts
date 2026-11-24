import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { withAnimaHome } from './anima-home.js';

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

/**
 * A fake provider binary that, like a version-manager shim, acts only when called by
 * one of `names` (the basename of the path it was started as); otherwise it exits 1.
 * As `grok` it answers ACP initialize with one model whose effort menu is `high`.
 * As `agy`, `acp` serves a catalog session: gemini-4-neon (low/high) and
 * gemini-4-carbon (high).
 */
function fakeShim(names: string[]): string {
  const grokState = {
    availableModels: [
      { _meta: { reasoningEfforts: [{ value: 'high' }], supportsReasoningEffort: true }, modelId: 'grok-4.6' },
    ],
    currentModelId: 'grok-4.6',
  };
  const levels = { 'gemini-4-carbon': ['high'], 'gemini-4-neon': ['low', 'high'] };
  return [
    `#!${process.execPath}`,
    "const path = require('path');",
    'const name = path.basename(process.argv[1]);',
    `if (!${JSON.stringify(names)}.includes(name)) process.exit(1);`,
    "if (process.argv[2] === '--version') { console.log(name + ' 0.0.0'); process.exit(0); }",
    `const levels = ${JSON.stringify(levels)};`,
    "const options = (current) => [",
    "  { category: 'model', currentValue: current, id: 'model', options: Object.keys(levels).reverse().map((value) => ({ value })), type: 'select' },",
    "  { category: 'thought_level', currentValue: 'high', id: 'thought_level', options: levels[current].map((value) => ({ value })), type: 'select' },",
    '];',
    "let current = 'gemini-4-neon';",
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() || '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    "    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');",
    `    if (name === 'grok') { if (msg.method === 'initialize') send({ _meta: { modelState: ${JSON.stringify(grokState)} } }); continue; }`,
    "    if (msg.method === 'initialize') send({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } });",
    "    if (msg.method === 'session/new') send({ sessionId: 'probe', configOptions: options(current) });",
    "    if (msg.method === 'session/close') send({});",
    "    if (msg.method === 'session/set_config_option') { current = msg.params.value; send({ configOptions: options(current) }); }",
    '  }',
    '});',
  ].join('\n');
}

// The probes run the catalog command by name on the runtime PATH, the way agents do,
// so a shim that dispatches on its name works, and so does exec falling through a
// PATH entry whose script cannot start.
test('live catalog probes run the command by name, so shims and PATH fallbacks work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-probe-by-name-'));
  const previousPath = process.env.PATH;
  try {
    const shims = join(dir, 'shims');
    const broken = join(dir, 'broken');
    const shim = join(dir, 'tool-manager');
    await mkdir(shims, { recursive: true });
    await mkdir(broken, { recursive: true });
    await writeFile(shim, fakeShim(['agy', 'grok']), 'utf8');
    await chmod(shim, 0o755);
    await symlink(shim, join(shims, 'agy'));
    await symlink(shim, join(shims, 'grok'));
    // First on PATH, executable, but its interpreter is gone.
    await writeFile(join(broken, 'agy'), '#!/nonexistent/interpreter\n', 'utf8');
    await chmod(join(broken, 'agy'), 0o755);
    process.env.PATH = `${broken}:${shims}`;

    await withAnimaHome(join(dir, 'home'), async () => {
      const grok = await liveReasoningMenus('grok-cli');
      assert.deepEqual(grok && { command: grok.command, menus: grok.modelReasoningEfforts }, {
        command: 'grok',
        menus: { 'grok-4.6': ['high'] },
      });
      const agy = await liveReasoningMenus('antigravity-cli');
      assert.deepEqual(agy?.modelReasoningEfforts, { 'gemini-4-carbon': ['high'], 'gemini-4-neon': ['low', 'high'] });

      const { providers } = await new SystemService({
        commandPresent: async (command) => command === 'agy',
      }).providerAvailability();
      const availability = providers.find((provider) => provider.kind === 'antigravity-cli');
      assert.deepEqual(
        { models: availability?.models, menus: availability?.modelReasoningEfforts },
        {
          menus: { 'gemini-4-carbon': ['high'], 'gemini-4-neon': ['low', 'high'] },
          models: ['gemini-4-neon', 'gemini-4-carbon'],
        },
      );
    });
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
