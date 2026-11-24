import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  modelListCatalog,
  modelListReply,
  parseKimiProviderList,
  parseOpenCodeModelsOutput,
} from '../services/model-list-parsers.js';
import {
  codexAppServerModelCatalog,
  docsUrl,
  modelListProbe,
  parseCodexModelList,
  parseGrokAcpModelState,
  parseGrokModelsOutput,
  parsePiModelCatalog,
  PI_NO_CREDENTIAL_MESSAGE,
  SystemService,
} from '../services/system.service.js';

const SYSTEM_SERVICE_MODULE = fileURLToPath(new URL('../services/system.service.js', import.meta.url));
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

// `opencode models --verbose`: each `provider/id` line is followed by that model's
// record, which names it again (`providerID`, `id`). A string is the record's text as is.
function openCodeVerbose(models: Array<[string, Record<string, unknown> | string]>): string {
  return models
    .map(([model, info]) => {
      if (typeof info === 'string') return `${model}\n${info}`;
      const slash = model.indexOf('/');
      return `${model}\n${JSON.stringify({ id: model.slice(slash + 1), providerID: model.slice(0, slash), ...info }, null, 2)}`;
    })
    .join('\n') + '\n';
}

// `codex` is often a wrapper that starts the native binary; ending the probe ends both.
// The fake refuses `initialize` once it is up, so the probe ends after it started.
test('Codex model catalog probe ends a wrapper and the app-server it started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-codex-tree-'));
  try {
    const server = join(dir, 'codex-native');
    await writeFile(server, [
      `#!${process.execPath}`,
      `require('fs').writeFileSync(${JSON.stringify(join(dir, 'native.pid'))}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "process.stdin.on('data', () => process.stdout.write(JSON.stringify({ error: { message: 'refused' }, id: 1 }) + '\\n'));",
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    const codex = join(dir, 'codex');
    await writeFile(codex, `#!/bin/sh\necho $$ > ${JSON.stringify(join(dir, 'wrapper.pid'))}\n${JSON.stringify(server)} "$@"\n`, 'utf8');
    await chmod(server, 0o755);
    await chmod(codex, 0o755);
    await assert.rejects(
      withAnimaHome(join(dir, 'home'), () => codexAppServerModelCatalog(codex, { killGraceMs: 200, timeoutMs: 30_000 })),
      /Codex request failed: refused/,
    );
    assert.equal(await processGone(await pidFrom(join(dir, 'wrapper.pid'))), true, 'wrapper');
    assert.equal(await processGone(await pidFrom(join(dir, 'native.pid'))), true, 'app-server');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

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
    modelReasoningEfforts: { 'deepseek/deepseek-v4-pro': ['high', 'low', 'max'], 'opencode/big-pickle': [] },
    // A record that does not parse names no model.
    models: ['deepseek/deepseek-v4-pro', 'opencode/big-pickle'],
  });
  assert.equal(JSON.stringify(catalog).includes('sk-not-read'), false);
  assert.throws(() => parseOpenCodeModelsOutput(''), /OpenCode did not report any models/);
});

