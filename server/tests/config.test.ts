import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { loadRuntimeAgents } from '../runtime/host.js';
import { SessionStore } from '../storage/schema/session.store.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { resolveAnimaHome } from '../anima-home.js';
import {
  installManagedRuntime,
  packageSpecifier,
  readManagedRuntimeStatus,
  resolveManagedAnimaHome,
} from '../runtime/managed-runtime.js';
import { AgentCreateRequest, PROVIDER_IDLE_TIMEOUT_MS_DEFAULT } from '../../shared/agent-config.js';
import { providerCatalogEntry } from '../../shared/provider-catalog.js';
import { withAnimaHome } from './anima-home.js';

const agentService = (agentId: string) => defaultAgentRegistryService.serviceFor(agentId);

test('anima home resolution prefers ANIMA_HOME env, then local .anima, then ~/.anima', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-home-resolve-test-'));
  const explicitDir = join(rootDir, 'explicit');
  const previousCwd = process.cwd();
  const previousHome = process.env.ANIMA_HOME;
  try {
    delete process.env.ANIMA_HOME;
    process.chdir(rootDir);

    // No env var, no local .anima → default to ~/.anima
    assert.match(resolveAnimaHome(), /\.anima$/);

    // Local .anima directory present → that wins; config.json itself is optional.
    await mkdir(join(rootDir, '.anima'));
    assert.equal(resolveAnimaHome(), resolve('.anima'));

    // ANIMA_HOME wins over local .anima
    await writeConfig(explicitDir, [{ id: 'explicit' }]);
    await withAnimaHome(explicitDir, async () => {
      assert.equal(resolveAnimaHome(), resolve(explicitDir));
    });
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousHome;
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('managed runtime home defaults to ~/.anima instead of the cwd .anima', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-managed-home-test-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.ANIMA_HOME;
  try {
    delete process.env.ANIMA_HOME;
    process.chdir(rootDir);
    await mkdir(join(rootDir, '.anima'));

    assert.equal(resolveAnimaHome(), resolve('.anima'));
    assert.equal(resolveManagedAnimaHome(), join(homedir(), '.anima'));

    process.env.ANIMA_HOME = join(rootDir, 'explicit-home');
    assert.equal(resolveManagedAnimaHome(), resolve(rootDir, 'explicit-home'));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousHome;
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('managed runtime install writes package metadata', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-managed-runtime-test-'));
  try {
    const runtimeDir = join(rootDir, 'runtime', 'current');
    assert.equal(packageSpecifier({ packageName: '@meetquinn/animactl', version: '0.1.0' }), '@meetquinn/animactl@0.1.0');
    assert.equal(packageSpecifier({ packageName: '@meetquinn/animactl', channel: 'canary' }), '@meetquinn/animactl@canary');
    assert.throws(
      () => packageSpecifier({ packageName: '@meetquinn/animactl', channel: 'canary', version: '0.1.0' }),
      /Choose either --version or --channel/,
    );

    const result = await installManagedRuntime({
      packageName: '@meetquinn/animactl',
      runtimeDir,
      version: '0.1.0',
      runner: async (command, args, options) => {
        assert.equal(command, 'npm');
        assert.deepEqual(args, [
          'install',
          '--prefix',
          runtimeDir,
          '--omit=dev',
          '--no-audit',
          '--fund=false',
          '@meetquinn/animactl@0.1.0',
        ]);
        assert.equal(options.cwd, runtimeDir);
        const packageDir = join(runtimeDir, 'node_modules', '@meetquinn', 'animactl');
        await mkdir(packageDir, { recursive: true });
        await writeFile(
          join(packageDir, 'package.json'),
          `${JSON.stringify({ name: '@meetquinn/animactl', version: '0.1.0' }, null, 2)}\n`,
          'utf8',
        );
        await mkdir(join(packageDir, 'dist', 'server', 'cli'), { recursive: true });
        await writeFile(join(packageDir, 'dist', 'server', 'cli', 'animactl.js'), '', 'utf8');
        return { stdout: 'installed', stderr: '' };
      },
    });

    assert.equal(result.metadata.packageName, '@meetquinn/animactl');
    assert.equal(result.metadata.version, '0.1.0');
    assert.equal(result.metadata.specifier, '@meetquinn/animactl@0.1.0');

    const status = await readManagedRuntimeStatus({ packageName: '@meetquinn/animactl', runtimeDir });
    assert.equal(status.installed, true);
    assert.equal(status.version, '0.1.0');
    assert.equal(status.metadata?.specifier, '@meetquinn/animactl@0.1.0');
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('server config defaults to empty when config.json is missing', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-config-test-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(rootDir);
    await withAnimaHome(rootDir, async () => {
      assert.deepEqual(await defaultServerSettingsService.readConfig(), {});
    });
  } finally {
    process.chdir(previousCwd);
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('config loader resolves homePath relative to the anima home', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-config-test-'));
  try {
    const configDir = join(rootDir, 'config-root');
    await writeConfig(configDir, [
      {
        id: 'anima',
        provider: {
          kind: 'codex-cli',
          model: 'gpt-5.2-codex',
          reasoningEffort: 'high',
        },
        slack: {
          appToken: 'xapp-config',
          botToken: 'xoxb-config',
        },
        homePath: 'agents/anima',
      },
    ]);

    await withAnimaHome(configDir, async () => {
      const agent = await agentService('anima').getConfig();
      assert.equal(agent.homePath, 'agents/anima');
      assert.equal(agent.provider?.kind, 'codex-cli');
      assert.equal(agent.provider.model, 'gpt-5.2-codex');
      assert.equal(agent.provider.idleTimeoutMs, PROVIDER_IDLE_TIMEOUT_MS_DEFAULT);
      assert.ok('reasoningEffort' in agent.provider);
      assert.equal(agent.provider.reasoningEffort, 'high');
      assert.equal(agent.slack?.botToken, 'xoxb-config');
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('config loader reads legacy runtime key as provider config', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-config-test-'));
  try {
    const configDir = join(rootDir, 'config-root');
    await writeConfig(configDir, [
      {
        id: 'legacy',
        runtime: {
          env: { LEGACY_PROVIDER_SECRET: 'kept' },
          kind: 'codex-cli',
          model: 'gpt-5.2-codex',
          reasoningEffort: 'high',
        },
        homePath: 'agents/legacy',
      },
    ]);

    await withAnimaHome(configDir, async () => {
      const agent = await agentService('legacy').getConfig();
      assert.equal(agent.provider.kind, 'codex-cli');
      assert.equal(agent.provider.model, 'gpt-5.2-codex');
      assert.equal(agent.provider.env?.['LEGACY_PROVIDER_SECRET'], 'kept');
      assert.equal(agent.provider.idleTimeoutMs, PROVIDER_IDLE_TIMEOUT_MS_DEFAULT);
      assert.ok('reasoningEffort' in agent.provider);
      assert.equal(agent.provider.reasoningEffort, 'high');
      assert.equal('runtime' in agent, false);
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('kimi provider does not expose or retain reasoning effort', async () => {
  assert.deepEqual(providerCatalogEntry('kimi-cli')?.reasoningEfforts, []);
  assert.throws(
    () => AgentCreateRequest.parse({
      name: 'Kimi',
      homePath: 'agents/kimi',
      role: 'general purpose',
      provider: {
        kind: 'kimi-cli',
        model: 'kimi-code/kimi-for-coding',
        reasoningEffort: 'high',
      },
    }),
    /unsupported reasoningEffort high/,
  );

  const configDir = await mkdtemp(join(tmpdir(), 'anima-config-test-'));
  try {
    await writeConfig(configDir, [
      {
        id: 'kimi',
        provider: {
          kind: 'kimi-cli',
          model: 'kimi-code/kimi-for-coding',
          reasoningEffort: 'high',
        },
        homePath: 'agents/kimi',
      },
    ]);

    await withAnimaHome(configDir, async () => {
      const agent = await agentService('kimi').getConfig();
      assert.equal(agent.provider.kind, 'kimi-cli');
      assert.equal(agent.provider.model, 'kimi-code/kimi-for-coding');
      assert.equal('reasoningEffort' in agent.provider, false);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('provider idle timeout defaults to 30 minutes for all providers', async () => {
  for (const provider of [
    { kind: 'claude-code', model: 'opus' },
    { kind: 'codex-cli', model: 'gpt-5.5' },
    { kind: 'kimi-cli', model: 'kimi-code/kimi-for-coding' },
  ]) {
    const configDir = await mkdtemp(join(tmpdir(), 'anima-config-timeout-test-'));
    try {
      await writeConfig(configDir, [
        {
          id: provider.kind,
          provider,
          homePath: `agents/${provider.kind}`,
        },
      ]);
      await withAnimaHome(configDir, async () => {
        const agent = await agentService(provider.kind).getConfig();
        assert.equal(agent.provider.idleTimeoutMs, PROVIDER_IDLE_TIMEOUT_MS_DEFAULT);
      });
    } finally {
      await rm(configDir, { force: true, recursive: true });
    }
  }
});

test('agent provider env patch preserves, updates, and deletes write-only keys', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-config-env-patch-test-'));
  try {
    await writeConfig(configDir, [
      {
        id: 'anima',
        provider: {
          env: {
            KEEP_ME: 'keep',
            REMOVE_ME: 'remove',
          },
          kind: 'codex-cli',
          model: 'gpt-5.5',
        },
        homePath: 'agents/anima',
      },
    ]);
    await withAnimaHome(configDir, async () => {
      const agent = await agentService('anima').updateProvider({
        env: {
          ADD_ME: 'add',
          REMOVE_ME: null,
        },
      });

      assert.deepEqual(agent.provider.env, {
        ADD_ME: 'add',
        KEEP_ME: 'keep',
      });
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('agent provider env patch rejects Anima-managed launch keys', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-config-env-patch-test-'));
  try {
    await writeConfig(configDir, [
      {
        id: 'anima',
        provider: {
          kind: 'codex-cli',
          model: 'gpt-5.5',
        },
        homePath: 'agents/anima',
      },
    ]);
    await withAnimaHome(configDir, async () => {
      await assert.rejects(
        agentService('anima').updateProvider({
          env: {
            SLACK_BOT_TOKEN: 'bad-token',
          },
        }),
        /SLACK_BOT_TOKEN is managed by Anima/,
      );
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('agent provider kind patch resets provider defaults, preserves env, and archives old session', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-config-provider-kind-test-'));
  try {
    await writeConfig(configDir, [
      {
        id: 'anima',
        provider: {
          env: {
            CUSTOM_LAUNCH_FLAG: 'kept',
          },
          kind: 'codex-cli',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
        },
        homePath: 'agents/anima',
      },
    ]);
    await withAnimaHome(configDir, async () => {
      await new SessionStore('anima').write({
        createdAt: '2026-05-26T00:00:00.000Z',
        current: {
          id: 'codex-thread-1',
          kind: 'codex-cli',
          updatedAt: '2026-05-26T00:01:00.000Z',
        },
        latestProviderStats: {
          activityId: 'act_stats',
          createdAt: '2026-05-26T00:01:00.000Z',
          runtimeKind: 'codex-cli',
          usedTokens: 42,
        },
        updatedAt: '2026-05-26T00:01:00.000Z',
      });

      const agent = await agentService('anima').updateProvider({
        kind: 'claude-code',
      });
      assert.equal(agent.provider.kind, 'claude-code');
      assert.equal(agent.provider.model, 'opus');
      assert.ok('reasoningEffort' in agent.provider);
      assert.equal(agent.provider.reasoningEffort, 'xhigh');
      assert.deepEqual(agent.provider.env, { CUSTOM_LAUNCH_FLAG: 'kept' });

      const session = await new SessionStore('anima').read();
      assert.ok(session);
      assert.equal(session.current, undefined);
      assert.equal(session.latestProviderStats, undefined);
      assert.equal(session.archived?.[0]?.kind, 'codex-cli');
      assert.equal(session.archived?.[0]?.id, 'codex-thread-1');
      assert.match(session.archived?.[0]?.note ?? '', /provider switched from codex-cli to claude-code/);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('agent provider model-only patch keeps current session', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-config-provider-model-test-'));
  try {
    await writeConfig(configDir, [
      {
        id: 'anima',
        provider: {
          kind: 'codex-cli',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
        },
        homePath: 'agents/anima',
      },
    ]);
    await withAnimaHome(configDir, async () => {
      await new SessionStore('anima').write({
        createdAt: '2026-05-26T00:00:00.000Z',
        current: {
          id: 'codex-thread-1',
          kind: 'codex-cli',
          updatedAt: '2026-05-26T00:01:00.000Z',
        },
        updatedAt: '2026-05-26T00:01:00.000Z',
      });

      const agent = await agentService('anima').updateProvider({
        kind: 'codex-cli',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
      });
      assert.equal(agent.provider.model, 'gpt-5.5');
      assert.equal('reasoningEffort' in agent.provider ? agent.provider.reasoningEffort : undefined, 'high');

      const session = await new SessionStore('anima').read();
      assert.ok(session);
      assert.equal(session.current?.id, 'codex-thread-1');
      assert.equal(session.archived, undefined);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('agent provider patch rejects invalid kind/model/effort combinations', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-config-provider-invalid-test-'));
  try {
    await writeConfig(configDir, [
      {
        id: 'anima',
        provider: {
          kind: 'codex-cli',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
        },
        homePath: 'agents/anima',
      },
    ]);
    await withAnimaHome(configDir, async () => {
      await assert.rejects(
        agentService('anima').updateProvider({
          kind: 'claude-code',
          model: 'gpt-5.5',
        }),
        /unsupported model for claude-code: gpt-5.5/,
      );
      await assert.rejects(
        agentService('anima').updateProvider({
          kind: 'kimi-cli',
          reasoningEffort: 'high',
        }),
        /unsupported reasoningEffort high/,
      );
      const agent = await agentService('anima').getConfig();
      assert.equal(agent.provider.kind, 'codex-cli');
      assert.equal(agent.provider.model, 'gpt-5.5');
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('config loader finds named agents and ignores home dirs without config', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-config-test-'));
  try {
    await writeConfig(configDir, [
      { id: 'anima', homePath: 'agents/anima' },
      { id: 'support', profile: { displayName: 'Support Anima' } },
    ]);
    await mkdir(join(configDir, 'agents', 'scratch'), { recursive: true });

    await withAnimaHome(configDir, async () => {
      const support = await agentService('support').getConfig();
      assert.equal(support.profile?.displayName, 'Support Anima');
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('agent config id must match its directory name', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-config-test-'));
  try {
    await writeConfig(configDir, [{ id: 'anima' }]);
    await mkdir(join(configDir, 'agents', 'milo'), { recursive: true });
    await writeFile(
      join(configDir, 'agents', 'milo', 'config.json'),
      `${JSON.stringify({ id: 'nora' }, null, 2)}\n`,
      'utf8',
    );

    await withAnimaHome(configDir, async () => {
      await assert.rejects(defaultAgentRegistryService.listAgentConfigs(), /agent id must match directory name milo/);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('supervisor service commands ignore ambient runtime agent id', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-supervisor-agents-test-'));
  const previousAgentId = process.env.ANIMA_AGENT_ID;
  try {
    await writeConfig(configDir, [{ id: 'anima' }, { id: 'milo' }, { id: 'nora' }]);
    process.env.ANIMA_AGENT_ID = 'nora';

    await withAnimaHome(configDir, async () => {
      assert.deepEqual(
        (await loadRuntimeAgents()).map((agent) => agent.id),
        ['anima', 'milo', 'nora'],
      );
      assert.deepEqual(
        (await loadRuntimeAgents({ agent: 'milo' })).map((agent) => agent.id),
        ['milo'],
      );
    });
  } finally {
    if (previousAgentId === undefined) delete process.env.ANIMA_AGENT_ID;
    else process.env.ANIMA_AGENT_ID = previousAgentId;
    await rm(configDir, { force: true, recursive: true });
  }
});

async function writeConfig(configDir: string, agents: object[]): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  const seenDirs = new Set<string>();
  for (const [index, agent] of agents.entries()) {
    const id = typeof (agent as { id?: unknown }).id === 'string' ? (agent as { id: string }).id : `agent-${index}`;
    const dirName = seenDirs.has(id) ? `${id}-${index}` : id;
    seenDirs.add(dirName);
    const agentDir = join(configDir, 'agents', dirName);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'config.json'), `${JSON.stringify(agent, null, 2)}\n`, 'utf8');
  }
}
