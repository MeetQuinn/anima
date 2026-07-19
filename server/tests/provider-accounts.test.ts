import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentConfig } from '../../shared/agent-config.js';
import type { ProviderAccountsConfig } from '../../shared/provider-accounts.js';
import type { AgentStatusSummary } from '../../shared/snapshot.js';
import {
  applyClaudeAccountToAgent,
  claudeKeychainService,
  discoverClaudeAccounts,
  effectiveClaudeAccountRegistry,
} from '../provider-accounts/claude-account-config.js';
import {
  claudeAccountContinuityNeedsSetupWithRoot,
  ClaudeAccountContinuityError,
  ensureClaudeAccountsContinuityWithRoot,
  ensureClaudeAccountContinuityWithRoot,
} from '../provider-accounts/claude-account-continuity.js';
import { synchronizeClaudeAccountMcpStateAtPaths } from '../provider-accounts/claude-account-mcp.js';
import {
  ProviderAccountError,
  ProviderAccountService,
} from '../provider-accounts/provider-account.service.js';
import { fetchClaudeUsage } from '../provider-usage/providers/claude.js';
import { selectedClaudeUsageConfigDir } from '../provider-usage/provider-usage.service.js';

test('legacy Claude config dirs become one inferred platform account without changing the agent session', () => {
  const secondary = '/profiles/secondary';
  const agents = [claudeAgent('iris', secondary), claudeAgent('nora', secondary)];

  const registry = effectiveClaudeAccountRegistry(undefined, agents);

  assert.equal(registry.activeAccountId, 'secondary');
  assert.deepEqual(registry.accounts, [
    { id: 'primary', label: 'Primary' },
    { configDir: secondary, id: 'secondary', label: 'Secondary' },
  ]);
});

test('an explicit default Claude config dir remains the primary account', () => {
  const agent = claudeAgent('iris', join(homedir(), '.claude'));

  const registry = effectiveClaudeAccountRegistry(undefined, [agent]);

  assert.equal(registry.activeAccountId, 'primary');
  assert.deepEqual(registry.accounts, [{ id: 'primary', label: 'Primary' }]);
});

test('legacy profiles with the same basename receive distinct stable account ids', () => {
  const agents = [
    claudeAgent('iris', '/profiles/a/secondary'),
    claudeAgent('nora', '/profiles/b/secondary'),
  ];

  const registry = effectiveClaudeAccountRegistry(undefined, agents);

  assert.equal(new Set(registry.accounts.map((account) => account.id)).size, 3);
  assert.equal(registry.accounts[1]?.id, 'secondary');
  assert.match(registry.accounts[2]?.id ?? '', /^account-[0-9a-f]{8}$/);
});

test('legacy profile ids remain unique when a configured id occupies the path hash', () => {
  const configDir = '/profiles/a/secondary';
  const hashId = effectiveClaudeAccountRegistry(undefined, [
    claudeAgent('nora', '/profiles/0/secondary'),
    claudeAgent('iris', configDir),
  ]).accounts[2]?.id;
  assert.ok(hashId);
  const registry = effectiveClaudeAccountRegistry(
    {
      accounts: [
        { id: 'primary', label: 'Primary' },
        { configDir: '/profiles/existing', id: 'secondary', label: 'Existing' },
        { configDir: '/profiles/hash-owner', id: hashId, label: 'Hash owner' },
      ],
      activeAccountId: 'primary',
    },
    [claudeAgent('iris', configDir)],
  );

  assert.equal(new Set(registry.accounts.map((account) => account.id)).size, registry.accounts.length);
  assert.match(registry.accounts.at(-1)?.id ?? '', /^account-[0-9a-f]{12}$/);
});

test('platform Claude account selection removes a stale per-agent profile while preserving unrelated env', () => {
  const agent = claudeAgent('iris', '/profiles/secondary');
  agent.provider.env = { CLAUDE_CONFIG_DIR: '/profiles/secondary', FEATURE_FLAG: '1' };

  const primary = applyClaudeAccountToAgent(agent, {
    accounts: [{ id: 'primary', label: 'Primary' }],
    activeAccountId: 'primary',
  });

  assert.deepEqual(primary.provider.env, { FEATURE_FLAG: '1' });
  assert.equal(agent.provider.env?.CLAUDE_CONFIG_DIR, '/profiles/secondary');
});

test('Claude keychain service follows Claude Code config-dir hashing', () => {
  assert.equal(claudeKeychainService(undefined), 'Claude Code-credentials');
  assert.equal(
    claudeKeychainService('/Users/totoday/.claude-profiles/secondary'),
    'Claude Code-credentials-4d412df4',
  );
});

test('Claude profiles with account metadata are discovered without per-agent environment edits', async () => {
  const profilesRoot = await mkdtemp(join(tmpdir(), 'anima-claude-profiles-'));
  try {
    const secondary = join(profilesRoot, 'secondary');
    const signedOut = join(profilesRoot, 'signed-out');
    await mkdir(secondary);
    await mkdir(signedOut);
    await writeFile(
      join(secondary, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'secondary@example.com' } }),
    );
    await writeFile(join(signedOut, '.claude.json'), '{}');

    const discovered = await discoverClaudeAccounts(profilesRoot);
    const registry = effectiveClaudeAccountRegistry(undefined, [claudeAgent('iris')], discovered);

    assert.deepEqual(discovered, [{ configDir: secondary, id: 'secondary', label: 'Secondary' }]);
    assert.equal(registry.activeAccountId, 'primary');
    assert.deepEqual(registry.accounts, [
      { id: 'primary', label: 'Primary' },
      { configDir: secondary, id: 'secondary', label: 'Secondary' },
    ]);
  } finally {
    await rm(profilesRoot, { force: true, recursive: true });
  }
});

