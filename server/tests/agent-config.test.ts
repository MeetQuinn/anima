import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { redactAgentConfig } from '../agents/agent-config-ops.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { defaultTeamService } from '../teams/team.service.js';
import { KbRegistryStore, KbStore } from '../storage/schema/kb.store.js';
import type { ServerConfig } from '../storage/schema/server.store.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import { withAnimaHome } from './anima-home.js';

type TestAgentConfig = Omit<Partial<AgentConfig>, 'profile' | 'slack'> & {
  id: string;
  profile?: Partial<AgentConfig['profile']> & { description?: string };
  slack?: Partial<AgentConfig['slack']>;
};
type TestConfig = ServerConfig & { agents: TestAgentConfig[] };

const agentService = (agentId: string) => defaultAgentRegistryService.serviceFor(agentId);
const kbRegistry = () => new KbRegistryStore();
const kbStore = (id: string) => new KbStore(id);

test('agent config update writes editable fields and UI redacts secrets', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-profile-test-'));
  try {
    await writeConfig(configDir, {
      agents: [
        {
          id: 'milo',
          homePath: 'agents/milo',
          profile: {
            description: 'Profile description',
            displayName: 'Profile Name',
          },
          provider: {
            env: {
              SECRET_NAME: 'secret-value',
            },
            kind: 'codex-cli',
            model: 'old-model',
          },
          slack: {
            botToken: 'xoxb-secret',
          },
        },
      ],
    });

    await withAnimaHome(configDir, async () => {
      const milo = agentService('milo');
      const before = redactAgentConfig(await milo.getConfig());
      assert.equal(before.profile?.displayName, 'Profile Name');
      assert.equal(before.profile?.role, 'Profile description');
      assert.deepEqual(Object.keys(before.provider?.env ?? {}), ['SECRET_NAME']);
      assert.equal(before.provider?.env?.['SECRET_NAME'], '');
      assert.equal(before.slack?.botToken, '');
      assert.equal(JSON.stringify(before).includes('secret-value'), false);
      assert.equal(JSON.stringify(before).includes('xoxb-secret'), false);

      await milo.updateProvider({ model: 'gpt-5.4' });
      const updated = await milo.updateProfile({ displayName: 'New Name', role: 'New role' });

      assert.equal(updated.profile?.displayName, 'New Name');
      assert.equal(updated.provider?.model, 'gpt-5.4');

      const agent = await readRawAgentFile(configDir, 'milo');
      assert.equal(agent.profile?.displayName, 'New Name');
      assert.equal(agent.profile?.role, 'New role');
      assert.equal('description' in (agent.profile ?? {}), false);
      assert.equal(agent.provider?.model, 'gpt-5.4');
      assert.equal('runtime' in agent, false);
      assert.equal(agent.homePath, 'agents/milo');
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('agent store lists and gets agent configs', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-profile-test-'));
  try {
    await writeConfig(configDir, {
      agents: [
        {
          id: 'milo',
          profile: {
            displayName: 'Milo',
          },
          provider: {
            kind: 'codex-cli',
          },
        },
      ],
    });

    await withAnimaHome(configDir, async () => {
      const agents = await defaultAgentRegistryService.listAgentConfigs();
      assert.equal(agents[0]?.profile?.displayName, 'Milo');
      assert.equal(agents[0]?.id, 'milo');

      const agent = await agentService('milo').getConfig();
      assert.equal(agent.profile?.displayName, 'Milo');
      await assert.rejects(agentService('missing').getConfig(), /Agent not found in config: missing/);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('creating default-home agents registers the team kb once', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-agent-kb-config-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-agent-kb-home-'));
  const customHome = await mkdtemp(join(tmpdir(), 'anima-agent-custom-home-'));
  try {
    await withProcessHome(homeDir, async () => {
      await withAnimaHome(configDir, async () => {
        const teamRoot = join(homeDir, 'anima-team');

        await defaultAgentRegistryService.createAgent({
          name: 'First Agent',
          homePath: '~/anima-team/agents/first-agent',
          role: 'First default-home agent.',
          provider: { kind: 'claude-code', model: 'opus' },
        });

        assert.equal((await stat(join(teamRoot, 'agents', 'first-agent'))).isDirectory(), true);
        assert.deepEqual(await kbRegistry().list(), [{ id: 'team', label: 'Team', path: teamRoot, teamId: 'default' }]);

        await defaultAgentRegistryService.createAgent({
          name: 'Second Agent',
          homePath: '~/anima-team/agents/second-agent',
          role: 'Second default-home agent.',
          provider: { kind: 'claude-code', model: 'opus' },
        });
        assert.deepEqual(await kbRegistry().list(), [{ id: 'team', label: 'Team', path: teamRoot, teamId: 'default' }]);

        await defaultAgentRegistryService.createAgent({
          name: 'Custom Agent',
          homePath: customHome,
          role: 'Custom-home agent.',
          provider: { kind: 'claude-code', model: 'opus' },
        });
        assert.deepEqual(await kbRegistry().list(), [{ id: 'team', label: 'Team', path: teamRoot, teamId: 'default' }]);
      });
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(customHome, { force: true, recursive: true });
  }
});

test('team kb registration avoids id collisions without clobbering existing roots', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-agent-kb-collision-config-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-agent-kb-collision-home-'));
  const otherRoot = await mkdtemp(join(tmpdir(), 'anima-agent-kb-other-root-'));
  try {
    await withProcessHome(homeDir, async () => {
      await withAnimaHome(configDir, async () => {
        const teamRoot = join(homeDir, 'anima-team');
        await kbStore('team').write({ id: 'team', label: 'Other Team', path: otherRoot, teamId: 'default' });

        await defaultAgentRegistryService.createAgent({
          name: 'Default Agent',
          homePath: '~/anima-team/agents/default-agent',
          role: 'Default-home agent.',
          provider: { kind: 'claude-code', model: 'opus' },
        });

        assert.deepEqual(await kbRegistry().list(), [
          { id: 'team', label: 'Other Team', path: otherRoot, teamId: 'default' },
          { id: 'team-2', label: 'Team', path: teamRoot, teamId: 'default' },
        ]);
      });
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(otherRoot, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Team as a first-class attribute (cut-1)
// ---------------------------------------------------------------------------

test('empty config loads as {} and the registry synthesizes exactly the default team', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-empty-'));
  try {
    await withAnimaHome(configDir, async () => {
      assert.deepEqual(await defaultServerSettingsService.readConfig(), {});
      assert.deepEqual(await defaultServerSettingsService.getTeams(), []);
      assert.deepEqual(await defaultTeamService.listTeams(), [
        { id: 'default', name: 'Default', home: '~/anima-team' },
      ]);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('a legacy agent config with no team field backfills to the default team on read', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-backfill-'));
  try {
    await writeConfig(configDir, {
      agents: [
        {
          id: 'legacy',
          homePath: 'agents/legacy',
          profile: { displayName: 'Legacy' },
          provider: { kind: 'claude-code', model: 'opus' },
        },
      ],
    });
    await withAnimaHome(configDir, async () => {
      const agent = await agentService('legacy').getConfig();
      assert.equal(agent.teamId, 'default');
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('a blank teamId also backfills to the default team', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-blank-'));
  try {
    await writeConfig(configDir, {
      agents: [
        {
          id: 'blank',
          homePath: 'agents/blank',
          teamId: '   ',
          profile: { displayName: 'Blank' },
          provider: { kind: 'claude-code', model: 'opus' },
        },
      ],
    });
    await withAnimaHome(configDir, async () => {
      const agent = await agentService('blank').getConfig();
      assert.equal(agent.teamId, 'default');
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('a dangling teamId is preserved on read but degrades to default via the service (no crash)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-dangling-'));
  try {
    await writeConfig(configDir, {
      agents: [
        {
          id: 'orphan',
          homePath: 'agents/orphan',
          teamId: 'ghost',
          profile: { displayName: 'Orphan' },
          provider: { kind: 'claude-code', model: 'opus' },
        },
      ],
    });
    await withAnimaHome(configDir, async () => {
      // The shared schema cannot see the registry, so it preserves the raw value.
      const agent = await agentService('orphan').getConfig();
      assert.equal(agent.teamId, 'ghost');
      // The service is the degrade authority: unknown team -> default + repairable warning.
      const resolved = await defaultTeamService.resolveEffectiveTeamId(agent.teamId);
      assert.equal(resolved.teamId, 'default');
      assert.ok(resolved.warning && resolved.warning.includes('ghost'));
      // The phantom team never appears in the registry.
      assert.deepEqual((await defaultTeamService.listTeams()).map((t) => t.id), ['default']);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('collectAgentTeamWarnings surfaces exactly the dangling teamIds (the repairable-warning half of the contract)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-warn-'));
  try {
    await withAnimaHome(configDir, async () => {
      const content = await defaultTeamService.createTeam({ name: 'Content' });
      const warnings = await defaultTeamService.collectAgentTeamWarnings([
        { id: 'alice', teamId: 'ghost' }, // dangling -> warn
        { id: 'bob', teamId: content.id }, // valid non-default -> no warn
        { id: 'cara', teamId: 'default' }, // default -> no warn
        { id: 'dan', teamId: '' }, // blank legacy -> no warn
        { id: 'evan' }, // absent -> no warn
      ]);
      assert.equal(warnings.length, 1);
      const [warning] = warnings;
      if (!warning) throw new Error('expected exactly one warning');
      assert.equal(warning.agentId, 'alice');
      assert.equal(warning.teamId, 'ghost');
      assert.equal(warning.effectiveTeamId, 'default');
      assert.ok(warning.message.includes('ghost'));
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('createTeam slugs the name, materializes the default alongside it, and rejects collisions', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-create-'));
  try {
    await withAnimaHome(configDir, async () => {
      const team = await defaultTeamService.createTeam({ name: 'Content Squad' });
      assert.deepEqual(team, { id: 'content-squad', name: 'Content Squad', home: '~/content-squad' });

      assert.deepEqual(
        (await defaultTeamService.listTeams()).map((t) => t.id),
        ['default', 'content-squad'],
      );
      // Persisted registry is now explicit (default graduated in on the first extra team).
      assert.deepEqual(
        (await defaultServerSettingsService.getTeams()).map((t) => t.id),
        ['default', 'content-squad'],
      );

      await assert.rejects(defaultTeamService.createTeam({ name: 'Content Squad' }), /already exists/);
      await assert.rejects(defaultTeamService.createTeam({ name: 'Default' }), /reserved/);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('creating an agent in a team derives $TEAM_HOME/agents/$id and records the teamId', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-agent-config-'));
  const teamHome = await mkdtemp(join(tmpdir(), 'anima-team-agent-home-'));
  try {
    await withAnimaHome(configDir, async () => {
      const team = await defaultTeamService.createTeam({ name: 'Content', home: teamHome });
      const agent = await defaultAgentRegistryService.createAgent({
        name: 'Bee',
        role: 'Writer.',
        provider: { kind: 'claude-code', model: 'opus' },
        teamId: team.id,
      });
      assert.equal(agent.teamId, 'content');
      assert.equal(agent.homePath, join(teamHome, 'agents', 'bee'));
      assert.equal((await stat(join(teamHome, 'agents', 'bee'))).isDirectory(), true);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(teamHome, { force: true, recursive: true });
  }
});

test('creating an agent with an unknown teamId is rejected (400, not a silent degrade)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-agent-unknown-'));
  try {
    await withAnimaHome(configDir, async () => {
      await assert.rejects(
        defaultAgentRegistryService.createAgent({
          name: 'Ghost',
          role: 'x.',
          provider: { kind: 'claude-code', model: 'opus' },
          teamId: 'nope',
        }),
        /unknown team: nope/,
      );
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('assignTeam relabels an agent without moving its existing home', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-assign-config-'));
  const agentHome = await mkdtemp(join(tmpdir(), 'anima-team-assign-home-'));
  const teamHome = await mkdtemp(join(tmpdir(), 'anima-team-assign-teamhome-'));
  try {
    await withAnimaHome(configDir, async () => {
      const created = await defaultAgentRegistryService.createAgent({
        name: 'Ann',
        homePath: agentHome,
        role: 'x.',
        provider: { kind: 'claude-code', model: 'opus' },
      });
      assert.equal(created.teamId, 'default');

      await defaultTeamService.createTeam({ name: 'Ops', home: teamHome });
      const moved = await defaultAgentRegistryService.assignTeam('ann', 'ops');
      assert.equal(moved.teamId, 'ops');
      // Home is a migration-time label change only: the path never moves.
      assert.equal(moved.homePath, created.homePath);

      await assert.rejects(defaultAgentRegistryService.assignTeam('ann', 'nope'), /unknown team: nope/);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(agentHome, { force: true, recursive: true });
    await rm(teamHome, { force: true, recursive: true });
  }
});

test('legacy operator field is migrated to owner on read, persisted as owner on write', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-owner-backcompat-'));
  try {
    // Simulate a real legacy agent config as it exists on the 9 live agents —
    // the `operator` field, not `owner`.
    await mkdir(join(configDir, 'agents', 'aria'), { recursive: true });
    await writeFile(
      join(configDir, 'agents', 'aria', 'config.json'),
      JSON.stringify({
        id: 'aria',
        homePath: 'agents/aria',
        profile: { displayName: 'Aria', role: 'Test agent' },
        provider: { kind: 'claude-code', model: 'sonnet' },
        operator: {
          slackUserId: 'UFAKEUSER1',
          displayName: 'Test User',
          handle: 'testuser',
          avatarUrl: 'https://example.com/avatar.png',
          onboardingPromptedAt: '2026-05-01T10:00:00.000Z',
        },
      }, null, 2),
      'utf8',
    );

    await withAnimaHome(configDir, async () => {
      const aria = agentService('aria');

      // 1. Read: legacy `operator` must surface as `owner`, no `operator` key.
      const config = await aria.getConfig();
      assert.ok(config.owner, 'owner field must be present after migrate-on-read');
      assert.equal(config.owner?.slackUserId, 'UFAKEUSER1');
      assert.equal(config.owner?.displayName, 'Test User');
      assert.equal(config.owner?.handle, 'testuser');
      assert.equal(config.owner?.onboardingPromptedAt, '2026-05-01T10:00:00.000Z');
      assert.equal('operator' in config, false, 'operator must not be present in resolved config');

      // 2. Write: after any save the persisted file must have `owner`, not `operator`.
      await aria.updateProfile({ displayName: 'Aria Updated' });
      const raw = JSON.parse(
        await readFile(join(configDir, 'agents', 'aria', 'config.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.ok('owner' in raw, 'persisted config must have owner field');
      assert.equal('operator' in raw, false, 'persisted config must not have legacy operator field');
      const rawOwner = raw.owner as Record<string, unknown>;
      assert.equal(rawOwner['slackUserId'], 'UFAKEUSER1');
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

async function writeConfig(configDir: string, config: TestConfig): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'config.json'),
    `${JSON.stringify(config.dashboardPort === undefined ? {} : { dashboardPort: config.dashboardPort }, null, 2)}\n`,
    'utf8',
  );
  for (const agent of config.agents) {
    const agentDir = join(configDir, 'agents', agent.id);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'config.json'), `${JSON.stringify(agent, null, 2)}\n`, 'utf8');
  }
}

async function readRawAgentFile(configDir: string, agentId: string): Promise<TestAgentConfig> {
  return JSON.parse(await readFile(join(configDir, 'agents', agentId, 'config.json'), 'utf8')) as TestAgentConfig;
}

async function withProcessHome<T>(homeDir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previous;
    }
  }
}
