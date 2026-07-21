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

test('Grok context limit updates and clears only Anima-owned model keys', async () => {
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
    assert.equal((written.match(/context_window = 131072/g) ?? []).length, 1);
    assert.match(written, /theme = "dark"/);
    assert.match(written, /reasoning_effort = "high"/);

    await service.set({ maxTokens: null, provider: 'grok-cli' });
    written = await readFile(configPath, 'utf8');
    assert.doesNotMatch(written, /Managed by Anima|context_window/);
    assert.match(written, /theme = "dark"/);
    assert.match(written, /reasoning_effort = "high"/);
    assert.deepEqual(await settings.getProviderContextLimits(), {});
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('an explicit save adopts an existing model context key and Provider maximum removes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-context-limit-conflict-'));
  const grokHome = join(root, 'grok');
  const configPath = join(grokHome, 'config.toml');
  const original = '[model."grok-4.5"]\ncontext_window = 500000\n';
  await mkdir(grokHome, { recursive: true });
  await writeFile(configPath, original, 'utf8');
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
      '[model."grok-4.5"]\n# Managed by Anima: global provider context limit.\ncontext_window = 200000\n',
    );
    assert.deepEqual(await settings.getProviderContextLimits(), {
      'grok-cli': 200_000,
    });

    await service.set({ maxTokens: null, provider: 'grok-cli' });
    assert.equal(await readFile(configPath, 'utf8'), '[model."grok-4.5"]\n');
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
  await mkdir(join(root, 'anima'), { recursive: true });
  await settings.setProviderContextLimit('grok-cli', 200_000);
  const service = new ProviderContextLimitService({ settings });

  try {
    await service.applyForLaunch('grok-cli', 'grok-4.20', {
      GROK_HOME: grokHome,
    });
    assert.match(
      await readFile(join(grokHome, 'config.toml'), 'utf8'),
      /\[model\."grok-4\.20"\]\n# Managed by Anima: global provider context limit\.\ncontext_window = 200000/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