test('Claude account continuity replaces a redundant overlay with shared state and keeps a backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-continuity-'));
  const canonical = join(root, 'canonical');
  const profile = join(root, 'profile');
  try {
    await mkdir(join(canonical, 'projects', 'project-a'), { recursive: true });
    await mkdir(join(profile, 'projects'), { recursive: true });
    await writeFile(join(canonical, 'settings.json'), '{"theme":"dark"}\n', 'utf8');
    await symlink(join(canonical, 'projects', 'project-a'), join(profile, 'projects', 'project-a'), 'dir');

    const account = { configDir: profile, id: 'secondary', label: 'Secondary' };
    assert.equal(await claudeAccountContinuityNeedsSetupWithRoot(account, canonical), true);

    await ensureClaudeAccountContinuityWithRoot(
      account,
      canonical,
    );

    assert.equal(await claudeAccountContinuityNeedsSetupWithRoot(account, canonical), false);
    assert.equal(await readlink(join(profile, 'projects')), join(canonical, 'projects'));
    assert.equal(await readlink(join(profile, 'settings.json')), join(canonical, 'settings.json'));
    assert.equal((await lstat(join(profile, 'projects.anima-account-backup'))).isDirectory(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude account continuity refuses independent profile state instead of overwriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-continuity-conflict-'));
  const canonical = join(root, 'canonical');
  const profile = join(root, 'profile');
  try {
    await mkdir(canonical, { recursive: true });
    await mkdir(profile, { recursive: true });
    await writeFile(join(canonical, 'settings.json'), '{"theme":"dark"}\n', 'utf8');
    await writeFile(join(profile, 'settings.json'), '{"theme":"light"}\n', 'utf8');

    await assert.rejects(
      () => ensureClaudeAccountContinuityWithRoot(
        { configDir: profile, id: 'secondary', label: 'Secondary' },
        canonical,
      ),
      ClaudeAccountContinuityError,
    );
    assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), '{"theme":"light"}\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude account continuity refuses profile-only state when the canonical profile has no counterpart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-continuity-profile-only-'));
  const canonical = join(root, 'canonical');
  const profile = join(root, 'profile');
  try {
    await mkdir(canonical, { recursive: true });
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'settings.json'), '{"theme":"light"}\n', 'utf8');

    await assert.rejects(
      () => ensureClaudeAccountContinuityWithRoot(
        { configDir: profile, id: 'secondary', label: 'Secondary' },
        canonical,
      ),
      ClaudeAccountContinuityError,
    );
    assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), '{"theme":"light"}\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude account continuity treats a profile symlink to the canonical root as the same profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-continuity-root-alias-'));
  const canonical = join(root, 'canonical');
  const profile = join(root, 'profile');
  try {
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, 'settings.json'), '{"theme":"dark"}\n', 'utf8');
    await symlink(canonical, profile, 'dir');
    const account = { configDir: profile, id: 'secondary', label: 'Secondary' };

    assert.equal(await claudeAccountContinuityNeedsSetupWithRoot(account, canonical), false);
    await ensureClaudeAccountContinuityWithRoot(account, canonical);

    assert.equal(await readFile(join(canonical, 'settings.json'), 'utf8'), '{"theme":"dark"}\n');
    await assert.rejects(() => lstat(join(canonical, 'settings.json.anima-account-backup')));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude account continuity preflights every profile before linking any state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-continuity-preflight-'));
  const canonical = join(root, 'canonical');
  const safeProfile = join(root, 'safe-profile');
  const conflictingProfile = join(root, 'conflicting-profile');
  try {
    await mkdir(canonical, { recursive: true });
    await mkdir(conflictingProfile, { recursive: true });
    await writeFile(join(canonical, 'settings.json'), '{"theme":"dark"}\n', 'utf8');
    await writeFile(join(conflictingProfile, 'settings.json'), '{"theme":"light"}\n', 'utf8');

    await assert.rejects(
      () => ensureClaudeAccountsContinuityWithRoot(
        [
          { configDir: safeProfile, id: 'safe', label: 'Safe' },
          { configDir: conflictingProfile, id: 'conflicting', label: 'Conflicting' },
        ],
        canonical,
      ),
      ClaudeAccountContinuityError,
    );
    await assert.rejects(() => lstat(join(safeProfile, 'settings.json')));
    assert.equal(
      await readFile(join(conflictingProfile, 'settings.json'), 'utf8'),
      '{"theme":"light"}\n',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude MCP continuity atomically replaces only MCP fields and retains one restricted recovery snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-mcp-continuity-'));
  const sourcePath = join(root, 'source.json');
  const targetPath = join(root, 'target.json');
  const backupPath = `${targetPath}.anima-account-backup`;
  const source = {
    cache: { sourceOnly: true },
    mcpServers: { global: { command: 'source-global' } },
    oauthAccount: { emailAddress: 'source@example.com' },
    projects: {
      '/new-project': {
        mcpServers: { newProject: { command: 'source-new-project' } },
        trust: 'source-only',
      },
      '/repo': {
        disabledMcpServers: ['disabled-user-server'],
        disabledMcpjsonServers: ['disabled-project-server'],
        enabledMcpjsonServers: ['enabled-project-server'],
        mcpContextUris: ['source-cache'],
        mcpServers: { project: { command: 'source-project' } },
        trust: 'source-trust',
      },
    },
  };
  const target = {
    cache: { targetOnly: true },
    mcpServers: { stale: { command: 'stale-global' } },
    oauthAccount: { emailAddress: 'target@example.com' },
    projects: {
      '/repo': {
        mcpContextUris: ['target-cache'],
        mcpServers: { staleProject: { command: 'stale-project' } },
        stats: { sessions: 7 },
        trust: 'target-trust',
      },
      '/stale-project': {
        mcpServers: { staleOnly: { command: 'stale-only' } },
        stats: { sessions: 3 },
      },
    },
  };
  try {
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
    await writeFile(targetPath, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o640 });
    await chmod(targetPath, 0o640);
    const originalTargetInode = (await stat(targetPath)).ino;

    await synchronizeClaudeAccountMcpStateAtPaths(sourcePath, targetPath);

    const next = JSON.parse(await readFile(targetPath, 'utf8')) as {
      cache: typeof target.cache;
      mcpServers: typeof source.mcpServers;
      oauthAccount: typeof target.oauthAccount;
      projects: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(next.oauthAccount, target.oauthAccount);
    assert.deepEqual(next.cache, target.cache);
    assert.deepEqual(next.mcpServers, source.mcpServers);
    assert.deepEqual(next.projects['/repo'], {
      disabledMcpServers: ['disabled-user-server'],
      disabledMcpjsonServers: ['disabled-project-server'],
      enabledMcpjsonServers: ['enabled-project-server'],
      mcpContextUris: ['target-cache'],
      mcpServers: { project: { command: 'source-project' } },
      stats: { sessions: 7 },
      trust: 'target-trust',
    });
    assert.deepEqual(next.projects['/new-project'], {
      mcpServers: { newProject: { command: 'source-new-project' } },
    });
    assert.deepEqual(next.projects['/stale-project'], { stats: { sessions: 3 } });
    assert.deepEqual(JSON.parse(await readFile(backupPath, 'utf8')), target);
    const targetMode = (await stat(targetPath)).mode & 0o777;
    const backupMode = (await stat(backupPath)).mode & 0o777;
    if (process.platform !== 'win32') {
      assert.equal(targetMode, 0o640);
      assert.equal(backupMode & 0o077, 0);
      assert.equal(backupMode & ~targetMode, 0);
      assert.notEqual((await stat(targetPath)).ino, originalTargetInode);
    }
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes('.anima-account-backup')),
      ['target.json.anima-account-backup'],
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes('.anima-account-temp')),
      [],
    );

    const firstSynchronizedTarget = await readFile(targetPath, 'utf8');
    source.mcpServers.global.command = 'source-global-v2';
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
    await synchronizeClaudeAccountMcpStateAtPaths(sourcePath, targetPath);

    assert.equal(
      (JSON.parse(await readFile(targetPath, 'utf8')) as {
        mcpServers: { global: { command: string } };
      }).mcpServers.global.command,
      'source-global-v2',
    );
    assert.equal(await readFile(backupPath, 'utf8'), firstSynchronizedTarget);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes('.anima-account-backup')),
      ['target.json.anima-account-backup'],
    );

    const secondSynchronizedTarget = await readFile(targetPath, 'utf8');
    await writeFile(
      sourcePath,
      JSON.stringify({ oauthAccount: { emailAddress: 'source@example.com' } }),
      { mode: 0o600 },
    );
    await synchronizeClaudeAccountMcpStateAtPaths(sourcePath, targetPath);

    const withoutMcp = JSON.parse(await readFile(targetPath, 'utf8')) as Record<string, unknown>;
    assert.equal(Object.hasOwn(withoutMcp, 'mcpServers'), false);
    assert.equal(await readFile(backupPath, 'utf8'), secondSynchronizedTarget);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude MCP continuity fails closed before writing malformed mixed-purpose metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-mcp-malformed-'));
  const sourcePath = join(root, 'source.json');
  const targetPath = join(root, 'target.json');
  try {
    await writeFile(sourcePath, JSON.stringify({ mcpServers: {}, projects: {} }), 'utf8');
    await writeFile(targetPath, '{"oauthAccount":', 'utf8');
    const originalTarget = await readFile(targetPath, 'utf8');

    await assert.rejects(
      () => synchronizeClaudeAccountMcpStateAtPaths(sourcePath, targetPath),
      /target account metadata is not valid JSON/,
    );

    assert.equal(await readFile(targetPath, 'utf8'), originalTarget);
    await assert.rejects(() => lstat(`${targetPath}.anima-account-backup`));
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes('.anima-account-temp')),
      [],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude MCP continuity refuses metadata symlinks instead of replacing their link target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-mcp-symlink-'));
  const sourcePath = join(root, 'source.json');
  const targetRealPath = join(root, 'target-real.json');
  const targetPath = join(root, 'target.json');
  try {
    await writeFile(sourcePath, JSON.stringify({ mcpServers: { source: {} } }), 'utf8');
    await writeFile(
      targetRealPath,
      JSON.stringify({ mcpServers: { target: {} }, oauthAccount: { emailAddress: 'target@example.com' } }),
      'utf8',
    );
    await symlink(targetRealPath, targetPath, 'file');
    const originalTarget = await readFile(targetRealPath, 'utf8');

    await assert.rejects(
      () => synchronizeClaudeAccountMcpStateAtPaths(sourcePath, targetPath),
      /target account metadata is not a regular file/,
    );

    assert.equal(await readFile(targetRealPath, 'utf8'), originalTarget);
    assert.equal(await readlink(targetPath), targetRealPath);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude MCP continuity refuses a backup symlink instead of copying mixed metadata through it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-mcp-backup-symlink-'));
  const sourcePath = join(root, 'source.json');
  const targetPath = join(root, 'target.json');
  const outsidePath = join(root, 'outside.json');
  try {
    await writeFile(sourcePath, JSON.stringify({ mcpServers: { source: {} } }), 'utf8');
    await writeFile(
      targetPath,
      JSON.stringify({ mcpServers: { target: {} }, oauthAccount: { emailAddress: 'target@example.com' } }),
      'utf8',
    );
    await writeFile(outsidePath, 'outside-canary', 'utf8');
    await symlink(outsidePath, `${targetPath}.anima-account-backup`, 'file');
    const originalTarget = await readFile(targetPath, 'utf8');

    await assert.rejects(
      () => synchronizeClaudeAccountMcpStateAtPaths(sourcePath, targetPath),
      /metadata backup is not a regular file/,
    );

    assert.equal(await readFile(targetPath, 'utf8'), originalTarget);
    assert.equal(await readFile(outsidePath, 'utf8'), 'outside-canary');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude MCP continuity exposes only complete old or new metadata to concurrent readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-claude-mcp-readers-'));
  const sourcePath = join(root, 'source.json');
  const targetPath = join(root, 'target.json');
  try {
    await writeFile(
      sourcePath,
      JSON.stringify({
        mcpServers: {
          marker: { command: 'new' },
          ...Object.fromEntries(
            Array.from({ length: 2_000 }, (_, index) => [
              `server-${index}`,
              { args: [`argument-${index}`], command: 'node' },
            ]),
          ),
        },
      }),
      'utf8',
    );
    await writeFile(
      targetPath,
      JSON.stringify({
        cache: { keep: true },
        mcpServers: { marker: { command: 'old' } },
        oauthAccount: { emailAddress: 'target@example.com' },
      }),
      'utf8',
    );

    let settled = false;
    const synchronization = synchronizeClaudeAccountMcpStateAtPaths(sourcePath, targetPath)
      .finally(() => { settled = true; });
    const observed = new Set<string>();
    do {
      const snapshot = JSON.parse(await readFile(targetPath, 'utf8')) as {
        mcpServers: { marker: { command: string } };
      };
      observed.add(snapshot.mcpServers.marker.command);
    } while (!settled);
    await synchronization;
    observed.add(
      (JSON.parse(await readFile(targetPath, 'utf8')) as {
        mcpServers: { marker: { command: string } };
      }).mcpServers.marker.command,
    );

    assert.equal([...observed].every((value) => value === 'old' || value === 'new'), true);
    assert.equal(observed.has('new'), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Claude usage reads credentials and account identity from the selected config dir', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'anima-claude-usage-profile-'));
  const originalFetch = globalThis.fetch;
  let authorization = '';
  try {
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'secondary@example.com' } }),
      'utf8',
    );
    await writeFile(
      join(profile, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'secondary-token',
          expiresAt: Date.now() + 60 * 60 * 1000,
          subscriptionType: 'max',
        },
      }),
      'utf8',
    );
    globalThis.fetch = (async (_url, init) => {
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    }) as typeof fetch;

    const result = await fetchClaudeUsage({ configDir: profile });

    assert.equal(result.status, 'available');
    assert.equal(result.account, 'secondary@example.com');
    assert.equal(authorization, 'Bearer secondary-token');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(profile, { force: true, recursive: true });
  }
});