// A model is a record whose `providerID` and `id` spell the name printed just before
// it, with its own menu: an id with any characters (newlines and a `{` line too) is
// listed whole, and other output, such as a wrapper script's notice or JSON log, is
// not a model, nor the default. The same holds for output in CRLF, as a terminal
// prints it.
test('parseOpenCodeModelsOutput lists each model record OpenCode named, and nothing else', () => {
  const log = { event: 'catalog.refresh', id: 'refresh-42', level: 'info', providerID: 'review' };
  const output = [
    'Loading models from /workspace/catalog',
    JSON.stringify(log),
    JSON.stringify(log, null, 2),
    'review/refresh-43',
    JSON.stringify({ ...log, id: 'refresh-44' }, null, 2),
    openCodeVerbose([
      ['review/aa-normal', { variants: { high: {} } }],
      ['review/bb\\model', { variants: { low: {} } }],
      ['review/cc"quoted', {}],
      ['review/dd {braced} spaced', { variants: { max: {} } }],
      ['review/ee\u0001control', { variants: {} }],
      ['review/multi\nline', { variants: { high: {} } }],
      ['review/multi\n{\nbrace', { variants: { low: {} } }],
      ['review/gg-normal', { variants: { medium: {} } }],
    ]),
    'review/hh-no-record',
    JSON.stringify({ level: 'info', msg: 'a log line on stdout' }),
    'review/ii-not-named',
    JSON.stringify({ variants: { high: {} } }, null, 2),
    'Done: /workspace/catalog',
  ].join('\n');
  const expected = {
    defaultModel: 'review/aa-normal',
    modelReasoningEfforts: {
      'review/aa-normal': ['high'],
      'review/bb\\model': ['low'],
      'review/cc"quoted': [],
      'review/dd {braced} spaced': ['max'],
      'review/ee\u0001control': [],
      'review/multi\nline': ['high'],
      'review/multi\n{\nbrace': ['low'],
      'review/gg-normal': ['medium'],
    },
    models: [
      'review/aa-normal',
      'review/bb\\model',
      'review/cc"quoted',
      'review/dd {braced} spaced',
      'review/ee\u0001control',
      'review/multi\nline',
      'review/multi\n{\nbrace',
      'review/gg-normal',
    ],
  };
  assert.deepEqual(parseOpenCodeModelsOutput(output), expected);
  assert.deepEqual(parseOpenCodeModelsOutput(output.replaceAll('\n', '\r\n')), expected);
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
  // Aliases that name Object members are ordinary own keys.
  const members = parseKimiProviderList('{"models":{"constructor":{"supportEfforts":["low","high"]},"__proto__":{"supportEfforts":["max"]},"toString":{}}}');
  assert.deepEqual(members.models, ['constructor', '__proto__', 'toString']);
  assert.deepEqual(Object.entries(members.modelReasoningEfforts!), [['constructor', ['low', 'high']], ['__proto__', ['max']], ['toString', []]]);
});

/** Resolves once `pid` is gone, or false after about 3s. */
async function processGone(pid: number): Promise<boolean> {
  assert.ok(pid > 0);
  for (let i = 0; i < 60; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** Resolves with the pid a script wrote to `file`, waiting up to about 15s for it (a loaded machine). */
async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 300; i += 1) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (Number(text) > 0) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no pid in ${file}`);
}

// Everything the server reads from a model-list probe is the probe script's stdout:
// one line holding the catalog or an error. A CLI's credentials and other output
// never get there.
test('model-list probe: only the catalog leaves the probe process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-model-list-boundary-'));
  try {
    const kimi = join(dir, 'kimi');
    await writeFile(kimi, [
      `#!${process.execPath}`,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        default_model: 'kimi-code/k3',
        models: { constructor: { supportEfforts: ['low', 'high'] }, 'kimi-code/k3': { apiKey: 'sk-marker-model', supportEfforts: ['high'] } },
        providers: { review: { apiKey: 'sk-marker-provider', baseUrl: 'https://example.invalid' } },
      }))});`,
    ].join('\n'), 'utf8');
    await chmod(kimi, 0o755);
    const script = fileURLToPath(new URL('../services/model-list-probe.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [script, '1048576', '0', 'kimi', kimi, 'provider', 'list', '--json'], { cwd: dir });
    assert.equal(stdout.includes('sk-marker'), false);
    assert.equal(stdout.includes('example.invalid'), false);
    assert.equal(stdout.split('\n').filter(Boolean).length, 1);
    assert.deepEqual(JSON.parse(stdout), {
      catalog: { defaultModel: 0, models: [['constructor', ['low', 'high']], ['kimi-code/k3', ['high']]] },
    });

    const failing = join(dir, 'failing');
    await writeFile(failing, `#!${process.execPath}\nprocess.stdout.write('apiKey=sk-marker-fail'); process.exit(3);`, 'utf8');
    await chmod(failing, 0o755);
    const failed = await promisify(execFile)(process.execPath, [script, '1048576', '0', 'kimi', failing], { cwd: dir });
    assert.deepEqual(JSON.parse(failed.stdout), { error: 'Kimi Code model list exited (3)' });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// The probe names each model once (the default by its place in the list); the server
