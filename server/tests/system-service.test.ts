import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  catalogCommandOutput,
  codexAppServerModelCatalog,
  docsUrl,
  parseCodexModelList,
  parseGrokAcpModelState,
  parseGrokModelsOutput,
  parseKimiProviderList,
  parseOpenCodeModelsOutput,
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
 * gemini-4-carbon (`carbon`, default high).
 */
/** Shell step a fake runs first to write `bytes` to stderr; an unread stderr pipe fills at about 64KB. */
function floodStderr(bytes: number): string {
  return bytes > 0
    ? `require('child_process').execFileSync('/bin/sh', ['-c', 'exec /usr/bin/head -c ${bytes} /dev/zero >&2'], { stdio: ['ignore', 'ignore', 'inherit'] });`
    : '';
}

function fakeShim(names: string[], carbon = ['high'], stderrBytes = 0): string {
  const grokState = {
    availableModels: [
      { _meta: { reasoningEfforts: [{ value: 'high' }], supportsReasoningEffort: true }, modelId: 'grok-4.6' },
    ],
    currentModelId: 'grok-4.6',
  };
  const levels = { 'gemini-4-carbon': carbon, 'gemini-4-neon': ['low', 'high'] };
  return [
    `#!${process.execPath}`,
    "const path = require('path');",
    'const name = path.basename(process.argv[1]);',
    `if (!${JSON.stringify(names)}.includes(name)) process.exit(1);`,
    "if (process.argv[2] === '--version') { console.log(name + ' 0.0.0'); process.exit(0); }",
    floodStderr(stderrBytes),
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
// PATH entry whose script cannot start. The agy catalog is cached until a file the
// command could start changes.
test('live catalog probes run the command by name, and agy probes again after a relink', async () => {
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
      const available = async (kind: string) => {
        const { providers } = await new SystemService({
          commandPresent: async (command) => command === 'agy' || command === 'grok',
        }).providerAvailability();
        const entry = providers.find((provider) => provider.kind === kind);
        return { menus: entry?.modelReasoningEfforts, models: entry?.models };
      };
      assert.deepEqual(await available('grok-cli'), { menus: { 'grok-4.6': ['high'] }, models: ['grok-4.6'] });
      assert.deepEqual(await available('antigravity-cli'), {
        menus: { 'gemini-4-carbon': ['high'], 'gemini-4-neon': ['low', 'high'] },
        models: ['gemini-4-neon', 'gemini-4-carbon'],
      });

      const upgraded = join(dir, 'tool-manager-2');
      await writeFile(upgraded, fakeShim(['agy'], ['high', 'xhigh']), 'utf8');
      await chmod(upgraded, 0o755);
      await rm(join(shims, 'agy'));
      await symlink(upgraded, join(shims, 'agy'));
      assert.deepEqual((await available('antigravity-cli')).menus?.['gemini-4-carbon'], ['high', 'xhigh']);
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
    commandPresent: async (command) => command === 'pi' || command === 'grok' || command === 'codex',
    now: () => new Date('2026-08-25T03:00:00.000Z'),
    providerModels: async (command, kind) => {
      seen.push([command, kind]);
      if (kind === 'codex-cli') throw new Error('model/list unsupported');
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
  // Codex is still available when its live list fails; the web falls back to the built-in one.
  assert.deepEqual(result.providers.find((provider) => provider.kind === 'codex-cli'), {
    checkedAt: '2026-08-25T03:00:00.000Z',
    kind: 'codex-cli',
    modelCheckError: 'model/list unsupported',
    present: true,
  });
  assert.deepEqual(seen.sort(), [
    ['codex', 'codex-cli'],
    ['grok', 'grok-cli'],
    ['pi', 'pi'],
  ]);
});

test('parseCodexModelList reads model/list pages into models, menus and the default', () => {
  const effort = (reasoningEffort: string) => ({ description: '', reasoningEffort });
  assert.deepEqual(
    parseCodexModelList([
      {
        data: [
          { id: 'gpt-6.2-astra', model: 'gpt-6.2-astra', supportedReasoningEfforts: ['low', 'high'].map(effort) },
          { hidden: true, id: 'gpt-internal', model: 'gpt-internal', supportedReasoningEfforts: [effort('low')] },
          { id: 'gpt-6-luna', isDefault: true, model: 'gpt-6-luna', supportedReasoningEfforts: [] },
        ],
        nextCursor: 'page-2',
      },
      // A model without the field keeps the built-in menu; repeats are dropped.
      { data: [{ id: 'gpt-7-astra', model: 'gpt-7-astra' }, { id: 'gpt-6-luna', model: 'gpt-6-luna' }], nextCursor: null },
    ]),
    {
      defaultModel: 'gpt-6-luna',
      modelReasoningEfforts: { 'gpt-6.2-astra': ['low', 'high'], 'gpt-6-luna': [] },
      models: ['gpt-6.2-astra', 'gpt-6-luna', 'gpt-7-astra'],
    },
  );
  assert.equal(parseCodexModelList([{ data: [{ id: 'gpt-6-sol', model: 'gpt-6-sol' }] }]).defaultModel, 'gpt-6-sol');
  assert.throws(() => parseCodexModelList([{ data: [{ hidden: true, id: 'x', model: 'x' }] }]), /did not report any models/);
});

/** A fake `codex app-server` that logs each message it gets and serves two model/list pages. */
function fakeCodexAppServer(log: string, options: { exitBeforeList?: boolean; stderrBytes?: number } = {}): string {
  return [
    `#!${process.execPath}`,
    floodStderr(options.stderrBytes ?? 0),
    "const fs = require('fs');",
    `const log = ${JSON.stringify(log)};`,
    `const exitBeforeList = ${JSON.stringify(Boolean(options.exitBeforeList))};`,
    "fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');",
    "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "const page = (data, nextCursor) => ({ data, nextCursor });",
    "let buffer = '';",
    'let listId;',
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() || '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    "    fs.appendFileSync(log, line + '\\n');",
    "    if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake/0.0.0' } });",
    "    if (msg.method === 'model/list' && exitBeforeList) process.exit(3);",
    "    if (msg.method === 'model/list' && !msg.params.cursor) {",
    '      // Ask the client something first; the probe must refuse it.',
    '      listId = msg.id;',
    "      send({ id: 'server-1', method: 'item/tool/requestUserInput', params: {} });",
    '    }',
    "    if (msg.id === 'server-1') send({ id: listId, result: page([{ id: 'gpt-6.2-sol', isDefault: true, model: 'gpt-6.2-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], 'next') });",
    "    if (msg.method === 'model/list' && msg.params.cursor === 'next') send({ id: msg.id, result: page([{ id: 'gpt-6.1-terra', model: 'gpt-6.1-terra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], null) });",
    '  }',
    '});',
  ].join('\n');
}

test('Codex model catalog probe lists every model/list page and starts no thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-codex-models-'));
  try {
    const codex = join(dir, 'codex');
    const log = join(dir, 'log');
    await writeFile(codex, fakeCodexAppServer(log), 'utf8');
    await chmod(codex, 0o755);
    const home = join(dir, 'home');

    const catalog = await withAnimaHome(home, () => codexAppServerModelCatalog(codex));

    assert.deepEqual(catalog, {
      defaultModel: 'gpt-6.2-sol',
      modelReasoningEfforts: { 'gpt-6.1-terra': ['high'], 'gpt-6.2-sol': ['low'] },
      models: ['gpt-6.2-sol', 'gpt-6.1-terra'],
    });
    const [launch, ...messages] = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(launch.argv, ['app-server', '--listen', 'stdio://']);
    assert.equal(launch.cwd, await realpath(join(home, 'cache', 'codex-model-probe')));
    assert.deepEqual(await readdir(join(home, 'cache', 'codex-model-probe')), []);
    assert.deepEqual(
      messages.map((message) => [message.method ?? 'reply', message.params?.cursor ?? message.error?.code ?? null]),
      [['initialize', null], ['initialized', null], ['model/list', null], ['reply', -32601], ['model/list', 'next']],
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

/** A fake `codex app-server` serving `pages` one-model pages (endless: always one more); the default is on the last. */
function fakeCodexPager(log: string, pages: number | 'endless'): string {
  return [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    `const pages = ${JSON.stringify(pages)};`,
    "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() || '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    "    if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake/0.0.0' } });",
    "    if (msg.method !== 'model/list') continue;",
    "    fs.appendFileSync(" + JSON.stringify(log) + ", (msg.params.cursor || '-') + '\\n');",
    "    const index = msg.params.cursor ? Number(msg.params.cursor.slice(1)) : 0;",
    "    const last = pages !== 'endless' && index === pages - 1;",
    "    const model = { id: 'm' + index, isDefault: last, model: 'm' + index, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };",
    "    send({ id: msg.id, result: { data: [model], nextCursor: last ? null : 'p' + (index + 1) } });",
    '  }',
    '});',
  ].join('\n');
}

test('Codex model catalog probe reads every page, and a list still paging at the cap is a failed read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-codex-pages-'));
  try {
    const codex = join(dir, 'codex');
    const log = join(dir, 'log');
    await writeFile(codex, fakeCodexPager(log, 21), 'utf8');
    await chmod(codex, 0o755);
    const catalog = await withAnimaHome(join(dir, 'home'), () => codexAppServerModelCatalog(codex));
    assert.equal(catalog.models.length, 21);
    assert.equal(catalog.defaultModel, 'm20');

    await writeFile(log, '', 'utf8');
    await writeFile(codex, fakeCodexPager(log, 'endless'), 'utf8');
    await assert.rejects(
      withAnimaHome(join(dir, 'home'), () => codexAppServerModelCatalog(codex)),
      /Codex model\/list still had more pages after 100/,
    );
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 100);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// Nothing reads a probe's stderr, so a chatty CLI must not stall on a full pipe.
test('live catalog probes return their catalog while the CLI floods stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-probe-stderr-'));
  const previousPath = process.env.PATH;
  try {
    const codex = join(dir, 'codex');
    await writeFile(codex, fakeCodexAppServer(join(dir, 'log'), { stderrBytes: 1_000_000 }), 'utf8');
    await chmod(codex, 0o755);
    const codexCatalog = await withAnimaHome(join(dir, 'home'), () => codexAppServerModelCatalog(codex, { timeoutMs: 5_000 }));
    assert.deepEqual(codexCatalog.models, ['gpt-6.2-sol', 'gpt-6.1-terra']);

    const shims = join(dir, 'shims');
    const shim = join(dir, 'tool-manager');
    await mkdir(shims, { recursive: true });
    await writeFile(shim, fakeShim(['agy', 'grok'], ['high'], 1_000_000), 'utf8');
    await chmod(shim, 0o755);
    await symlink(shim, join(shims, 'agy'));
    await symlink(shim, join(shims, 'grok'));
    process.env.PATH = `${shims}:/usr/bin:/bin`;
    await withAnimaHome(join(dir, 'home'), async () => {
      const { providers } = await new SystemService({
        commandPresent: async (command) => command === 'agy' || command === 'grok',
      }).providerAvailability();
      const menus = (kind: string) => providers.find((provider) => provider.kind === kind)?.modelReasoningEfforts;
      assert.deepEqual(menus('grok-cli'), { 'grok-4.6': ['high'] });
      assert.deepEqual(menus('antigravity-cli'), { 'gemini-4-carbon': ['high'], 'gemini-4-neon': ['low', 'high'] });
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { force: true, recursive: true });
  }
});

test('Codex model catalog probe fails when app-server exits before answering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-codex-models-'));
  try {
    const codex = join(dir, 'codex');
    await writeFile(codex, fakeCodexAppServer(join(dir, 'log'), { exitBeforeList: true }), 'utf8');
    await chmod(codex, 0o755);
    await assert.rejects(
      withAnimaHome(join(dir, 'home'), () => codexAppServerModelCatalog(codex)),
      /Codex model catalog probe exited \(3\)|Codex model\/list failed: app-server exited/,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// `opencode models --verbose`: each `provider/id` line is followed by that model's JSON.
function openCodeVerbose(models: Array<[string, Record<string, unknown> | string]>): string {
  return models
    .map(([id, info]) => `${id}\n${typeof info === 'string' ? info : JSON.stringify(info, null, 2)}`)
    .join('\n') + '\n';
}

test('parseOpenCodeModelsOutput reads ids and variant names, and nothing else', () => {
  const output = openCodeVerbose([
    ['deepseek/deepseek-v4-pro', {
      headers: { Authorization: 'Bearer sk-not-read' },
      options: { apiKey: 'sk-not-read' },
      status: 'active',
      variants: { high: { reasoningEffort: 'high' }, low: { reasoningEffort: 'low' }, max: { reasoningEffort: 'max' } },
    }],
    ['opencode/big-pickle', { status: 'beta' }],
    ['deepseek/deepseek-chat', { status: 'deprecated', variants: { high: {} } }],
    ['deepseek/deepseek-flash', '{ not json'],
    ['deepseek/deepseek-v4-pro', { variants: { minimal: {} } }],
  ]);
  const catalog = parseOpenCodeModelsOutput(output);
  assert.deepEqual(catalog, {
    defaultModel: 'deepseek/deepseek-v4-pro',
    // A model whose JSON does not parse keeps its built-in menu (no entry).
    modelReasoningEfforts: { 'deepseek/deepseek-v4-pro': ['high', 'low', 'max'], 'opencode/big-pickle': [] },
    models: ['deepseek/deepseek-v4-pro', 'opencode/big-pickle', 'deepseek/deepseek-flash'],
  });
  assert.equal(JSON.stringify(catalog).includes('sk-not-read'), false);
  assert.throws(() => parseOpenCodeModelsOutput(''), /OpenCode did not report any models/);
});

test('parseKimiProviderList reads model aliases and their efforts, never providers', () => {
  const output = JSON.stringify({
    models: {
      'kimi-code/k3': { defaultEffort: 'high', model: 'k3', provider: 'managed:kimi-code', supportEfforts: ['low', 'high', 'max', 'high'] },
      'kimi-code/kimi-for-coding': { capabilities: ['thinking'], model: 'kimi-for-coding', provider: 'managed:kimi-code' },
    },
    providers: { 'managed:kimi-code': { apiKey: 'sk-kimi-not-read', baseUrl: 'https://example.invalid' } },
  });
  const catalog = parseKimiProviderList(output);
  assert.deepEqual(catalog, {
    defaultModel: 'kimi-code/k3',
    modelReasoningEfforts: { 'kimi-code/k3': ['low', 'high', 'max'], 'kimi-code/kimi-for-coding': [] },
    models: ['kimi-code/k3', 'kimi-code/kimi-for-coding'],
  });
  assert.equal(JSON.stringify(catalog).includes('sk-kimi-not-read'), false);
  // The error never carries the output, which can hold credentials.
  assert.throws(() => parseKimiProviderList('apiKey = "sk-kimi-not-read"'), (error: Error) =>
    error.message === 'Kimi Code provider list was not JSON');
  assert.throws(() => parseKimiProviderList(JSON.stringify({ models: {}, providers: {} })), /Kimi Code did not report any models/);
});

test('catalog commands: stdout is read while stderr floods, and failures carry no output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-catalog-command-'));
  try {
    const script = async (name: string, body: string) => {
      const file = join(dir, name);
      await writeFile(file, [`#!${process.execPath}`, body].join('\n'), 'utf8');
      await chmod(file, 0o755);
      return file;
    };
    const run = (command: string, options: { maxBytes?: number; timeoutMs?: number } = {}) =>
      catalogCommandOutput('Test list', command, ['list'], { cwd: join(dir, 'probe'), env: process.env, killGraceMs: 200, ...options });

    const chatty = await script('chatty', `${floodStderr(1_000_000)}\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));`);
    assert.deepEqual(JSON.parse(await run(chatty, { timeoutMs: 5_000 })), { argv: ['list'], cwd: await realpath(join(dir, 'probe')) });

    const failing = await script('failing', "process.stdout.write('apiKey=sk-secret'); process.exit(3);");
    await assert.rejects(run(failing), (error: Error) => error.message === 'Test list exited (3)');

    const pidFile = join(dir, 'hang.pid');
    const hanging = await script('hanging', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('apiKey=sk-secret'); setInterval(() => {}, 1000);`);
    // Long enough for a loaded machine to start node and write the pid file first.
    await assert.rejects(run(hanging, { timeoutMs: 3_000 }), (error: Error) => error.message === 'Test list timed out');
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(pid > 0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);

    const flooding = await script('flooding', "process.stdout.write('x'.repeat(4096));");
    await assert.rejects(run(flooding, { maxBytes: 1024 }), (error: Error) => error.message === 'Test list wrote more output than expected');

    await assert.rejects(run(join(dir, 'missing')), (error: Error) => error.message === 'Test list could not start (ENOENT)');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// The OpenCode and Kimi probes run the CLI's own list command by name on the runtime
// PATH, from a fixed empty directory, with the runtime's flags and environment.
test('provider availability reads the OpenCode and Kimi model lists from their CLIs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-opencode-kimi-models-'));
  const previousPath = process.env.PATH;
  try {
    const bin = join(dir, 'bin');
    const log = join(dir, 'calls.jsonl');
    await mkdir(bin, { recursive: true });
    const record = `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null, cwd: process.cwd(), name: require('path').basename(process.argv[1]) }) + '\\n');`;
    const opencodeOutput = openCodeVerbose([
      ['deepseek/deepseek-v4-pro', { variants: { high: {}, low: {}, max: {} } }],
      ['deepseek/deepseek-v5', { variants: { high: {} } }],
    ]);
    await writeFile(join(bin, 'opencode'), [
      `#!${process.execPath}`,
      "if (process.argv[2] === '--version') { console.log('1.19.5'); process.exit(0); }",
      record,
      floodStderr(200_000),
      `process.stdout.write(${JSON.stringify(opencodeOutput)});`,
    ].join('\n'), 'utf8');
    await writeFile(join(bin, 'kimi'), [
      `#!${process.execPath}`,
      "if (process.argv[2] === '--version') { console.log('2.3.3'); process.exit(0); }",
      record,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        models: { 'kimi-code/k3': { supportEfforts: ['low', 'high', 'max'] }, 'kimi-code/k4': {} },
        providers: { 'managed:kimi-code': { apiKey: 'sk-kimi-not-read' } },
      }))});`,
    ].join('\n'), 'utf8');
    await chmod(join(bin, 'opencode'), 0o755);
    await chmod(join(bin, 'kimi'), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const home = join(dir, 'home');

    const { providers } = await withAnimaHome(home, () => new SystemService({
      commandPresent: async (command) => command === 'opencode' || command === 'kimi',
      now: () => new Date('2026-11-25T00:00:00.000Z'),
    }).providerAvailability());
    assert.deepEqual(providers.find((provider) => provider.kind === 'opencode-cli'), {
      checkedAt: '2026-11-25T00:00:00.000Z',
      defaultModel: 'deepseek/deepseek-v4-pro',
      kind: 'opencode-cli',
      modelReasoningEfforts: { 'deepseek/deepseek-v4-pro': ['high', 'low', 'max'], 'deepseek/deepseek-v5': ['high'] },
      models: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v5'],
      present: true,
    });
    assert.deepEqual(providers.find((provider) => provider.kind === 'kimi-cli'), {
      checkedAt: '2026-11-25T00:00:00.000Z',
      defaultModel: 'kimi-code/k3',
      kind: 'kimi-cli',
      modelReasoningEfforts: { 'kimi-code/k3': ['low', 'high', 'max'], 'kimi-code/k4': [] },
      models: ['kimi-code/k3', 'kimi-code/k4'],
      present: true,
    });

    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(calls.sort((a, b) => String(a['name']).localeCompare(String(b['name']))), [
      { argv: ['provider', 'list', '--json'], autoupdate: null, cwd: await realpath(join(home, 'cache', 'kimi-model-probe')), name: 'kimi' },
      { argv: ['models', '--verbose', '--pure'], autoupdate: '1', cwd: await realpath(join(home, 'cache', 'opencode-model-probe')), name: 'opencode' },
    ]);
    assert.deepEqual(await readdir(join(home, 'cache', 'opencode-model-probe')), []);
    assert.deepEqual(await readdir(join(home, 'cache', 'kimi-model-probe')), []);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { force: true, recursive: true });
  }
});