test('Claude usage follows the same platform account selection as every agent', () => {
  const secondary = '/profiles/secondary';
  const providerAccounts: ProviderAccountsConfig = {
    claudeCode: {
      accounts: [
        { id: 'primary', label: 'Primary' },
        { configDir: secondary, id: 'secondary', label: 'Secondary' },
      ],
      activeAccountId: 'secondary',
    },
  };

  assert.equal(
    selectedClaudeUsageConfigDir(providerAccounts, [claudeAgent('iris')]),
    secondary,
  );
});

test('platform account switch queues a runtime reload without interrupting active Claude work', async () => {
  const fixture = await accountServiceFixture({ active: true });
  try {
    const state = await fixture.service.selectClaudeAccount('secondary');

    assert.equal(fixture.config().claudeCode?.activeAccountId, 'secondary');
    assert.deepEqual(fixture.restarted, ['iris']);
    assert.equal(state.status, 'switching');
  } finally {
    await fixture.cleanup();
  }
});

test('initial continuity migration refuses to rewrite a profile while Claude work is active', async () => {
  const fixture = await accountServiceFixture({ active: true, continuityNeedsSetup: true });
  try {
    await assert.rejects(
      () => fixture.service.selectClaudeAccount('secondary'),
      /Initial Claude account continuity setup requires idle agents: iris/,
    );
    assert.equal(fixture.writeCount(), 0);
    assert.deepEqual(fixture.restarted, []);
  } finally {
    await fixture.cleanup();
  }
});