// takes back only string ids and their menus.
test('model-list replies carry each model once, and the server keeps ids and menus only', () => {
  const catalog = {
    defaultModel: 'b',
    modelReasoningEfforts: Object.fromEntries([['a', ['high']], ['__proto__', []]]),
    models: ['a', 'b', '__proto__'],
  };
  const reply = modelListReply(catalog);
  assert.deepEqual(reply, { defaultModel: 1, models: [['a', ['high']], ['b'], ['__proto__', []]] });
  assert.deepEqual(modelListCatalog(JSON.parse(JSON.stringify(reply))), catalog);
  assert.deepEqual(
    modelListCatalog({
      apiKey: 'sk-not-kept',
      defaultModel: 'b',
      models: [['a', ['high', 3, '']], ['b', 'high', 'sk-not-kept'], ['a', ['low']], [7], 'c', [''], []],
    }),
    { defaultModel: 'a', modelReasoningEfforts: { a: ['high'] }, models: ['a', 'b'] },
  );
  // The index counts the reply's entries, so a dropped entry moves no other model into its place.
  assert.equal(modelListCatalog({ defaultModel: 1, models: [['a'], [7], ['c']] })?.defaultModel, 'a');
  assert.equal(modelListCatalog({ defaultModel: 2, models: [['a'], [7], ['c']] })?.defaultModel, 'c');
  assert.equal(modelListCatalog({ models: [] }), undefined);
  assert.equal(modelListCatalog('a'), undefined);
});

// A `{` line that starts no record costs no parse, so a long run of them before the
// list is read in one pass (one parse each would take minutes).
test('parseOpenCodeModelsOutput reads a long run of `{` lines in one pass', () => {
  const started = performance.now();
  const output = `${'{\n'.repeat(200_000)}}\n${openCodeVerbose([['review/aa-normal', { variants: { high: {} } }]])}`;
  assert.deepEqual(parseOpenCodeModelsOutput(output).models, ['review/aa-normal']);
  assert.ok(performance.now() - started < 10_000);
});

