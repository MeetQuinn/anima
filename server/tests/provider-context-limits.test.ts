import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ProviderContextLimitError,
  ProviderContextLimitService,
} from '../provider-context/provider-context-limit.service.js';
import { ServerSettingsService } from '../settings/settings.service.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';

const noLock = async <T>(
  _provider: 'grok-cli' | 'kimi-cli',
  task: () => Promise<T>,
): Promise<T> => task();

async function writeGrokModelsCache(
  grokHome: string,
  windows: Record<string, number>,
): Promise<void> {
  await writeFile(
    join(grokHome, 'models_cache.json'),
    JSON.stringify({
      models: Object.fromEntries(
        Object.entries(windows).map(([model, contextWindow]) => [
          model,
          {
            api_key: 'secret-sentinel',
            info: { context_window: contextWindow },
          },
        ]),
      ),
    }),
    { mode: 0o600 },
  );
}

test('Kimi context limit is global, model-scoped, and preserves the existing config byte-for-byte outside owned lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-kimi-context-limit-'));
  const animaHome = join(root, 'anima');
  const kimiHome = join(root, 'kimi');
  const configPath = join(kimiHome, 'config.toml');
  const original = [
    '# operator comment',
    'default_model = "kimi-code/k3"',
    'api_key = "secret-sentinel"',
    '',
    '[models."kimi-code/k3"]',
    'provider = "kimi-code"',
    'max_context_size = 1048576',
    '',
  ].join('\n');
  await mkdir(kimiHome, { recursive: true });
  await mkdir(animaHome, { recursive: true });
  await writeFile(configPath, original, { mode: 0o600 });
  const settings = new ServerSettingsService(new ServerConfigStore(animaHome));
  const service = new ProviderContextLimitService({
    env: { KIMI_CODE_HOME: kimiHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'kimi-cli', model: 'kimi-code/k3' } },
      { provider: { kind: 'kimi-cli', model: 'kimi-code/k2.5' } },
      { provider: { kind: 'codex-cli', model: 'gpt-5.5' } },
    ],
    settings,
    withConfigurationGate: noLock,
  });

  try {
    const response = await service.set({
      maxTokens: 262_144,
      provider: 'kimi-cli',
    });
    assert.equal(
      response.providers.find((row) => row.provider === 'kimi-cli')?.maxTokens,
      262_144,
    );
    assert.deepEqual(await settings.getProviderContextLimits(), {
      'kimi-cli': 262_144,
    });

    const written = await readFile(configPath, 'utf8');
    assert.match(
      written,
      /# operator comment\ndefault_model = "kimi-code\/k3"\napi_key = "secret-sentinel"/,
    );
    assert.match(
      written,
      /\[models\."kimi-code\/k3"\]\nprovider = "kimi-code"\n# Managed by Anima: global provider context limit\.\nmax_context_size = 262144/,
    );
    assert.match(
      written,
      /\[models\."kimi-code\/k2\.5"\]\n# Managed by Anima: global provider context limit\.\nmax_context_size = 262144/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Grok context limit uses the session compaction authority and clears only Anima-owned keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-grok-context-limit-'));
  const grokHome = join(root, 'grok');
  const configPath = join(grokHome, 'config.toml');
  await mkdir(grokHome, { recursive: true });
  await writeFile(
    configPath,
    [
      'theme = "dark"',
      '',
      '[model."grok-4.5"]',
      'reasoning_effort = "high"',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeGrokModelsCache(grokHome, { 'grok-4.5': 500_000 });
  const settings = new ServerSettingsService(
    new ServerConfigStore(join(root, 'anima')),
  );
  await mkdir(join(root, 'anima'), { recursive: true });
  const service = new ProviderContextLimitService({
    env: { GROK_HOME: grokHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'grok-cli', model: 'grok-4.5' } },
    ],
    settings,
    withConfigurationGate: noLock,
  });

  try {
    await service.set({ maxTokens: 200_000, provider: 'grok-cli' });
    await service.set({ maxTokens: 131_072, provider: 'grok-cli' });
    let written = await readFile(configPath, 'utf8');
    assert.equal(
      (
        written.match(
          /# Managed by Anima: global provider context limit\.\nauto_compact_threshold_percent = 26/g,
        ) ?? []
      ).length,
      1,
    );
    assert.doesNotMatch(written, /context_window/);
    assert.match(written, /theme = "dark"/);
    assert.match(written, /reasoning_effort = "high"/);

    await service.set({ maxTokens: null, provider: 'grok-cli' });
    written = await readFile(configPath, 'utf8');
    assert.doesNotMatch(
      written,
      /Managed by Anima|auto_compact_threshold_percent|context_window/,
    );
    assert.match(written, /theme = "dark"/);
    assert.match(written, /reasoning_effort = "high"/);
    assert.deepEqual(await settings.getProviderContextLimits(), {});
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('an explicit save adopts an existing Grok session threshold while preserving external model config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-context-limit-conflict-'));
  const grokHome = join(root, 'grok');
  const configPath = join(grokHome, 'config.toml');
  const original = [
    '[session]',
    'auto_compact_threshold_percent = 85',
    '',
    '[model."grok-4.5"]',
    'context_window = 500000',
    '',
  ].join('\n');
  await mkdir(grokHome, { recursive: true });
  await writeFile(configPath, original, 'utf8');
  await writeGrokModelsCache(grokHome, { 'grok-4.5': 500_000 });
  const settings = new ServerSettingsService(
    new ServerConfigStore(join(root, 'anima')),
  );
  await mkdir(join(root, 'anima'), { recursive: true });
  const service = new ProviderContextLimitService({
    env: { GROK_HOME: grokHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'grok-cli', model: 'grok-4.5' } },
    ],
    settings,
    withConfigurationGate: noLock,
  });

  try {
    await service.set({ maxTokens: 200_000, provider: 'grok-cli' });
    assert.equal(
      await readFile(configPath, 'utf8'),
      [
        '[session]',
        '# Managed by Anima: global provider context limit.',
        'auto_compact_threshold_percent = 40',
        '',
        '[model."grok-4.5"]',
        'context_window = 500000',
        '',
      ].join('\n'),
    );
    assert.deepEqual(await settings.getProviderContextLimits(), {
      'grok-cli': 200_000,
    });

    await service.set({ maxTokens: null, provider: 'grok-cli' });
    assert.equal(
      await readFile(configPath, 'utf8'),
      [
        '[session]',
        '',
        '[model."grok-4.5"]',
        'context_window = 500000',
        '',
      ].join('\n'),
    );
    assert.deepEqual(await settings.getProviderContextLimits(), {});
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('a settings write failure restores the provider config exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-context-limit-rollback-'));
  const kimiHome = join(root, 'kimi');
  const configPath = join(kimiHome, 'config.toml');
  const original = '# keep this exact\ndefault_model = "kimi-code/k3"\n';
  await mkdir(kimiHome, { recursive: true });
  await writeFile(configPath, original, 'utf8');
  const service = new ProviderContextLimitService({
    env: { KIMI_CODE_HOME: kimiHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'kimi-cli', model: 'kimi-code/k3' } },
    ],
    settings: {
      getProviderContextLimits: async () => ({}),
      setProviderContextLimit: async () => {
        throw new Error('settings write failed');
      },
    },
    withConfigurationGate: noLock,
  });

  try {
    await assert.rejects(
      () => service.set({ maxTokens: 262_144, provider: 'kimi-cli' }),
      /settings write failed/,
    );
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('provider config targets refuse symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-context-limit-symlink-'));
  const kimiHome = join(root, 'kimi');
  const outside = join(root, 'outside.toml');
  await mkdir(kimiHome, { recursive: true });
  await writeFile(outside, 'outside = true\n', 'utf8');
  await symlink(outside, join(kimiHome, 'config.toml'));
  await mkdir(join(root, 'anima'), { recursive: true });
  const service = new ProviderContextLimitService({
    env: { KIMI_CODE_HOME: kimiHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'kimi-cli', model: 'kimi-code/k3' } },
    ],
    settings: new ServerSettingsService(
      new ServerConfigStore(join(root, 'anima')),
    ),
    withConfigurationGate: noLock,
  });

  try {
    await assert.rejects(
      () => service.set({ maxTokens: 262_144, provider: 'kimi-cli' }),
      (error: unknown) =>
        error instanceof ProviderContextLimitError && error.statusCode === 409,
    );
    assert.equal(await readFile(outside, 'utf8'), 'outside = true\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('a persisted global limit is applied to a newly launched model before provider spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-context-limit-launch-'));
  const grokHome = join(root, 'grok');
  const settings = new ServerSettingsService(
    new ServerConfigStore(join(root, 'anima')),
  );
  await mkdir(grokHome, { recursive: true });
  await writeGrokModelsCache(grokHome, {
    'grok-4.20': 500_000,
    'grok-composer-2.5-fast': 1_000_000,
  });
  await mkdir(join(root, 'anima'), { recursive: true });
  await settings.setProviderContextLimit('grok-cli', 200_000);
  const service = new ProviderContextLimitService({
    listAgentConfigs: async () => [
      {
        provider: {
          kind: 'grok-cli',
          model: 'grok-composer-2.5-fast',
        },
      },
    ],
    settings,
  });

  try {
    await service.applyForLaunch('grok-cli', 'grok-4.20', {
      GROK_HOME: grokHome,
    });
    assert.match(
      await readFile(join(grokHome, 'config.toml'), 'utf8'),
      /\[session\]\n# Managed by Anima: global provider context limit\.\nauto_compact_threshold_percent = 20/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Grok context limit migrates the legacy Anima-owned model key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-grok-context-limit-migration-'));
  const grokHome = join(root, 'grok');
  const configPath = join(grokHome, 'config.toml');
  await mkdir(grokHome, { recursive: true });
  await writeFile(
    configPath,
    [
      '[model."grok-4.5"]',
      '# Managed by Anima: global provider context limit.',
      'context_window = 200000',
      'reasoning_effort = "high"',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeGrokModelsCache(grokHome, { 'grok-4.5': 500_000 });
  const settings = new ServerSettingsService(
    new ServerConfigStore(join(root, 'anima')),
  );
  await mkdir(join(root, 'anima'), { recursive: true });
  const service = new ProviderContextLimitService({
    env: { GROK_HOME: grokHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'grok-cli', model: 'grok-4.5' } },
    ],
    settings,
    withConfigurationGate: noLock,
  });

  try {
    await service.set({ maxTokens: 200_000, provider: 'grok-cli' });
    const written = await readFile(configPath, 'utf8');
    assert.doesNotMatch(written, /context_window/);
    assert.match(written, /reasoning_effort = "high"/);
    assert.match(
      written,
      /\[session\]\n# Managed by Anima: global provider context limit\.\nauto_compact_threshold_percent = 40/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Grok context limit fails closed when native model metadata is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-grok-context-limit-metadata-'));
  const grokHome = join(root, 'grok');
  const animaHome = join(root, 'anima');
  await mkdir(animaHome, { recursive: true });
  const settings = new ServerSettingsService(new ServerConfigStore(animaHome));
  const service = new ProviderContextLimitService({
    env: { GROK_HOME: grokHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'grok-cli', model: 'grok-4.5' } },
    ],
    settings,
    withConfigurationGate: noLock,
  });

  try {
    await assert.rejects(
      () => service.set({ maxTokens: 200_000, provider: 'grok-cli' }),
      (error: unknown) =>
        error instanceof ProviderContextLimitError &&
        error.statusCode === 409 &&
        /metadata is unavailable/.test(error.message),
    );
    assert.deepEqual(await settings.getProviderContextLimits(), {});
    await assert.rejects(() => readFile(join(grokHome, 'config.toml'), 'utf8'), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Grok context limit fails closed when its integer percentage cannot represent the cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-grok-context-limit-range-'));
  const grokHome = join(root, 'grok');
  const animaHome = join(root, 'anima');
  await mkdir(grokHome, { recursive: true });
  await mkdir(animaHome, { recursive: true });
  await writeGrokModelsCache(grokHome, { 'grok-oversized': 50_000_000 });
  const settings = new ServerSettingsService(new ServerConfigStore(animaHome));
  const service = new ProviderContextLimitService({
    env: { GROK_HOME: grokHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'grok-cli', model: 'grok-oversized' } },
    ],
    settings,
    withConfigurationGate: noLock,
  });

  try {
    await assert.rejects(
      () => service.set({ maxTokens: 131_072, provider: 'grok-cli' }),
      (error: unknown) =>
        error instanceof ProviderContextLimitError &&
        error.statusCode === 409 &&
        /cannot represent/.test(error.message),
    );
    assert.deepEqual(await settings.getProviderContextLimits(), {});
    await assert.rejects(() => readFile(join(grokHome, 'config.toml'), 'utf8'), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Grok context limit rejects duplicate session thresholds without changing config or settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-grok-context-limit-duplicate-'));
  const grokHome = join(root, 'grok');
  const animaHome = join(root, 'anima');
  const configPath = join(grokHome, 'config.toml');
  const original = [
    '[session]',
    'auto_compact_threshold_percent = 85',
    'auto_compact_threshold_percent = 80',
    '',
  ].join('\n');
  await mkdir(grokHome, { recursive: true });
  await mkdir(animaHome, { recursive: true });
  await writeFile(configPath, original, 'utf8');
  await writeGrokModelsCache(grokHome, { 'grok-4.5': 500_000 });
  const settings = new ServerSettingsService(new ServerConfigStore(animaHome));
  const service = new ProviderContextLimitService({
    env: { GROK_HOME: grokHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'grok-cli', model: 'grok-4.5' } },
    ],
    settings,
    withConfigurationGate: noLock,
  });

  try {
    await assert.rejects(
      () => service.set({ maxTokens: 200_000, provider: 'grok-cli' }),
      (error: unknown) =>
        error instanceof ProviderContextLimitError &&
        error.statusCode === 409 &&
        /duplicate auto_compact_threshold_percent/.test(error.message),
    );
    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.deepEqual(await settings.getProviderContextLimits(), {});
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('a Grok settings failure rolls the compaction threshold migration back exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-grok-context-limit-rollback-'));
  const grokHome = join(root, 'grok');
  const configPath = join(grokHome, 'config.toml');
  const original = [
    '[model."grok-4.5"]',
    '# Managed by Anima: global provider context limit.',
    'context_window = 200000',
    '',
  ].join('\n');
  await mkdir(grokHome, { recursive: true });
  await writeFile(configPath, original, 'utf8');
  await writeGrokModelsCache(grokHome, { 'grok-4.5': 500_000 });
  const service = new ProviderContextLimitService({
    env: { GROK_HOME: grokHome },
    listAgentConfigs: async () => [
      { provider: { kind: 'grok-cli', model: 'grok-4.5' } },
    ],
    settings: {
      getProviderContextLimits: async () => ({}),
      setProviderContextLimit: async () => {
        throw new Error('settings write failed');
      },
    },
    withConfigurationGate: noLock,
  });

  try {
    await assert.rejects(
      () => service.set({ maxTokens: 200_000, provider: 'grok-cli' }),
      /settings write failed/,
    );
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