test('initial continuity migration refuses to race queued Claude work', async () => {
  const fixture = await accountServiceFixture({ active: false, continuityNeedsSetup: true, queued: true });
  try {
    await assert.rejects(
      () => fixture.service.selectClaudeAccount('secondary'),
      /Initial Claude account continuity setup requires idle agents: iris/,
    );
    assert.equal(fixture.writeCount(), 0);
    assert.deepEqual(fixture.restarted, []);
  } finally {
    await fixture.cleanup();
  }
});

test('platform account switch persists one global target and requests idle runtime reloads without session rotation', async () => {
  const fixture = await accountServiceFixture({ active: false });
  try {
    const state = await fixture.service.selectClaudeAccount('secondary');

    assert.equal(fixture.config().claudeCode?.activeAccountId, 'secondary');
    assert.deepEqual(fixture.restarted, ['iris']);
    assert.equal(state.status, 'switching');
    assert.deepEqual(state.pendingAgentIds, ['iris']);
    assert.equal(fixture.ensureContinuityCalls(), 2);
    assert.deepEqual(fixture.mcpSynchronizations(), [['primary', 'secondary']]);
  } finally {
    await fixture.cleanup();
  }
});

test('platform account switch fails before persistence when MCP continuity cannot be established', async () => {
  const fixture = await accountServiceFixture({ active: false, mcpFailure: true });
  try {
    await assert.rejects(
      () => fixture.service.selectClaudeAccount('secondary'),
      (error) => error instanceof ProviderAccountError
        && error.statusCode === 409
        && /MCP metadata conflict/.test(error.message),
    );

    assert.equal(fixture.config().claudeCode?.activeAccountId, 'primary');
    assert.equal(fixture.writeCount(), 0);
    assert.deepEqual(fixture.restarted, []);
    assert.deepEqual(fixture.mcpSynchronizations(), [['primary', 'secondary']]);
  } finally {
    await fixture.cleanup();
  }
});