// A list as long as the output cap allows still arrives whole: the reply limit
// follows the output limit. Kimi Code aliases of bytes that are not UTF-8 are the
// costliest case for the reply: each such byte is three (U+FFFD) there.
test('model-list probe: a list that fills the output limit arrives whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-model-list-size-'));
  try {
    const maxBytes = 256 * 1024;
    const idBytes = maxBytes / 4 - 64;
    const ids: string[] = [];
    const parts: Buffer[] = [Buffer.from('{"models":{')];
    for (let i = 0; i < 4; i += 1) {
      ids.push(`${i}${'\ufffd'.repeat(idBytes)}`);
      parts.push(Buffer.from(`${i ? ',' : ''}"${i}`), Buffer.alloc(idBytes, 0x80), Buffer.from('":{}'));
    }
    parts.push(Buffer.from('}}'));
    const output = Buffer.concat(parts);
    assert.ok(output.length <= maxBytes);
    const outputFile = join(dir, 'models.json');
    await writeFile(outputFile, output);
    const kimi = join(dir, 'kimi');
    await writeFile(kimi, `#!${process.execPath}\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(outputFile)}));`, 'utf8');
    await chmod(kimi, 0o755);
    const catalog = await modelListProbe('kimi', kimi, [], { cwd: join(dir, 'probe'), env: process.env, maxBytes, timeoutMs: 30_000 });
    assert.equal(catalog.models.length, ids.length);
    assert.equal(catalog.models.at(-1), ids.at(-1));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('model-list probe: stdout is read while stderr floods, and failures carry no output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-model-list-probe-'));
  try {
    const script = async (name: string, body: string) => {
      const file = join(dir, name);
      await writeFile(file, [`#!${process.execPath}`, body].join('\n'), 'utf8');
      await chmod(file, 0o755);
      return file;
    };
    const run = (command: string, options: { maxBytes?: number; timeoutMs?: number } = {}) =>
      modelListProbe('kimi', command, ['list'], { cwd: join(dir, 'probe'), env: process.env, killGraceMs: 200, ...options });

    // The CLI runs with the given arguments in the probe directory; the alias carries both.
    const chatty = await script('chatty', `${floodStderr(1_000_000)}\nprocess.stdout.write(JSON.stringify({ models: { [JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })]: {} }, providers: { x: { apiKey: 'sk-secret' } } }));`);
    const catalog = await run(chatty, { timeoutMs: 10_000 });
    assert.deepEqual(JSON.parse(catalog.models[0]!), { argv: ['list'], cwd: await realpath(join(dir, 'probe')) });

    const failing = await script('failing', "process.stdout.write('apiKey=sk-secret'); process.exit(3);");
    await assert.rejects(run(failing, { timeoutMs: 10_000 }), (error: Error) => error.message === 'Kimi Code model list exited (3)');

    const notJson = await script('not-json', "process.stdout.write('apiKey=sk-secret');");
    await assert.rejects(run(notJson, { timeoutMs: 10_000 }), (error: Error) => error.message === 'Kimi Code provider list was not JSON');

    await assert.rejects(run(join(dir, 'missing'), { timeoutMs: 10_000 }), (error: Error) => error.message === 'Kimi Code model list could not start (ENOENT)');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// A CLI is often a wrapper script that starts the real one. When the probe gives up
// (time, or too much output) the wrapper and the CLI it started both end, even a CLI
// that ignores SIGTERM.
test('model-list probe: giving up ends the wrapper and the CLI it started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-model-list-tree-'));
  try {
    const wrapped = async (name: string, cliBody: string) => {
      const cli = join(dir, `${name}-cli`);
      await writeFile(cli, [
        `#!${process.execPath}`,
        `require('fs').writeFileSync(${JSON.stringify(join(dir, `${name}-cli.pid`))}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        cliBody,
        'setInterval(() => {}, 1000);',
      ].join('\n'), 'utf8');
      const wrapper = join(dir, name);
      // Not `exec`: the wrapper waits on the CLI, as many launch scripts do.
      await writeFile(wrapper, `#!/bin/sh\necho $$ > ${JSON.stringify(join(dir, `${name}.pid`))}\n${JSON.stringify(cli)} "$@"\n`, 'utf8');
      await chmod(cli, 0o755);
      await chmod(wrapper, 0o755);
      return wrapper;
    };
    const cases: Array<[string, string, { maxBytes?: number; timeoutMs: number }, string]> = [
      // Long enough for a loaded machine to start the probe, the wrapper and the CLI.
      ['hanging', "process.stdout.write('apiKey=sk-secret');", { timeoutMs: 6_000 }, 'Kimi Code model list timed out'],
      ['flooding', "process.stdout.write('x'.repeat(4096));", { maxBytes: 1024, timeoutMs: 10_000 }, 'Kimi Code model list wrote more output than expected'],
    ];
    for (const [name, body, options, message] of cases) {
      const wrapper = await wrapped(name, body);
      await assert.rejects(
        modelListProbe('kimi', wrapper, ['list'], { cwd: join(dir, 'probe'), env: process.env, killGraceMs: 200, ...options }),
        (error: Error) => error.message === message,
      );
      const wrapperPid = await pidFrom(join(dir, `${name}.pid`));
      const cliPid = await pidFrom(join(dir, `${name}-cli.pid`));
      assert.equal(await processGone(wrapperPid), true, `${name} wrapper`);
      assert.equal(await processGone(cliPid), true, `${name} CLI`);
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// A process that ends a probe and then shuts down, whether it lets its event loop
// drain (the web service) or waits on processGroupsEnded and exits, does not leave
// the probe's CLI running, even one that ignores SIGTERM. Nor does one that stalls
// past the grace period first: KILL still goes out.
test('model-list probe: shutting down after a probe waits until its CLI is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-model-list-shutdown-'));
  try {
    for (const exit of ['drain', 'explicit', 'stalled']) {
      const cli = join(dir, `${exit}-cli`);
      await writeFile(cli, [
        `#!${process.execPath}`,
        `require('fs').writeFileSync(${JSON.stringify(join(dir, `${exit}-cli.pid`))}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join('\n'), 'utf8');
      const wrapper = join(dir, exit);
      await writeFile(wrapper, `#!/bin/sh\necho $$ > ${JSON.stringify(join(dir, `${exit}.pid`))}\n${JSON.stringify(cli)} "$@"\n`, 'utf8');
      await chmod(cli, 0o755);
      await chmod(wrapper, 0o755);
      const host = join(dir, `${exit}-host.mjs`);
      await writeFile(host, [
        `const { modelListProbe, processGroupsEnded } = await import(${JSON.stringify(SYSTEM_SERVICE_MODULE)});`,
        `await modelListProbe('kimi', ${JSON.stringify(wrapper)}, [], { cwd: ${JSON.stringify(join(dir, 'probe'))}, env: process.env, killGraceMs: 500, timeoutMs: 6000 }).catch(() => {});`,
        exit === 'explicit' ? 'await processGroupsEnded(); process.exit(0);' : '',
        // Blocks this process for longer than the grace period and the 2s after it.
        exit === 'stalled' ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);' : '',
      ].join('\n'), 'utf8');
      await promisify(execFile)(process.execPath, [host], { cwd: dir, timeout: 30_000 });
      const wrapperPid = await pidFrom(join(dir, `${exit}.pid`));
      const cliPid = await pidFrom(join(dir, `${exit}-cli.pid`));
      assert.equal(await processGone(wrapperPid), true, `${exit} wrapper`);
      assert.equal(await processGone(cliPid), true, `${exit} CLI`);
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// If the server is gone before it ends a probe, the probe's group ends itself at its
// deadline.
test('model-list probe: a probe the server never ends ends itself at its deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-model-list-deadline-'));
  try {
    const cli = join(dir, 'cli');
    await writeFile(cli, [
      `#!${process.execPath}`,
      `require('fs').writeFileSync(${JSON.stringify(join(dir, 'cli.pid'))}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    await chmod(cli, 0o755);
    const script = fileURLToPath(new URL('../services/model-list-probe.js', import.meta.url));
    const { spawn } = await import('node:child_process');
    const probe = spawn(process.execPath, [script, '1048576', '4000', 'kimi', cli], { cwd: dir, detached: true, stdio: 'ignore' });
    const exited = new Promise((resolve) => probe.once('exit', resolve));
    const cliPid = await pidFrom(join(dir, 'cli.pid'));
    await exited;
    assert.equal(await processGone(cliPid), true, 'CLI');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// If the server is gone when the probe has its answer (here, too much output), the
// reply cannot be delivered; the probe ends its group then, not only at its deadline.
test('model-list probe: a reply the server is gone for still ends the wrapper and the CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-model-list-orphan-'));
  let probePid = 0;
  try {
    const go = join(dir, 'go');
    const cli = join(dir, 'cli');
    await writeFile(cli, [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(join(dir, 'cli.pid'))}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      `const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(wait); process.stdout.write('x'.repeat(4096)); } }, 20);`,
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    const wrapper = join(dir, 'kimi');
    await writeFile(wrapper, `#!/bin/sh\necho $$ > ${JSON.stringify(join(dir, 'wrapper.pid'))}\n${JSON.stringify(cli)} "$@"\n`, 'utf8');
    await chmod(cli, 0o755);
    await chmod(wrapper, 0o755);
    const script = fileURLToPath(new URL('../services/model-list-probe.js', import.meta.url));
    const { spawn } = await import('node:child_process');
    const probe = spawn(process.execPath, [script, '1024', '60000', 'kimi', wrapper], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    probePid = probe.pid ?? 0;
    const wrapperPid = await pidFrom(join(dir, 'wrapper.pid'));
    const cliPid = await pidFrom(join(dir, 'cli.pid'));
    // The server goes away, then the CLI answers.
    probe.stdout?.destroy();
    await writeFile(go, '', 'utf8');
    assert.equal(await processGone(cliPid), true, 'CLI');
    assert.equal(await processGone(wrapperPid), true, 'wrapper');
    assert.equal(await processGone(probePid), true, 'probe');
  } finally {
    // A failed run must not leave the group behind: its CLI ignores SIGTERM.
    if (probePid > 0) {
      try {
        process.kill(-probePid, 0);
        process.kill(-probePid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
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
    // A JSON log on stdout ahead of the list is not the default.
    const opencodeOutput = `${JSON.stringify({ event: 'catalog.refresh', id: 'refresh-42', providerID: 'review' }, null, 2)}\n${openCodeVerbose([
      ['deepseek/deepseek-v4-pro', { variants: { high: {}, low: {}, max: {} } }],
      ['deepseek/deepseek-v5', { variants: { high: {} } }],
    ])}`;
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
