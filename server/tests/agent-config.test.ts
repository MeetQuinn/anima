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
              CLAUDE_CONFIG_DIR: '/profiles/legacy-secondary',
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
      assert.equal(JSON.stringify(before).includes('CLAUDE_CONFIG_DIR'), false);

      await milo.updateProvider({ model: 'gpt-5.6-luna' });
      const updated = await milo.updateProfile({ displayName: 'New Name', role: 'New role' });

      assert.equal(updated.profile?.displayName, 'New Name');
      assert.equal(updated.provider?.model, 'gpt-5.6-luna');

      const agent = await readRawAgentFile(configDir, 'milo');
      assert.equal(agent.profile?.displayName, 'New Name');
      assert.equal(agent.profile?.role, 'New role');
      assert.equal('description' in (agent.profile ?? {}), false);
      assert.equal(agent.provider?.model, 'gpt-5.6-luna');
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

test('updateTeam renames + changes home with a stable id, and guards empty/unknown/clashing names', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-update-'));
  try {
    await withAnimaHome(configDir, async () => {
      const created = await defaultTeamService.createTeam({ name: 'Content Squad', home: '~/content' });
      assert.equal(created.id, 'content-squad');

      // Rename + new home: id stays stable (never regenerated from the new name).
      const renamed = await defaultTeamService.updateTeam('content-squad', {
        name: 'Editorial',
        home: '~/editorial',
      });
      assert.deepEqual(renamed, { id: 'content-squad', name: 'Editorial', home: '~/editorial' });
      assert.deepEqual(
        (await defaultServerSettingsService.getTeams()).find((t) => t.id === 'content-squad'),
        { id: 'content-squad', name: 'Editorial', home: '~/editorial' },
      );

      // Partial patch: name only leaves home untouched, and vice versa.
      const nameOnly = await defaultTeamService.updateTeam('content-squad', { name: 'Docs' });
      assert.deepEqual(nameOnly, { id: 'content-squad', name: 'Docs', home: '~/editorial' });
      const homeOnly = await defaultTeamService.updateTeam('content-squad', { home: '~/docs' });
      assert.deepEqual(homeOnly, { id: 'content-squad', name: 'Docs', home: '~/docs' });

      // Guards.
      await assert.rejects(defaultTeamService.updateTeam('nope', { name: 'X' }), /unknown team: nope/);
      await assert.rejects(defaultTeamService.updateTeam('content-squad', { name: '   ' }), /must not be empty/);
      await assert.rejects(defaultTeamService.updateTeam('content-squad', { name: 'Default' }), /already exists/);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('updateTeam can rename the default team (materializing it) without touching member agents', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-team-update-default-'));
  const agentHome = await mkdtemp(join(tmpdir(), 'anima-team-update-default-home-'));
  try {
    await withAnimaHome(configDir, async () => {
      const agent = await defaultAgentRegistryService.createAgent({
        name: 'Deb',
        homePath: agentHome,
        role: 'x.',
        provider: { kind: 'claude-code', model: 'opus' },
      });
      assert.equal(agent.teamId, 'default');

      const renamed = await defaultTeamService.updateTeam('default', { name: 'HQ' });
      assert.deepEqual({ id: renamed.id, name: renamed.name }, { id: 'default', name: 'HQ' });
      // Default graduated into the persisted registry, id unchanged.
      assert.deepEqual(
        (await defaultServerSettingsService.getTeams()).map((t) => ({ id: t.id, name: t.name })),
        [{ id: 'default', name: 'HQ' }],
      );

      // The member agent is untouched: same teamId, same home.
      const reread = (await defaultAgentRegistryService.listAgentConfigs()).find((a) => a.id === 'deb');
      assert.equal(reread?.teamId, 'default');
      assert.equal(reread?.homePath, agent.homePath);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(agentHome, { force: true, recursive: true });
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

// Task #183: agent-level launch overrides (runtimeCommand/runtimeArgs) on the
// provider config. Semantics mirror AgentProviderUpdateRequest: undefined
// keeps, null clears (inherit machine-wide Providers settings), a value
// replaces wholesale; a kind change drops overrides written for the old CLI.
test('agent provider runtime overrides: set, keep, clear, and drop on kind change', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-runtime-override-'));
  try {
    await writeConfig(configDir, {
      agents: [
        {
          id: 'milo',
          homePath: 'agents/milo',
          // Catalog-valid model: updateProvider re-validates the current
          // selection on every save, even override-only ones.
          provider: { kind: 'codex-cli', model: 'gpt-5.6-sol' },
        },
      ],
    });

    await withAnimaHome(configDir, async () => {
      const milo = agentService('milo');

      // Set: both overrides persist to the raw file and survive redaction
      // (the Profile UI needs them to render the Runtime rows).
      const set = await milo.updateProvider({
        runtimeCommand: '/bin/echo',
        runtimeArgs: ['--flag', 'value with spaces'],
      });
      assert.equal(set.provider.runtimeCommand, '/bin/echo');
      assert.deepEqual(set.provider.runtimeArgs, ['--flag', 'value with spaces']);
      let raw = await readRawAgentFile(configDir, 'milo');
      assert.equal(raw.provider?.runtimeCommand, '/bin/echo');
      assert.deepEqual(raw.provider?.runtimeArgs, ['--flag', 'value with spaces']);
      const redacted = redactAgentConfig(set);
      assert.equal(redacted.provider?.runtimeCommand, '/bin/echo');
      assert.deepEqual(redacted.provider?.runtimeArgs, ['--flag', 'value with spaces']);

      // Keep: an unrelated update (undefined overrides) leaves both in place.
      const kept = await milo.updateProvider({ model: 'gpt-5.6-luna' });
      assert.equal(kept.provider.runtimeCommand, '/bin/echo');
      assert.deepEqual(kept.provider.runtimeArgs, ['--flag', 'value with spaces']);

      // Clear one: null deletes runtimeArgs (inherit machine-wide), command stays.
      const cleared = await milo.updateProvider({ runtimeArgs: null });
      assert.equal(cleared.provider.runtimeCommand, '/bin/echo');
      assert.equal('runtimeArgs' in cleared.provider, false);
      raw = await readRawAgentFile(configDir, 'milo');
      assert.equal('runtimeArgs' in (raw.provider ?? {}), false);

      // Kind change: the override written for the old provider's CLI does not
      // transfer; only values the update itself provides would apply.
      const switched = await milo.updateProvider({ kind: 'claude-code' });
      assert.equal(switched.provider.kind, 'claude-code');
      assert.equal('runtimeCommand' in switched.provider, false);
      assert.equal('runtimeArgs' in switched.provider, false);
      raw = await readRawAgentFile(configDir, 'milo');
      assert.equal('runtimeCommand' in (raw.provider ?? {}), false);

      // Kind change WITH an override in the same update applies to the new kind.
      const switchedWithOverride = await milo.updateProvider({
        kind: 'kimi-cli',
        runtimeCommand: '/bin/echo',
      });
      assert.equal(switchedWithOverride.provider.kind, 'kimi-cli');
      assert.equal(switchedWithOverride.provider.runtimeCommand, '/bin/echo');
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

test('agent fast mode opt-in persists for Claude and Codex and rejects other providers', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-provider-fast-mode-'));
  try {
    await writeConfig(configDir, {
      agents: [
        {
          id: 'milo',
          homePath: 'agents/milo',
          provider: { kind: 'claude-code', model: 'fable' },
        },
      ],
    });

    await withAnimaHome(configDir, async () => {
      const milo = agentService('milo');

      const enabled = await milo.updateProvider({ fastMode: true });
      assert.equal(enabled.provider.kind, 'claude-code');
      assert.equal(enabled.provider.fastMode, true);
      let raw = await readRawAgentFile(configDir, 'milo');
      assert.equal(raw.provider?.kind, 'claude-code');
      assert.equal(raw.provider?.fastMode, true);
      const redacted = redactAgentConfig(enabled);
      assert.equal(redacted.provider.kind, 'claude-code');
      assert.equal(redacted.provider.fastMode, true);

      const kept = await milo.updateProvider({ reasoningEffort: 'xhigh' });
      assert.equal(kept.provider.kind, 'claude-code');
      assert.equal(kept.provider.fastMode, true);

      const disabled = await milo.updateProvider({ fastMode: false });
      assert.equal(disabled.provider.kind, 'claude-code');
      assert.equal(disabled.provider.fastMode, false);

      const switched = await milo.updateProvider({ kind: 'codex-cli' });
      assert.equal(switched.provider.kind, 'codex-cli');
      assert.equal('fastMode' in switched.provider, false);
      raw = await readRawAgentFile(configDir, 'milo');
      assert.equal('fastMode' in (raw.provider ?? {}), false);

      const codexEnabled = await milo.updateProvider({ fastMode: true });
      assert.equal(codexEnabled.provider.kind, 'codex-cli');
      assert.equal(codexEnabled.provider.fastMode, true);
      raw = await readRawAgentFile(configDir, 'milo');
      if (raw.provider?.kind !== 'codex-cli') throw new Error('expected Codex provider');
      assert.equal(raw.provider.fastMode, true);
      const redactedCodex = redactAgentConfig(codexEnabled);
      if (redactedCodex.provider.kind !== 'codex-cli') throw new Error('expected Codex provider');
      assert.equal(redactedCodex.provider.fastMode, true);

      const codexDisabled = await milo.updateProvider({ fastMode: false });
      assert.equal(codexDisabled.provider.kind, 'codex-cli');
      assert.equal(codexDisabled.provider.fastMode, false);

      const unsupported = await milo.updateProvider({ kind: 'kimi-cli' });
      assert.equal(unsupported.provider.kind, 'kimi-cli');
      assert.equal('fastMode' in unsupported.provider, false);

      await assert.rejects(
        milo.updateProvider({ fastMode: true }),
        /unsupported fastMode for kimi-cli/,
      );
      assert.equal((await milo.getConfig()).provider.kind, 'kimi-cli');

      const switchedBack = await milo.updateProvider({ fastMode: true, kind: 'codex-cli' });
      assert.equal(switchedBack.provider.kind, 'codex-cli');
      assert.equal(switchedBack.provider.fastMode, true);
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
});

// Same bar as the machine-wide Providers command: a path-shaped command must
// be absolute and must resolve to an executable at save time (409), so a typo
// fails the save instead of the next launch. A rejected save changes nothing.
test('agent runtime command validation rejects relative paths and non-executables with 409', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-runtime-validate-'));
  try {
    await writeConfig(configDir, {
      agents: [
        {
          id: 'milo',
          homePath: 'agents/milo',
          provider: { kind: 'codex-cli', model: 'gpt-5.6-sol' },
        },
      ],
    });

    await withAnimaHome(configDir, async () => {
      const milo = agentService('milo');

      const rejects = async (runtimeCommand: string, why: string) => {
        await assert.rejects(
          milo.updateProvider({ runtimeCommand }),
          (error: unknown) =>
            error instanceof Error && (error as { statusCode?: number }).statusCode === 409,
          why,
        );
      };
      await rejects('relative/wrapper', 'path-shaped command must be absolute');
      await rejects('/nonexistent-anima-183-wrapper', 'command must resolve to an executable');

      // Failed saves leave the config untouched.
      const raw = await readRawAgentFile(configDir, 'milo');
      assert.equal('runtimeCommand' in (raw.provider ?? {}), false);
      assert.equal(raw.provider?.model, 'gpt-5.6-sol');
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
