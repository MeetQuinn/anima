import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { defaultAgentConfig, writeAgentConfigs } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { createWebServer } from '../web/app.js';
import { makeSlackEvent } from './helpers/slack.js';
import { startSlackApiMock } from './helpers/slack-api.js';
import { ingestEvent } from './helpers/inbox.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { AgentRestartCommandStore } from '../runtime/agent-restart-command.store.js';
import { persistProviderSession } from '../runtime/runtime-bridge.js';
import { withAnimaHome } from './anima-home.js';
import { agentService, testRuntime, assertStatus } from './helpers/web-api.js';

test('web API stop endpoint writes stopRequestedAt onto the item record', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-stop-test-'));
  await writeAgentConfigs(stateDir);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-stop',
          teamId: 'T-demo',
          text: 'stop me via HTTP',
          ts: '1770000020.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );

      const stopUrl = `http://127.0.0.1:${address.port}/api/agents/anima/stop`;

      // Nothing running yet → 409.
      const noRunning = await fetch(stopUrl, { method: 'POST' });
      assert.equal(noRunning.status, 409);

      // Advance the item to 'running' to simulate an active worker.
      await new WakeQueueService('anima').markRunning({
        itemId: ctx.item.id,
        startedAt: '2026-05-20T10:00:00.000Z',
        workerId: 'test-worker',
      });

      const response = await fetch(stopUrl, { method: 'POST' });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { ok: true });

      const item = await new WakeQueueService('anima').find(ctx.item.id);
      assert.ok(item?.handling.stopRequestedAt, 'expected stopRequestedAt to be set on the item record');
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API blocks disabling a running agent and disables idle agents immediately', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-disable-running-test-'));
  await writeAgentConfigs(stateDir);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-disable',
          teamId: 'T-demo',
          text: 'keep me running',
          ts: '1770000025.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      await new WakeQueueService('anima').markRunning({
        itemId: ctx.item.id,
        startedAt: '2026-05-20T10:00:00.000Z',
        workerId: 'test-worker',
      });

      const url = `http://127.0.0.1:${address.port}/api/agents/anima/disable`;
      const blocked = await fetch(url, { method: 'POST' });
      assert.equal(blocked.status, 409);
      assert.deepEqual(await blocked.json(), {
        error: 'Agent is running. Stop the agent before disabling.',
      });
      assert.equal((await agentService('anima').getConfig()).enabled, true);

      await new WakeQueueService('anima').complete(ctx.item.id);
      const disabled = await fetch(url, { method: 'POST' });
      assert.equal(disabled.status, 200);
      const body = (await disabled.json()) as { enabled?: boolean };
      assert.equal(body.enabled, false);
      assert.equal((await agentService('anima').getConfig()).enabled, false);
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API restart endpoint writes an operator restart command', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-restart-test-'));
  await writeAgentConfigs(stateDir);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/anima/restart`, {
        method: 'POST',
      });
      assert.equal(response.status, 202);
      const body = (await response.json()) as { ok?: boolean; requestId?: string };
      assert.equal(body.ok, true);
      assert.ok(body.requestId);

      const store = new AgentRestartCommandStore();
      assert.deepEqual(await store.pendingAgentIds(), ['anima']);
      const command = await store.take('anima');
      assert.equal(command?.agentId, 'anima');
      assert.equal(command?.reason, 'operator_restart');
      assert.equal(command?.requestId, body.requestId);
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API restart endpoint rejects disabled agents', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-restart-disabled-test-'));
  await writeAgentConfigs(stateDir, [{ ...defaultAgentConfig('anima'), enabled: false }]);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/anima/restart`, {
        method: 'POST',
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { error?: string };
      assert.equal(body.error, 'Agent is disabled. Enable it to run.');
      assert.deepEqual(await new AgentRestartCommandStore().pendingAgentIds(), []);
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API rotates the current provider session and records activity', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-rotate-test-'));
  await writeAgentConfigs(stateDir);
  await withAnimaHome(stateDir, async () => {
    const ctx = await ingestEvent(
      makeSlackEvent({
        channelId: 'D-rotate',
        teamId: 'T-demo',
        text: 'create session',
        ts: '1770000030.000001',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    const sessionPath = join(stateDir, 'agents/anima/sessions.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
    await writeFile(sessionPath, `${JSON.stringify({
      ...session,
      current: {
        id: 'provider-session-1',
        kind: 'codex-cli',
        updatedAt: '2026-05-19T12:00:00.000Z',
      },
    }, null, 2)}\n`, 'utf8');

    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/anima/session/rotate`, { method: 'POST' });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        archivedProviderSessions: Array<{ id: string; kind: string }>;
      };
      assert.deepEqual(body.archivedProviderSessions.map((item) => `${item.kind}:${item.id}`), ['codex-cli:provider-session-1']);

      const rotatedSession = JSON.parse(await readFile(sessionPath, 'utf8')) as {
        archived?: Array<{ id: string; kind: string }>;
        current?: unknown;
      };
      assert.equal(rotatedSession.current, undefined);
      assert.equal(rotatedSession.archived?.[0]?.id, 'provider-session-1');

      ctx.session.current = {
        id: 'provider-session-1',
        kind: 'codex-cli',
        updatedAt: '2026-05-19T12:00:00.000Z',
      };
      await persistProviderSession(
        ctx,
        'codex-cli',
        { id: 'provider-session-1', updatedAt: '2026-05-19T12:01:00.000Z' },
      );
      const afterInFlightPersist = JSON.parse(await readFile(sessionPath, 'utf8')) as { current?: unknown };
      assert.equal(afterInFlightPersist.current, undefined);

      await persistProviderSession(
        ctx,
        'codex-cli',
        { id: 'provider-session-2', updatedAt: '2026-05-19T12:02:00.000Z' },
      );
      const afterFreshPersist = JSON.parse(await readFile(sessionPath, 'utf8')) as {
        current?: { id?: string; kind?: string; updatedAt?: string };
      };
      assert.deepEqual(afterFreshPersist.current, {
        id: 'provider-session-2',
        kind: 'codex-cli',
        updatedAt: afterFreshPersist.current?.updatedAt,
      });

      const animaSessionArchive = await agentService('anima').getSession();
      assert.equal(animaSessionArchive?.archived?.[0]?.id, 'provider-session-1');

      const activityFeed = await activityServiceForAgent('anima').listActivityFeed();
      const rotateActivity = activityFeed.events
        .find((activity) => activity.type === 'anima.session.rotate');
      assert.equal(Object.hasOwn(rotateActivity ?? {}, 'itemId'), false);
      assert.equal(rotateActivity?.payload?.['archivedCount'], 1);
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API rotate fails closed when no provider session exists', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-rotate-empty-test-'));
  await writeAgentConfigs(stateDir);
  await withAnimaHome(stateDir, async () => {
    await ingestEvent(
      makeSlackEvent({
        channelId: 'D-rotate',
        teamId: 'T-demo',
        text: 'create empty session',
        ts: '1770000031.000001',
        userId: 'U1',
      }),
      { agentId: 'anima', stateDir },
    );
    const sessionPath = join(stateDir, 'agents/anima/sessions.json');
    const before = await readFile(sessionPath, 'utf8');
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/anima/session/rotate`, { method: 'POST' });
      assert.equal(response.status, 409);
      assert.equal(await readFile(sessionPath, 'utf8'), before);
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API mutates agent configs with redacted responses', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-agent-crud-test-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-web-api-agent-home-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'apps.connections.open') return { ok: true, url: 'wss://socket.example.test/' };
    if (method === 'auth.test') return { app_id: 'ADEMO123', ok: true, team: 'Anima', team_id: 'T-demo', user: 'local-agent', user_id: 'U-bot' };
    if (method === 'users.info') return { ok: true, user: { id: 'U-bot', name: 'local-agent', profile: { display_name: 'Local Agent Bot' } } };
    if (method === 'team.info') return { ok: true, team: { id: 'T-demo', icon: { image_132: 'https://example.test/workspace.png' }, name: 'Anima' } };
    throw new Error(`unexpected Slack API method ${method}`);
  });
  const previousSlackApiUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    await writeAgentConfigs(stateDir);
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const base = `http://127.0.0.1:${address.port}`;

      const rename = await fetch(`${base}/api/agents/anima/profile`, {
        body: JSON.stringify({ displayName: 'Anima Prime' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      await assertStatus(rename, 200, 'rename profile');
      assert.equal('impact' in ((await rename.json()) as Record<string, unknown>), false);
      assert.equal((await agentService('anima').getConfig()).profile?.displayName, 'Anima Prime');

      const invalid = await fetch(`${base}/api/agents/anima/home`, {
        body: JSON.stringify({ homePath: join(homeDir, 'missing') }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(invalid.status, 400);
      assert.equal(
        (await agentService('anima').getConfig()).homePath,
        join(stateDir, 'agent-homes', 'anima'),
        'invalid home update leaves last-good config',
      );

      const localOnly = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: 'Local Agent',
          homePath: homeDir,
          role: 'Local-only test agent.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(localOnly.status, 200);
      const localOnlyBody = (await localOnly.json()) as {
        slack?: {
          appToken: string;
          botToken: string;
          connected: boolean;
          manifestVersion: number;
          teamId: string;
          workspaceIconUrl: string;
          workspaceName: string;
        };
      };
      assert.deepEqual(localOnlyBody.slack, {
        appToken: '',
        botToken: '',
        connected: false,
        manifestVersion: 0,
        teamId: '',
        workspaceIconUrl: '',
        workspaceName: '',
      });
      const seedMemory = await readFile(join(homeDir, 'MEMORY.md'), 'utf8');
      assert.doesNotMatch(seedMemory, /Seed MEMORY scaffold/);
      assert.match(seedMemory, /# Local Agent/);
      assert.doesNotMatch(seedMemory, /local-agent/);
      assert.match(seedMemory, /parent and ancestor directories/);

      const chineseHomePath = join(homeDir, 'u-5c0f-7f8a');
      const chineseNameCreate = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: '小羊',
          homePath: chineseHomePath,
          role: 'Feishu test agent.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(chineseNameCreate.status, 200);
      const chineseNameBody = (await chineseNameCreate.json()) as { id?: string; profile?: { displayName?: string }; homePath?: string };
      assert.equal(chineseNameBody.id, 'u-5c0f-7f8a');
      assert.equal(chineseNameBody.profile?.displayName, '小羊');
      assert.equal(chineseNameBody.homePath, chineseHomePath);
      assert.match(await readFile(join(chineseHomePath, 'MEMORY.md'), 'utf8'), /# 小羊/);

      const defaultHomeCreate = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: 'Default Home Agent',
          homePath: join(homeDir, 'default-home-agent'),
          role: 'Default home test agent.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(defaultHomeCreate.status, 200);
      const defaultHomeBody = (await defaultHomeCreate.json()) as { homePath?: string };
      const defaultHomePath = join(homeDir, 'default-home-agent');
      assert.equal(defaultHomeBody.homePath, defaultHomePath);
      assert.equal((await stat(defaultHomePath)).isDirectory(), true);
      assert.match(await readFile(join(defaultHomePath, 'MEMORY.md'), 'utf8'), /# Default Home Agent/);

      const parentHomeCreate = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: 'Parent Home Agent',
          homePath: join(homeDir, 'parent-home-agent'),
          role: 'Parent home test agent.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(parentHomeCreate.status, 200);
      const parentHomeBody = (await parentHomeCreate.json()) as { homePath?: string };
      const parentHomePath = join(homeDir, 'parent-home-agent');
      assert.equal(parentHomeBody.homePath, parentHomePath);
      assert.equal((await stat(parentHomePath)).isDirectory(), true);

      const nestedHomeCreate = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: 'Nested Home Agent',
          homePath: join(homeDir, 'missing-parent', 'nested-home-agent'),
          role: 'Nested home test agent.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(nestedHomeCreate.status, 200);
      const nestedHomeBody = (await nestedHomeCreate.json()) as { homePath?: string };
      const nestedHomePath = join(homeDir, 'missing-parent', 'nested-home-agent');
      assert.equal(nestedHomeBody.homePath, nestedHomePath);
      assert.equal((await stat(nestedHomePath)).isDirectory(), true);

      const badConnect = await fetch(`${base}/api/agents/local-agent/slack/connect`, {
        body: JSON.stringify({ appToken: 'bad-xapp', botToken: 'xoxb-local-agent' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(badConnect.status, 400);

      const connectLocal = await fetch(`${base}/api/agents/local-agent/slack/connect`, {
        body: JSON.stringify({ appToken: 'xapp-local-agent', botToken: 'xoxb-local-agent' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(connectLocal.status, 200);
      const connectLocalBody = (await connectLocal.json()) as { slack?: { connected?: boolean } };
      assert.equal(connectLocalBody.slack?.connected, true);

      const connectFeishu = await fetch(`${base}/api/agents/local-agent/feishu/connect`, {
        body: JSON.stringify({
          appId: 'cli_demo',
          appSecret: 'feishu-secret',
          botOpenId: 'ou_demo',
          verificationToken: 'verify-token',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(connectFeishu.status, 200);
      const connectFeishuBody = (await connectFeishu.json()) as {
        feishu?: {
          appId?: string;
          appSecret?: string;
          botOpenId?: string;
          connected?: boolean;
          verificationToken?: string;
        };
      };
      assert.equal(connectFeishuBody.feishu?.connected, true);
      assert.equal(connectFeishuBody.feishu?.appId, 'cli_demo');
      assert.equal(connectFeishuBody.feishu?.botOpenId, 'ou_demo');
      assert.equal(connectFeishuBody.feishu?.appSecret, '');
      assert.equal(connectFeishuBody.feishu?.verificationToken, '');
      const storedFeishu = await agentService('local-agent').getConfig();
      assert.equal(storedFeishu.feishu.appSecret, 'feishu-secret');
      assert.equal(storedFeishu.feishu.verificationToken, 'verify-token');

      const createWithSlack = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: 'Create With Slack',
          slack: { appToken: 'xapp-new-agent', botToken: 'xoxb-new-agent' },
          homePath: homeDir,
          role: 'Invalid mixed create/connect body.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(createWithSlack.status, 400, 'create rejects Slack fields; slack/connect owns tokens');

      const create = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: 'New Agent',
          homePath: homeDir,
          role: 'New local agent.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(create.status, 200);
      const createBody = (await create.json()) as { slack?: { appToken?: string; botToken?: string; connected?: boolean }; homePath?: string };
      assert.equal(createBody.slack?.appToken, '');
      assert.equal(createBody.slack?.botToken, '');
      assert.equal(createBody.slack?.connected, false);
      assert.equal(createBody.homePath, homeDir);

      const remove = await fetch(`${base}/api/agents/new-agent`, { method: 'DELETE' });
      assert.equal(remove.status, 200);
      const removeBody = (await remove.json()) as { id: string };
      assert.equal(removeBody.id, 'new-agent');
      await assert.rejects(agentService('new-agent').getConfig(), /Agent not found in config: new-agent/);

      const duplicateRemoved = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: 'New Agent',
          homePath: homeDir,
          role: 'New agent can be recreated.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(duplicateRemoved.status, 200, 'deleted ids can be recreated');
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

test('web API stamps and exposes createdAt through create response and snapshot', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-created-at-test-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-web-api-created-at-home-'));
  await writeAgentConfigs(stateDir);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const base = `http://127.0.0.1:${address.port}`;

      const before = Date.now();
      const create = await fetch(`${base}/api/agents`, {
        body: JSON.stringify({
          name: 'Timestamped Agent',
          homePath: homeDir,
          role: 'Timestamped agent.',
          provider: testRuntime(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const after = Date.now();
      assert.equal(create.status, 200);
      const createBody = (await create.json()) as { createdAt?: string; id: string };

      // The redacted create response must include a valid ISO createdAt.
      assert.ok(createBody.createdAt, 'create response should include createdAt');
      const stamped = new Date(createBody.createdAt).getTime();
      assert.ok(stamped >= before && stamped <= after, 'createdAt should be within the test window');

      // The agents API must expose the same createdAt on the agent.
      const agentsRes = await fetch(`${base}/api/agents`);
      assert.equal(agentsRes.status, 200);
      const agentsBody = (await agentsRes.json()) as Array<{ createdAt?: string; id: string }>;
      const snapshotAgent = agentsBody.find((a) => a.id === 'timestamped-agent');
      assert.ok(snapshotAgent, 'agent should appear in snapshot');
      assert.equal(snapshotAgent?.createdAt, createBody.createdAt, 'snapshot createdAt should match create response');
    } finally {
      server.close();
    }
  });
  await rm(homeDir, { force: true, recursive: true });
  await rm(stateDir, { force: true, recursive: true });
});