test('concurrent platform account selections are serialized around persistence and reload requests', async () => {
  let releaseReload!: () => void;
  let markReloadStarted!: () => void;
  const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
  const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
  const fixture = await accountServiceFixture({ active: false, reloadGate, reloadStarted: markReloadStarted });
  try {
    const first = fixture.service.selectClaudeAccount('secondary');
    await reloadStarted;
    const second = fixture.service.selectClaudeAccount('primary');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(fixture.config().claudeCode?.activeAccountId, 'secondary');
    releaseReload();
    await Promise.all([first, second]);

    assert.equal(fixture.config().claudeCode?.activeAccountId, 'primary');
    assert.deepEqual(fixture.restarted, ['iris', 'iris']);
  } finally {
    releaseReload();
    await fixture.cleanup();
  }
});

test('selecting an inferred legacy account persists the platform registry without restarting matching agents', async () => {
  const fixture = await accountServiceFixture({ active: false, configured: false });
  try {
    const state = await fixture.service.selectClaudeAccount('secondary');

    assert.equal(state.activeAccountId, 'secondary');
    assert.equal(fixture.config().claudeCode?.activeAccountId, 'secondary');
    assert.equal(fixture.writeCount(), 1);
    assert.deepEqual(fixture.restarted, []);
  } finally {
    await fixture.cleanup();
  }
});

test('unauthenticated Claude accounts cannot become the platform account', async () => {
  const fixture = await accountServiceFixture({ active: false, secondaryAuthenticated: false });
  try {
    await assert.rejects(
      () => fixture.service.selectClaudeAccount('secondary'),
      (error) => error instanceof ProviderAccountError
        && error.statusCode === 409
        && /is not authenticated/.test(error.message),
    );
    assert.equal(fixture.writeCount(), 0);
    assert.deepEqual(fixture.restarted, []);
  } finally {
    await fixture.cleanup();
  }
});

test('refresh-only Claude OAuth credentials remain configured', async () => {
  const fixture = await accountServiceFixture({
    active: false,
    secondaryCredentials: { accessToken: '', refreshToken: 'valid-refresh-token' },
  });
  try {
    const state = await fixture.service.claudeState();
    assert.equal(state.accounts.find((account) => account.id === 'secondary')?.status, 'available');
  } finally {
    await fixture.cleanup();
  }
});

test('blank Claude OAuth tokens are not configured and cannot become the platform account', async () => {
  const fixture = await accountServiceFixture({
    active: false,
    secondaryCredentials: { accessToken: '', refreshToken: '   ' },
  });
  try {
    const state = await fixture.service.claudeState();
    assert.equal(state.accounts.find((account) => account.id === 'secondary')?.status, 'not_configured');

    await assert.rejects(
      () => fixture.service.selectClaudeAccount('secondary'),
      (error) => error instanceof ProviderAccountError
        && error.statusCode === 409
        && /is not authenticated/.test(error.message),
    );
    assert.equal(fixture.writeCount(), 0);
    assert.deepEqual(fixture.restarted, []);
  } finally {
    await fixture.cleanup();
  }
});

