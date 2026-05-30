import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { redactAgentConfig } from '../agents/agent-config-ops.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
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
        assert.deepEqual(await kbRegistry().list(), [{ id: 'team', label: 'Team', path: teamRoot }]);

        await defaultAgentRegistryService.createAgent({
          name: 'Second Agent',
          homePath: '~/anima-team/agents/second-agent',
          role: 'Second default-home agent.',
          provider: { kind: 'claude-code', model: 'opus' },
        });
        assert.deepEqual(await kbRegistry().list(), [{ id: 'team', label: 'Team', path: teamRoot }]);

        await defaultAgentRegistryService.createAgent({
          name: 'Custom Agent',
          homePath: customHome,
          role: 'Custom-home agent.',
          provider: { kind: 'claude-code', model: 'opus' },
        });
        assert.deepEqual(await kbRegistry().list(), [{ id: 'team', label: 'Team', path: teamRoot }]);
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
        await kbStore('team').write({ id: 'team', label: 'Other Team', path: otherRoot });

        await defaultAgentRegistryService.createAgent({
          name: 'Default Agent',
          homePath: '~/anima-team/agents/default-agent',
          role: 'Default-home agent.',
          provider: { kind: 'claude-code', model: 'opus' },
        });

        assert.deepEqual(await kbRegistry().list(), [
          { id: 'team', label: 'Other Team', path: otherRoot },
          { id: 'team-2', label: 'Team', path: teamRoot },
        ]);
      });
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(homeDir, { force: true, recursive: true });
    await rm(otherRoot, { force: true, recursive: true });
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
