import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { defaultAgentConfig, writeAgentConfigs } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { createWebServer } from '../web/app.js';
import { bearerToken, slackRequestBody, startSlackApiMock } from './helpers/slack-api.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { CURRENT_SLACK_MANIFEST_VERSION } from '../../shared/slack-manifest.js';
import { withAnimaHome } from './anima-home.js';
import { agentService, postJson, assertStatus } from './helpers/web-api.js';

test('web API validates Slack tokens with structured reasons before persisting', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-slack-validate-test-'));
  const slackApi = await startSlackApiMock((method, body, request) => {
    const token = bearerToken(request) || String(slackRequestBody(body)['token'] ?? '');
    if (method === 'apps.connections.open') {
      if (token.includes('missing-scope')) return { error: 'missing_scope', ok: false };
      return { ok: true, url: 'wss://socket.example.test/' };
    }
    if (method === 'auth.test') {
      if (token.includes('other-app')) {
        return { app_id: 'AOTHER999', ok: true, team: 'Acme', team_id: 'T-acme', user: 'other-bot', user_id: 'U-other-bot' };
      }
      return { app_id: 'ADEMO123', ok: true, team: 'Acme', team_id: 'T-acme', user: 'anima-bot', user_id: 'U-bot' };
    }
    if (method === 'users.info') {
      return { ok: true, user: { id: 'U-bot', name: 'anima-bot', profile: { display_name: 'Anima Bot', image_72: 'https://example.test/bot.png' } } };
    }
    if (method === 'team.info') {
      return { ok: true, team: { id: 'T-acme', icon: { image_132: 'https://example.test/acme.png' }, name: 'Acme' } };
    }
    throw new Error(`unexpected Slack API method ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir, [
      {
        ...defaultAgentConfig('anima'),
        slack: { appToken: '', botToken: '' },
      },
    ]);
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        const base = `http://127.0.0.1:${address.port}`;

        const wrongType = await postJson(`${base}/api/agents/anima/slack/tokens/validate`, { appToken: 'xoxb-valid-bot' });
        assert.equal(wrongType.status, 200);
        const wrongTypeBody = await wrongType.json() as { app?: { detected?: string; message?: string; reason?: string; valid?: boolean } };
        assert.equal(wrongTypeBody.app?.valid, false);
        assert.equal(wrongTypeBody.app?.detected, 'bot');
        assert.equal(wrongTypeBody.app?.reason, 'wrong_token_type');
        assert.equal(wrongTypeBody.app?.message, undefined);

        const missingScope = await postJson(`${base}/api/agents/anima/slack/tokens/validate`, { appToken: 'xapp-1-ADEMO123-missing-scope' });
        assert.equal(missingScope.status, 200);
        const missingScopeBody = await missingScope.json() as { app?: { reason?: string; valid?: boolean } };
        assert.equal(missingScopeBody.app?.valid, false);
        assert.equal(missingScopeBody.app?.reason, 'missing_connections_write');

        const botOnly = await postJson(`${base}/api/agents/anima/slack/tokens/validate`, { botToken: 'xoxb-valid-bot' });
        assert.equal(botOnly.status, 200);
        const botOnlyBody = await botOnly.json() as {
          bot?: { appId?: string; botAvatarUrl?: string; botName?: string; teamId?: string; valid?: boolean; workspaceIconUrl?: string; workspaceName?: string };
          connection?: { reason?: string; valid?: boolean };
        };
        assert.equal(botOnlyBody.bot?.valid, true);
        assert.equal(botOnlyBody.bot?.appId, 'ADEMO123');
        assert.equal(botOnlyBody.bot?.botName, 'Anima Bot');
        assert.equal(botOnlyBody.bot?.botAvatarUrl, 'https://example.test/bot.png');
        assert.equal(botOnlyBody.bot?.teamId, 'T-acme');
        assert.equal(botOnlyBody.bot?.workspaceIconUrl, 'https://example.test/acme.png');
        assert.equal(botOnlyBody.bot?.workspaceName, 'Acme');
        assert.equal(botOnlyBody.connection?.valid, false);
        assert.equal(botOnlyBody.connection?.reason, 'incomplete');

        const mismatch = await postJson(`${base}/api/agents/anima/slack/tokens/validate`, {
          appToken: 'xapp-1-ADEMO123-valid',
          botToken: 'xoxb-other-app',
        });
        assert.equal(mismatch.status, 200);
        const mismatchBody = await mismatch.json() as { connection?: { message?: string; reason?: string; valid?: boolean } };
        assert.equal(mismatchBody.connection?.valid, false);
        assert.equal(mismatchBody.connection?.reason, 'app_mismatch');
        assert.equal(mismatchBody.connection?.message, undefined);

        const badConnect = await postJson(`${base}/api/agents/anima/slack/connect`, {
          appToken: 'xapp-1-ADEMO123-valid',
          botToken: 'xoxb-other-app',
        });
        assert.equal(badConnect.status, 400);
        assert.equal((await agentService('anima').getConfig()).slack.connected, false);

        const goodConnect = await postJson(`${base}/api/agents/anima/slack/connect`, {
          appToken: 'xapp-1-ADEMO123-valid',
          botToken: 'xoxb-valid-bot',
        });
        await assertStatus(goodConnect, 200, 'connect Slack tokens');
        const goodConnectBody = await goodConnect.json() as {
          slack?: { appId?: string; appToken?: string; avatarUrl?: string; botToken?: string; connected?: boolean; teamId?: string; workspaceName?: string };
        };
        assert.equal(goodConnectBody.slack?.connected, true);
        assert.equal(goodConnectBody.slack?.appId, 'ADEMO123');
        assert.equal(goodConnectBody.slack?.avatarUrl, 'https://example.test/bot.png');
        assert.equal(goodConnectBody.slack?.teamId, 'T-acme');
        assert.equal(goodConnectBody.slack?.workspaceName, 'Acme');
        assert.equal(goodConnectBody.slack?.appToken, '');
        assert.equal(goodConnectBody.slack?.botToken, '');
      } finally {
        server.close();
      }
    });
  } finally {
    if (previousSlackApiUrl === undefined) {
      delete process.env.ANIMA_SLACK_API_URL;
    } else {
      process.env.ANIMA_SLACK_API_URL = previousSlackApiUrl;
    }
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web API exposes Slack manifest update flow and bumps version after scoped bot token save', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-slack-manifest-test-'));
  const slackApi = await startSlackApiMock((method, body, request) => {
    const token = bearerToken(request) || String(slackRequestBody(body)['token'] ?? '');
    if (method === 'apps.connections.open') {
      return { ok: true, url: 'wss://socket.example.test/' };
    }
    if (method === 'auth.test') {
      const scopes = token.includes('with-commands')
        ? 'canvases:read,canvases:write,chat:write,commands,lists:read,lists:write,users:read'
        : 'chat:write,users:read';
      return {
        body: { app_id: 'ADEMO123', ok: true, team: 'Acme', team_id: 'T-acme', user: 'anima-bot', user_id: 'U-bot' },
        headers: { 'x-oauth-scopes': scopes },
      };
    }
    if (method === 'users.info') {
      return { ok: true, user: { id: 'U-bot', name: 'anima-bot', profile: { display_name: 'Anima Bot', image_72: 'https://example.test/bot.png' } } };
    }
    if (method === 'team.info') {
      return { ok: true, team: { id: 'T-acme', icon: { image_132: 'https://example.test/acme.png' }, name: 'Acme' } };
    }
    throw new Error(`unexpected Slack API method ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir, [
      {
        ...defaultAgentConfig('anima'),
        slack: { appId: 'ADEMO123', appToken: 'xapp-1-ADEMO123-valid', botToken: 'xoxb-old', teamId: 'TDEMO123' },
      },
    ]);
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        const base = `http://127.0.0.1:${address.port}`;

        const info = await fetch(`${base}/api/agents/anima/slack/manifest-update`);
        assert.equal(info.status, 200);
        const infoBody = await info.json() as {
          agentVersion: number;
          appManifestUrl?: string;
          currentVersion: number;
          manifestUpdateYaml: string;
          needsUpdate: boolean;
          reinstallUrl?: string;
        };
        assert.equal(infoBody.agentVersion, 0);
        assert.equal(infoBody.currentVersion, CURRENT_SLACK_MANIFEST_VERSION);
        assert.equal(infoBody.needsUpdate, true);
        assert.equal(infoBody.appManifestUrl, 'https://app.slack.com/app-settings/TDEMO123/ADEMO123/app-manifest');
        assert.equal(infoBody.reinstallUrl, 'https://api.slack.com/apps/ADEMO123/install-on-team');
        assert.match(infoBody.manifestUpdateYaml, /display_information:\n  name: Anima/);
        assert.match(infoBody.manifestUpdateYaml, /- commands/);
        assert.match(infoBody.manifestUpdateYaml, /callback_id: anima.hand_to_agent/);

        const missingScope = await postJson(`${base}/api/agents/anima/slack/manifest-upgrade`, {
          botToken: 'xoxb-without-shortcuts',
        });
        assert.equal(missingScope.status, 400);
        assert.equal((await agentService('anima').getConfig()).slack.manifestVersion, 0);

        const upgrade = await postJson(`${base}/api/agents/anima/slack/manifest-upgrade`, {
          botToken: 'xoxb-with-commands',
        });
        await assertStatus(upgrade, 200, 'upgrade Slack manifest');
        const upgradeBody = await upgrade.json() as { slack?: { botToken?: string; manifestVersion?: number } };
        assert.equal(upgradeBody.slack?.botToken, '');
        assert.equal(upgradeBody.slack?.manifestVersion, CURRENT_SLACK_MANIFEST_VERSION);
        const updated = await agentService('anima').getConfig();
        assert.equal(updated.slack.botToken, 'xoxb-with-commands');
        assert.equal(updated.slack.manifestVersion, CURRENT_SLACK_MANIFEST_VERSION);
      } finally {
        server.close();
      }
    });
  } finally {
    if (previousSlackApiUrl === undefined) {
      delete process.env.ANIMA_SLACK_API_URL;
    } else {
      process.env.ANIMA_SLACK_API_URL = previousSlackApiUrl;
    }
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web API sets Slack owner and queues onboarding wake-up', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-agent-owner-test-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-web-api-agent-owner-home-'));
  const slackCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    slackCalls.push({ method, body: slackRequestBody(body) });
    if (method === 'users.list') {
      return {
        ok: true,
        members: [
          {
            id: 'U-owner',
            name: 'iris',
            real_name: 'Iris Lead',
            profile: { display_name: 'Iris', image_72: 'https://example.test/iris.png' },
          },
          { id: 'U-bot', is_bot: true, name: 'helper-bot' },
          { id: 'U-deleted', deleted: true, name: 'deleted' },
        ],
      };
    }
    if (method === 'auth.test') return { ok: true, team_id: 'T-demo' };
    if (method === 'conversations.open') return { ok: true, channel: { id: 'D-owner' } };
    throw new Error(`unexpected Slack API method ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir, [{ ...defaultAgentConfig('anima'), homePath: homeDir }]);
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected web API to listen on a TCP address.');
        }
        const base = `http://127.0.0.1:${address.port}`;

        const usersRes = await fetch(`${base}/api/agents/anima/slack/users`);
        assert.equal(usersRes.status, 200);
        const usersBody = (await usersRes.json()) as { users: Array<{ displayName: string; slackUserId: string }> };
        assert.deepEqual(usersBody.users.map((user) => user.slackUserId), ['U-owner']);

        const setOwner = await fetch(`${base}/api/agents/anima/slack/owner`, {
          body: JSON.stringify({ slackUserId: 'U-owner' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        assert.equal(setOwner.status, 200);
        const setOwnerBody = (await setOwner.json()) as {
          owner?: { displayName?: string; handle?: string; onboardingPromptedAt?: string; slackUserId?: string };
        };
        assert.equal(setOwnerBody.owner?.slackUserId, 'U-owner');
        assert.equal(setOwnerBody.owner?.displayName, 'Iris');
        assert.equal(setOwnerBody.owner?.handle, 'iris');
        assert.match(setOwnerBody.owner?.onboardingPromptedAt ?? '', /^\d{4}-/);

        const items = await new WakeQueueService('anima').list();
        const onboarding = items.find((item) => item.id === 'agent-onboarding:anima:U-owner');
        assert.equal(onboarding?.kind, 'onboarding');
        assert.equal(onboarding?.kind === 'onboarding' ? onboarding.channelId : undefined, 'D-owner');
        assert.equal(onboarding?.kind === 'onboarding' ? onboarding.teamId : undefined, 'T-demo');
        assert.equal(onboarding?.kind === 'onboarding' ? onboarding.operator.slackUserId : undefined, 'U-owner');
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /<@U-owner>/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /You've been set up here/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /Your owner is Iris/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /MEMORY\.md/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /introduce yourself to Iris/);

        const openCalls = slackCalls.filter((call) => call.method === 'conversations.open');
        assert.deepEqual(openCalls.map((call) => call.body['users']), ['U-owner']);
      } finally {
        server.close();
      }
    });
  } finally {
    if (previousSlackApiUrl === undefined) {
      delete process.env.ANIMA_SLACK_API_URL;
    } else {
      process.env.ANIMA_SLACK_API_URL = previousSlackApiUrl;
    }
    await slackApi.close();
    await rm(homeDir, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web API setOwner with openerNote threads it into kickoff text', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-opener-test-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-web-api-opener-home-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'users.list') {
      return {
        ok: true,
        members: [
          {
            id: 'U-opener-user',
            name: 'alice',
            real_name: 'Alice',
            profile: { display_name: 'Alice', image_72: 'https://example.test/a.png' },
          },
        ],
      };
    }
    if (method === 'auth.test') return { ok: true, team_id: 'T-opener' };
    if (method === 'conversations.open') return { ok: true, channel: { id: 'D-opener' } };
    throw new Error(`unexpected Slack API method ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir, [{ ...defaultAgentConfig('anima'), homePath: homeDir }]);
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected web API to listen on a TCP address.');
        }
        const base = `http://127.0.0.1:${address.port}`;

        const res = await fetch(`${base}/api/agents/anima/slack/owner`, {
          body: JSON.stringify({
            slackUserId: 'U-opener-user',
            openerNote: 'Set you up to help with deployment pipelines.',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        assert.equal(res.status, 200);

        const items = await new WakeQueueService('anima').list();
        const onboarding = items.find((item) => item.id === 'agent-onboarding:anima:U-opener-user');
        assert.equal(onboarding?.kind, 'onboarding');
        // opener note must appear in kickoff text, hedged and anonymous
        assert.match(
          onboarding?.kind === 'onboarding' ? onboarding.text : '',
          /Set you up to help with deployment pipelines/,
        );
        assert.match(
          onboarding?.kind === 'onboarding' ? onboarding.text : '',
          /Context from whoever set you up/,
        );
        assert.match(
          onboarding?.kind === 'onboarding' ? onboarding.text : '',
          /Treat this as their intent, not fact/,
        );
        // standard onboarding lines still present
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /You've been set up here/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /MEMORY\.md/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /<@U-opener-user>/);
        // openerNote must NOT appear on disk config (transient only)
        const raw = JSON.parse(
          await readFile(join(stateDir, 'agents', 'anima', 'config.json'), 'utf8'),
        ) as Record<string, unknown>;
        assert.equal(JSON.stringify(raw).includes('deployment pipelines'), false);
      } finally {
        server.close();
      }
    });
  } finally {
    if (previousSlackApiUrl === undefined) {
      delete process.env.ANIMA_SLACK_API_URL;
    } else {
      process.env.ANIMA_SLACK_API_URL = previousSlackApiUrl;
    }
    await slackApi.close();
    await rm(homeDir, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web API setOwner with introduce:false persists owner without enqueueing onboarding DM', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-no-intro-test-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-web-api-no-intro-home-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'users.list') {
      return {
        ok: true,
        members: [
          {
            id: 'U-no-intro',
            name: 'vera',
            real_name: 'Vera',
            profile: { display_name: 'Vera', image_72: 'https://example.test/vera.png' },
          },
        ],
      };
    }
    throw new Error(`unexpected Slack API method in no-intro test: ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir, [{ ...defaultAgentConfig('anima'), homePath: homeDir }]);
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected web API to listen on a TCP address.');
        }
        const base = `http://127.0.0.1:${address.port}`;

        const res = await fetch(`${base}/api/agents/anima/slack/owner`, {
          body: JSON.stringify({ slackUserId: 'U-no-intro', introduce: false }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { owner?: { slackUserId?: string } };
        // Owner is persisted
        assert.equal(body.owner?.slackUserId, 'U-no-intro');
        // No onboarding inbox item enqueued
        const items = await new WakeQueueService('anima').list();
        const onboarding = items.find((item) => item.id?.startsWith('agent-onboarding:anima:'));
        assert.equal(onboarding, undefined, 'introduce:false must not enqueue an onboarding inbox item');
      } finally {
        server.close();
      }
    });
  } finally {
    if (previousSlackApiUrl === undefined) {
      delete process.env.ANIMA_SLACK_API_URL;
    } else {
      process.env.ANIMA_SLACK_API_URL = previousSlackApiUrl;
    }
    await slackApi.close();
    await rm(homeDir, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web API syncs Slack avatar metadata and exposes app id without secrets', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-sync-avatar-test-'));
  const slackCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    slackCalls.push({ method, body: slackRequestBody(body) });
    if (method === 'auth.test') {
      return { ok: true, team: 'Anima', team_id: 'T-demo', user_id: 'U-bot' };
    }
    if (method === 'users.info') {
      return { ok: true, user: { id: 'U-bot', profile: { image_72: 'https://example.test/bot.png' } } };
    }
    if (method === 'team.info') {
      return { ok: true, team: { id: 'T-demo', icon: { image_132: 'https://example.test/workspace.png' }, name: 'Anima' } };
    }
    throw new Error(`unexpected Slack API method ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir, [
      {
        ...defaultAgentConfig('anima'),
        slack: { appToken: 'xapp-1-ADEMO123-secret', botToken: 'xoxb-secret-value' },
      },
    ]);
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected web API to listen on a TCP address.');
        }
        const base = `http://127.0.0.1:${address.port}`;

        const sync = await fetch(`${base}/api/agents/anima/slack/sync-avatar`, { method: 'POST' });
        await assertStatus(sync, 200, 'sync Slack avatar');
        const syncBody = (await sync.json()) as {
          slack?: {
            appId?: string;
            appToken?: string;
            avatarUrl?: string;
            botToken?: string;
            teamId?: string;
            workspaceIconUrl?: string;
            workspaceName?: string;
          };
        };
        assert.equal(syncBody.slack?.appId, 'ADEMO123');
        assert.equal(syncBody.slack?.avatarUrl, 'https://example.test/bot.png');
        assert.equal(syncBody.slack?.teamId, 'T-demo');
        assert.equal(syncBody.slack?.workspaceIconUrl, 'https://example.test/workspace.png');
        assert.equal(syncBody.slack?.workspaceName, 'Anima');
        assert.equal(syncBody.slack?.appToken, '');
        assert.equal(syncBody.slack?.botToken, '');

        const agents = await fetch(`${base}/api/agents`);
        assert.equal(agents.status, 200);
        const agentsBody = (await agents.json()) as Array<{
          id: string;
          slack?: {
            appId?: string;
            appToken?: string;
            avatarUrl?: string;
            botToken?: string;
            teamId?: string;
            workspaceIconUrl?: string;
            workspaceName?: string;
          };
        }>;
        const anima = agentsBody.find((agent) => agent.id === 'anima');
        assert.equal(anima?.slack?.appId, 'ADEMO123');
        assert.equal(anima?.slack?.avatarUrl, 'https://example.test/bot.png');
        assert.equal(anima?.slack?.teamId, 'T-demo');
        assert.equal(anima?.slack?.workspaceIconUrl, 'https://example.test/workspace.png');
        assert.equal(anima?.slack?.workspaceName, 'Anima');
        assert.equal(anima?.slack?.appToken, '');
        assert.equal(anima?.slack?.botToken, '');

        const stored = await agentService('anima').getConfig();
        assert.equal(stored.slack.appId, 'ADEMO123');
        assert.equal(stored.slack.avatarUrl, 'https://example.test/bot.png');
        assert.equal(stored.slack.teamId, 'T-demo');
        assert.equal(stored.slack.workspaceIconUrl, 'https://example.test/workspace.png');
        assert.equal(stored.slack.workspaceName, 'Anima');
        assert.equal(stored.slack.appToken, 'xapp-1-ADEMO123-secret');
        assert.equal(stored.slack.botToken, 'xoxb-secret-value');
        assert.deepEqual(slackCalls.map((call) => call.method), ['auth.test', 'users.info', 'team.info']);
        assert.equal(slackCalls.find((call) => call.method === 'users.info')?.body['user'], 'U-bot');
        assert.equal(slackCalls.find((call) => call.method === 'team.info')?.body['team'], 'T-demo');
      } finally {
        server.close();
      }
    });
  } finally {
    if (previousSlackApiUrl === undefined) {
      delete process.env.ANIMA_SLACK_API_URL;
    } else {
      process.env.ANIMA_SLACK_API_URL = previousSlackApiUrl;
    }
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('syncDisplayInfoIfStale refreshes once then throttles within the TTL', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-sync-throttle-test-'));
  const slackCalls: Array<{ body: Record<string, unknown>; method: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    slackCalls.push({ method, body: slackRequestBody(body) });
    if (method === 'auth.test') {
      return { ok: true, team: 'Anima', team_id: 'T-demo', user_id: 'U-bot' };
    }
    if (method === 'users.info') {
      return { ok: true, user: { id: 'U-bot', profile: { image_72: 'https://example.test/bot.png' } } };
    }
    if (method === 'team.info') {
      return { ok: true, team: { id: 'T-demo', icon: { image_132: 'https://example.test/workspace.png' }, name: 'Anima' } };
    }
    throw new Error(`unexpected Slack API method ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir, [
      {
        ...defaultAgentConfig('anima'),
        slack: { appToken: 'xapp-1-ADEMO123-secret', botToken: 'xoxb-secret-value' },
      },
    ]);
    await withAnimaHome(stateDir, async () => {
      const service = agentSlackServiceForAgent('anima');
      const sixHoursMs = 6 * 60 * 60 * 1000;

      // First call: stale (never synced) → hits Slack and stamps the config.
      const first = await service.syncDisplayInfoIfStale({ ttlMs: sixHoursMs });
      assert.equal(first.synced, true);
      assert.deepEqual(slackCalls.map((call) => call.method), ['auth.test', 'users.info', 'team.info']);
      const stamped = await agentService('anima').getConfig();
      assert.equal(stamped.slack.avatarUrl, 'https://example.test/bot.png');
      assert.ok(stamped.slack.botProfileSyncedAt, 'botProfileSyncedAt should be set after a sync');

      // Second call within the TTL: throttled → no further Slack calls.
      const second = await service.syncDisplayInfoIfStale({ ttlMs: sixHoursMs });
      assert.equal(second.synced, false);
      assert.equal(slackCalls.length, 3, 'throttled call must not hit Slack again');

      // ttlMs:0 forces a re-sync regardless of the recent stamp. (team.info is
      // process-cached per workspace, so it may not be re-issued — the avatar
      // path auth.test + users.info is what proves the re-sync ran.)
      const forced = await service.syncDisplayInfoIfStale({ ttlMs: 0 });
      assert.equal(forced.synced, true);
      assert.equal(slackCalls.filter((call) => call.method === 'auth.test').length, 2);
      assert.equal(slackCalls.filter((call) => call.method === 'users.info').length, 2);
    });
  } finally {
    if (previousSlackApiUrl === undefined) {
      delete process.env.ANIMA_SLACK_API_URL;
    } else {
      process.env.ANIMA_SLACK_API_URL = previousSlackApiUrl;
    }
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('syncDisplayInfoIfStale does not clobber a concurrent config edit made mid-sync', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-sync-race-test-'));
  // Simulate an operator editing config (here: display name) WHILE the
  // background sync is in flight — kicked off during the first Slack call so it
  // commits before the post-call save. A pre-call snapshot save would revert it.
  let operatorEdit: Promise<unknown> | undefined;
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'auth.test') {
      if (!operatorEdit) {
        // The mock callback runs outside the test's withAnimaHome async scope,
        // so re-establish the home before touching agent config.
        operatorEdit = withAnimaHome(stateDir, () =>
          agentService('anima').updateProfile({ displayName: 'Edited During Sync' }));
      }
      return { ok: true, team: 'Race', team_id: 'T-race', user_id: 'U-bot' };
    }
    if (method === 'users.info') {
      return { ok: true, user: { id: 'U-bot', profile: { image_72: 'https://example.test/raced.png' } } };
    }
    if (method === 'team.info') {
      return { ok: true, team: { id: 'T-race', icon: { image_132: 'https://example.test/raced-ws.png' }, name: 'Race' } };
    }
    throw new Error(`unexpected Slack API method ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir, [
      {
        ...defaultAgentConfig('anima'),
        profile: { displayName: 'Original Name', role: 'tester' },
        slack: { appToken: 'xapp-1-ADEMO123-secret', botToken: 'xoxb-secret-value' },
      },
    ]);
    await withAnimaHome(stateDir, async () => {
      const synced = await agentSlackServiceForAgent('anima')
        .syncDisplayInfoIfStale({ ttlMs: 6 * 60 * 60 * 1000 });
      assert.equal(synced.synced, true);
      await operatorEdit; // ensure the concurrent edit settled

      const stored = await agentService('anima').getConfig();
      // The mid-sync operator edit survives...
      assert.equal(stored.profile.displayName, 'Edited During Sync');
      // ...and the sync's new avatar was still applied on top of the latest config.
      assert.equal(stored.slack.avatarUrl, 'https://example.test/raced.png');
    });
  } finally {
    if (previousSlackApiUrl === undefined) {
      delete process.env.ANIMA_SLACK_API_URL;
    } else {
      process.env.ANIMA_SLACK_API_URL = previousSlackApiUrl;
    }
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web API exposes Slack manifest install links without secrets', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-slack-install-test-'));
  await writeAgentConfigs(stateDir, [
    {
      ...defaultAgentConfig('scout'),
      profile: {
        displayName: 'Lens',
        role: 'Usage reporting agent.',
      },
      slack: undefined,
    },
  ]);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const base = `http://127.0.0.1:${address.port}/api/agents/scout/slack`;
      const redirect = await fetch(`${base}/install`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      const location = redirect.headers.get('location') ?? '';
      const url = new URL(location);
      assert.equal(`${url.origin}${url.pathname}`, 'https://api.slack.com/apps');
      assert.equal(url.searchParams.get('new_app'), '1');
      const manifestYaml = url.searchParams.get('manifest_yaml') ?? '';
      assert.match(manifestYaml, /display_name: Lens/);
      assert.match(manifestYaml, /- canvases:read/);
      assert.match(manifestYaml, /- canvases:write/);
      assert.match(manifestYaml, /- lists:read/);
      assert.match(manifestYaml, /- lists:write/);
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});