test('a failed runtime reload is visible and retrying the selected account only requeues failed agents', async () => {
  const fixture = await accountServiceFixture({ active: false, reloadFailures: 1 });
  try {
    const failed = await fixture.service.selectClaudeAccount('secondary');

    assert.equal(failed.status, 'error');
    assert.deepEqual(failed.errorAgentIds, ['iris']);
    assert.deepEqual(fixture.restarted, ['iris']);

    const retried = await fixture.service.selectClaudeAccount('secondary');

    assert.equal(retried.status, 'switching');
    assert.deepEqual(retried.pendingAgentIds, ['iris']);
    assert.deepEqual(fixture.restarted, ['iris', 'iris']);
  } finally {
    await fixture.cleanup();
  }
});

test('an interrupted switch intent fails visibly and can requeue its missing runtime command', async () => {
  const fixture = await accountServiceFixture({ active: false });
  try {
    fixture.setInterruptedSwitch();

    const interrupted = await fixture.service.claudeState();
    assert.equal(interrupted.status, 'error');
    assert.deepEqual(interrupted.errorAgentIds, ['iris']);

    const retried = await fixture.service.selectClaudeAccount('secondary');
    assert.equal(retried.status, 'switching');
    assert.deepEqual(fixture.restarted, ['iris']);
  } finally {
    await fixture.cleanup();
  }
});

test('a recovered idle reload completes the switch without rotating the agent session', async () => {
  const fixture = await accountServiceFixture({ active: false });
  try {
    await fixture.service.selectClaudeAccount('secondary');
    fixture.setRestartOutcome('recovered');

    const recovered = await fixture.service.claudeState();
    assert.equal(recovered.status, 'active');
    assert.deepEqual(recovered.pendingAgentIds, []);
    const writes = fixture.writeCount();

    const unchanged = await fixture.service.selectClaudeAccount('secondary');
    assert.equal(unchanged.status, 'active');
    assert.equal(fixture.writeCount(), writes);
    assert.deepEqual(fixture.restarted, ['iris']);
  } finally {
    await fixture.cleanup();
  }
});

test('a newer operator restart can complete an in-progress account switch', async () => {
  const fixture = await accountServiceFixture({ active: false });
  try {
    await fixture.service.selectClaudeAccount('secondary');
    fixture.setSupersedingRestartOutcome('recovered');

    const recovered = await fixture.service.claudeState();
    assert.equal(recovered.status, 'active');
    assert.deepEqual(recovered.pendingAgentIds, []);
  } finally {
    await fixture.cleanup();
  }
});

test('an agent that left Claude Code no longer blocks an in-progress account switch', async () => {
  const fixture = await accountServiceFixture({ active: false, agentIds: ['iris', 'nico'] });
  try {
    const switching = await fixture.service.selectClaudeAccount('secondary');
    assert.equal(switching.status, 'switching');
    assert.deepEqual(switching.pendingAgentIds, ['iris', 'nico']);

    fixture.replaceAgent(kimiAgent('nico'));

    const state = await fixture.service.claudeState();
    assert.equal(state.status, 'switching');
    assert.deepEqual(state.errorAgentIds, []);
    assert.deepEqual(state.pendingAgentIds, ['iris']);
  } finally {
    await fixture.cleanup();
  }
});

test('a lost restart outcome does not strand a completed account switch', async () => {
  const fixture = await accountServiceFixture({ active: false });
  try {
    // The agent is on its pre-switch worker when the reload is requested.
    fixture.setHealth(healthyWorkerHealth('worker-before-switch'));
    await fixture.service.selectClaudeAccount('secondary');
    assert.equal(fixture.config().claudeCode?.switch?.restarts[0]?.workerId, 'worker-before-switch');

    // The reload happened, but its outcome was recorded failed and later
    // dropped from the health record — the exact 2026-07-18 incident. The
    // replacement worker is the proof the agent runs the target account.
    fixture.setHealth(healthyWorkerHealth('worker-after-reload'));

    const state = await fixture.service.claudeState();
    assert.equal(state.status, 'active');
    assert.deepEqual(state.errorAgentIds, []);
    assert.deepEqual(state.pendingAgentIds, []);
  } finally {
    await fixture.cleanup();
  }
});

test('a fresh provider child on the same pre-switch worker does not prove the switch landed', async () => {
  const fixture = await accountServiceFixture({ active: false });
  try {
    fixture.setHealth(healthyWorkerHealth('worker-before-switch'));
    await fixture.service.selectClaudeAccount('secondary');

    // Milo's gate control on 6240111b: the controller child respawned inside
    // the SAME pre-switch worker — it inherits the old account env, so the
    // switch is still in flight even with a healthy post-switch child.
    fixture.setHealth(healthyWorkerHealth('worker-before-switch', new Date().toISOString()));

    const state = await fixture.service.claudeState();
    assert.equal(state.status, 'switching');
    assert.deepEqual(state.errorAgentIds, []);
    assert.deepEqual(state.pendingAgentIds, ['iris']);
  } finally {
    await fixture.cleanup();
  }
});

test('a healthy agent without worker evidence still waits out the switch', async () => {
  const fixture = await accountServiceFixture({ active: false });
  try {
    fixture.setHealth(healthyWorkerHealth('worker-before-switch'));
    await fixture.service.selectClaudeAccount('secondary');

    // No worker identity in the health record: nothing to reconcile against.
    fixture.setHealth({ state: 'healthy', updatedAt: new Date().toISOString() });
    const noWorker = await fixture.service.claudeState();
    assert.equal(noWorker.status, 'switching');
    assert.deepEqual(noWorker.pendingAgentIds, ['iris']);

    // An unhealthy replacement worker: convergence claims wait for healthy.
    fixture.setHealth({ ...healthyWorkerHealth('worker-after-reload'), state: 'unhealthy' });
    const unhealthy = await fixture.service.claudeState();
    assert.equal(unhealthy.status, 'switching');
    assert.deepEqual(unhealthy.pendingAgentIds, ['iris']);
  } finally {
    await fixture.cleanup();
  }
});

test('a pre-persist worker replacement does not count as the switch landing', async () => {
  const fixture = await accountServiceFixture({
    active: false,
    onSwitchPersist: () => {
      // Milo's re-gate race on a573ffd4: an unrelated reconcile swaps
      // old-account worker A for old-account worker B between the entry
      // status read and the registry persist. The baseline must be read
      // after the write, so B becomes the recorded baseline — and since the
      // current worker still IS B, nothing may read as converged. (The
      // closure runs during select, after `fixture` is assigned.)
      fixture.setHealth(healthyWorkerHealth('worker-b-unrelated', new Date().toISOString()));
    },
  });
  try {
    fixture.setHealth(healthyWorkerHealth('worker-a-old'));
    await fixture.service.selectClaudeAccount('secondary');
    assert.equal(fixture.config().claudeCode?.switch?.restarts[0]?.workerId, 'worker-b-unrelated');

    const state = await fixture.service.claudeState();
    assert.equal(state.status, 'switching');
    assert.deepEqual(state.errorAgentIds, []);
    assert.deepEqual(state.pendingAgentIds, ['iris']);
  } finally {
    await fixture.cleanup();
  }
});

test('selecting the active account mid-switch requeues agents whose outcomes never landed', async () => {
  const fixture = await accountServiceFixture({ active: false });
  try {
    await fixture.service.selectClaudeAccount('secondary');
    assert.equal(fixture.restarted.length, 1);

    // The outcome never landed: the switch reads 'switching', and
    // re-selecting the same account requeues the reload — the operator exit
    // from the 2026-07-18 stuck canary state.
    const retried = await fixture.service.selectClaudeAccount('secondary');
    assert.equal(retried.status, 'switching');
    assert.deepEqual(retried.pendingAgentIds, ['iris']);
    assert.deepEqual(fixture.restarted, ['iris', 'iris']);

    fixture.setRestartOutcome('recovered');
    const recovered = await fixture.service.claudeState();
    assert.equal(recovered.status, 'active');
    assert.deepEqual(recovered.pendingAgentIds, []);
  } finally {
    await fixture.cleanup();
  }
});

function healthyWorkerHealth(workerId: string, childStartedAt?: string): NonNullable<AgentStatusSummary['health']> {
  return {
    runtime: {
      ...(childStartedAt
        ? {
            providerChild: {
              alive: true,
              command: 'claude',
              exited: false,
              label: 'claude-code',
              startedAt: childStartedAt,
              stdinWritable: true,
            },
          }
        : {}),
      providerChildExpected: true,
      workerId,
    },
    state: 'healthy',
    updatedAt: new Date().toISOString(),
  };
}

function kimiAgent(id: string): AgentConfig {
  const agent = claudeAgent(id);
  return {
    ...agent,
    provider: {
      kind: 'kimi-cli',
      model: agent.provider.model,
    },
  };
}

async function accountServiceFixture(input: {
  active: boolean;
  configured?: boolean;
  continuityNeedsSetup?: boolean;
  mcpFailure?: boolean;
  queued?: boolean;
  reloadGate?: Promise<void>;
  reloadStarted?: () => void;
  reloadFailures?: number;
  secondaryAuthenticated?: boolean;
  secondaryCredentials?: { accessToken?: string; refreshToken?: string };
  agentIds?: string[];
  onSwitchPersist?: () => void;
}) {
  const root = await mkdtemp(join(tmpdir(), 'anima-provider-account-service-'));
  const primaryDir = join(root, 'primary');
  const secondaryDir = join(root, 'secondary');
  await mkdir(primaryDir, { recursive: true });
  await mkdir(secondaryDir, { recursive: true });
  await writeFile(join(primaryDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'one@example.com' } }));
  if (input.secondaryAuthenticated !== false) {
    await writeFile(join(secondaryDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'two@example.com' } }));
  }
  await writeFile(join(primaryDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'primary-token' } }));
  if (input.secondaryAuthenticated !== false) {
    await writeFile(
      join(secondaryDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: input.secondaryCredentials ?? { accessToken: 'secondary-token' } }),
    );
  }

  let config: ProviderAccountsConfig = input.configured === false ? {} : {
    claudeCode: {
      accounts: [
        { configDir: primaryDir, id: 'primary', label: 'Primary' },
        { configDir: secondaryDir, id: 'secondary', label: 'Secondary' },
      ],
      activeAccountId: 'primary',
    },
  };
  let writes = 0;
  const restarted: string[] = [];
  let restartAttempts = 0;
  let reloadFailures = input.reloadFailures ?? 0;
  let ensureContinuityCalls = 0;
  const mcpSynchronizations: string[][] = [];
  let agentConfigs = (input.agentIds ?? ['iris']).map((id) =>
    claudeAgent(id, input.configured === false ? secondaryDir : primaryDir));
  const statuses: AgentStatusSummary[] = [{
    agentId: 'iris',
    ...(input.active ? { currentItemId: 'item-1' } : {}),
    queueDepth: input.queued ? 1 : 0,
    itemCount: input.active || input.queued ? 1 : 0,
  }];
  const service = new ProviderAccountService(
    {
      async getProviderAccounts() { return config; },
      async setProviderAccounts(next) {
        // Hook for timing-control tests: fires when a switch record is being
        // persisted, i.e. between the entry status read and the post-write
        // baseline read.
        if (next.claudeCode?.switch) input.onSwitchPersist?.();
        config = next;
        writes += 1;
        return next;
      },
    },
    {
      async listAgentConfigs() {
        return agentConfigs;
      },
    },
    {
      async listStatuses() {
        // Production computes fresh status objects per call; a shared array
        // would leak mid-flight mutations into the entry snapshot and hide
        // the pre-persist race the timing control exists to expose.
        return structuredClone(statuses);
      },
      async reloadAgentWhenIdle(agentId) {
        restarted.push(agentId);
        restartAttempts += 1;
        input.reloadStarted?.();
        await input.reloadGate;
        if (reloadFailures > 0) {
          reloadFailures -= 1;
          throw new Error('restart queue unavailable');
        }
        return { requestId: `restart-${agentId}-${restartAttempts}` };
      },
    },
    async (accounts) => { ensureContinuityCalls += accounts.length; },
    async () => [],
    async () => input.continuityNeedsSetup ?? false,
    async (source, target) => {
      mcpSynchronizations.push([source.id, target.id]);
      if (input.mcpFailure) throw new ClaudeAccountContinuityError('MCP metadata conflict');
    },
  );

  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    config: () => config,
    ensureContinuityCalls: () => ensureContinuityCalls,
    mcpSynchronizations: () => mcpSynchronizations,
    replaceAgent(agent: AgentConfig) {
      agentConfigs = agentConfigs.map((current) => (current.id === agent.id ? agent : current));
    },
    restarted,
    setHealth(health: NonNullable<AgentStatusSummary['health']>) {
      const status = statuses[0];
      if (!status) throw new Error('missing fixture status');
      statuses[0] = { ...status, health };
    },
    setInterruptedSwitch() {
      const registry = config.claudeCode;
      if (!registry) throw new Error('missing fixture registry');
      config = {
        claudeCode: {
          ...registry,
          activeAccountId: 'secondary',
          switch: {
            accountId: 'secondary',
            agentIds: ['iris'],
            failedAgentIds: [],
            requestedAt: '2026-07-17T00:00:00.000Z',
            restarts: [],
          },
        },
      };
    },
    setRestartOutcome(outcome: 'failed' | 'recovered') {
      const status = statuses[0];
      if (!status) throw new Error('missing fixture status');
      statuses[0] = {
        ...status,
        health: {
          restart: {
            completedAt: '2026-07-17T00:00:01.000Z',
            outcome,
            requestId: `restart-iris-${restartAttempts}`,
            requestedAt: '2026-07-17T00:00:00.000Z',
          },
          state: outcome === 'failed' ? 'unhealthy' : 'healthy',
          updatedAt: '2026-07-17T00:00:01.000Z',
        },
      };
    },
    setSupersedingRestartOutcome(outcome: 'failed' | 'recovered') {
      const status = statuses[0];
      if (!status) throw new Error('missing fixture status');
      statuses[0] = {
        ...status,
        health: {
          restart: {
            completedAt: '2099-07-17T00:00:01.000Z',
            outcome,
            requestId: 'operator-restart-after-account-switch',
            requestedAt: '2099-07-17T00:00:00.000Z',
          },
          state: outcome === 'failed' ? 'unhealthy' : 'healthy',
          updatedAt: '2099-07-17T00:00:01.000Z',
        },
      };
    },
    service,
    writeCount: () => writes,
  };
}

function claudeAgent(id: string, configDir?: string): AgentConfig {
  return {
    createdAt: '2026-07-17T00:00:00.000Z',
    enabled: true,
    feishu: {
      appId: '',
      appSecret: '',
      connected: false,
      encryptKey: '',
      verificationToken: '',
    },
    homePath: `/agents/${id}`,
    id,
    profile: { displayName: id, role: 'Engineer' },
    provider: {
      ...(configDir ? { env: { CLAUDE_CONFIG_DIR: configDir } } : {}),
      kind: 'claude-code',
      model: 'opus',
      transport: 'stream-json',
    },
    slack: {
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      connected: true,
      manifestVersion: 0,
      teamId: 'T1',
      workspaceIconUrl: '',
      workspaceName: 'Test',
    },
    teamId: 'default',
  };
}
