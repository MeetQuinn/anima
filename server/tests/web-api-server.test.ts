import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeAgentConfigs } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer } from '../web/app.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { defaultKbRegistryService } from '../kb/kb.service.js';
import { withAnimaHome } from './anima-home.js';
import { postJson, assertStatus } from './helpers/web-api.js';

test('web API serves the web app and agents API', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-server-test-'));
  await writeAgentConfigs(stateDir);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected web API to listen on a TCP address.');
      }

      const html = await fetch(`http://127.0.0.1:${address.port}/`);
      assert.equal(html.status, 200);
      assert.match(await html.text(), /Anima/);

      const agentsRes = await fetch(`http://127.0.0.1:${address.port}/api/agents`);
      assert.equal(agentsRes.status, 200);
      const agentsBody = (await agentsRes.json()) as Array<{ id: string }>;
      assert.ok(Array.isArray(agentsBody));
      assert.ok(agentsBody.some((a) => a.id === 'anima'));

      const statusesRes = await fetch(`http://127.0.0.1:${address.port}/api/agent-statuses`);
      assert.equal(statusesRes.status, 200);
      const statusesBody = (await statusesRes.json()) as Array<{
        agentId: string;
      }>;
      assert.ok(Array.isArray(statusesBody));
      assert.ok(statusesBody.some((s) => s.agentId === 'anima'));

      const orderWrite = await fetch(`http://127.0.0.1:${address.port}/api/sidebar-order`, {
        body: JSON.stringify({ agents: ['anima'], kbs: ['team'] }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      });
      assert.equal(orderWrite.status, 200);
      assert.deepEqual(await orderWrite.json(), { sidebarOrder: { agents: ['anima'], kbs: ['team'] } });
      const orderRead = await fetch(`http://127.0.0.1:${address.port}/api/sidebar-order`);
      assert.equal(orderRead.status, 200);
      assert.deepEqual(await orderRead.json(), {
        sidebarOrder: { agents: ['anima'], kbs: ['team'] },
      });

      const platformReadDefault = await fetch(`http://127.0.0.1:${address.port}/api/workspace-platform`);
      assert.equal(platformReadDefault.status, 200);
      assert.deepEqual(await platformReadDefault.json(), { platform: 'slack' });
      const platformWrite = await fetch(`http://127.0.0.1:${address.port}/api/workspace-platform`, {
        body: JSON.stringify({ platform: 'feishu' }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      });
      assert.equal(platformWrite.status, 200);
      assert.deepEqual(await platformWrite.json(), { platform: 'feishu' });
      const platformRead = await fetch(`http://127.0.0.1:${address.port}/api/workspace-platform`);
      assert.equal(platformRead.status, 200);
      assert.deepEqual(await platformRead.json(), { platform: 'feishu' });
      const platformInvalid = await fetch(`http://127.0.0.1:${address.port}/api/workspace-platform`, {
        body: JSON.stringify({ platform: 'lark' }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      });
      assert.equal(platformInvalid.status, 400);
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API reports provider availability', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-provider-availability-test-'));
  await writeAgentConfigs(stateDir);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/provider-availability`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        providers: Array<{ authed?: unknown; kind: string; present: unknown }>;
      };
      assert.deepEqual(body.providers.map((provider) => provider.kind).sort(), [
        'claude-code',
        'codex-cli',
        'grok-cli',
        'kimi-cli',
      ]);
      for (const provider of body.providers) {
        assert.equal(typeof provider.present, 'boolean');
        assert.equal('authed' in provider, false);
      }
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API manages global provider context limits without storing them in agent launch env', async () => {
  const stateDir = await mkdtemp(
    join(tmpdir(), 'anima-web-api-context-limit-'),
  );
  const kimiHome = join(stateDir, 'kimi-home');
  const previousKimiHome = process.env.KIMI_CODE_HOME;
  const previousMachineWrites = process.env.ANIMA_ALLOW_MACHINE_WRITES;
  process.env.KIMI_CODE_HOME = kimiHome;
  process.env.ANIMA_ALLOW_MACHINE_WRITES = '1';
  await writeAgentConfigs(stateDir);
  await writeFile(
    join(stateDir, 'agents', 'anima', 'config.json'),
    `${JSON.stringify(
      {
        homePath: join(stateDir, 'agent-homes', 'anima'),
        id: 'anima',
        provider: {
          env: { CODEX_SECRET: 'agent-secret-sentinel' },
          kind: 'kimi-cli',
          model: 'kimi-code/k3',
        },
        slack: { appToken: 'xapp-secret-value', botToken: 'xoxb-secret-value' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  try {
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Expected TCP address');
        const base = `http://127.0.0.1:${address.port}`;

        const before = await fetch(`${base}/api/provider-context-limits`);
        assert.equal(before.status, 200);
        assert.equal(
          (
            (await before.json()) as {
              providers: Array<{ maxTokens: number | null; provider: string }>;
            }
          ).providers.find((row) => row.provider === 'kimi-cli')?.maxTokens,
          null,
        );

        const saved = await fetch(`${base}/api/provider-context-limits`, {
          body: JSON.stringify({ maxTokens: 262144, provider: 'kimi-cli' }),
          headers: { 'content-type': 'application/json' },
          method: 'PUT',
        });
        assert.equal(saved.status, 200);
        assert.match(
          await readFile(join(kimiHome, 'config.toml'), 'utf8'),
          /max_context_size = 262144/,
        );

        const persistedAgent = JSON.parse(
          await readFile(
            join(stateDir, 'agents', 'anima', 'config.json'),
            'utf8',
          ),
        ) as { provider: { env?: Record<string, string> } };
        assert.deepEqual(persistedAgent.provider.env, {
          CODEX_SECRET: 'agent-secret-sentinel',
        });
      } finally {
        server.close();
      }
    });
  } finally {
    if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiHome;
    if (previousMachineWrites === undefined)
      delete process.env.ANIMA_ALLOW_MACHINE_WRITES;
    else process.env.ANIMA_ALLOW_MACHINE_WRITES = previousMachineWrites;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('server-info exposes the last standalone restart result for UI echoes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-last-restart-test-'));
  await writeAgentConfigs(stateDir);
  await mkdir(join(stateDir, 'run'), { recursive: true });
  await writeFile(
    join(stateDir, 'run', 'services-restart-result.json'),
    `${JSON.stringify({
      completedAt: '2026-05-29T10:55:00.000Z',
      fallbackToIdle: false,
      mode: 'drain-active',
      requestedCount: 2,
      resumedCount: 2,
    })}\n`,
    'utf8',
  );
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        lastRestart?: {
          completedAt: string;
          fallbackToIdle: boolean;
          logPath?: string;
          mode: string;
          requestedCount: number;
          resumedCount: number;
        };
      };
      assert.deepEqual(body.lastRestart, {
        completedAt: '2026-05-29T10:55:00.000Z',
        fallbackToIdle: false,
        logPath: join(stateDir, 'logs', 'services-restart.log'),
        mode: 'drain-active',
        requestedCount: 2,
        resumedCount: 2,
        status: 'succeeded',
      });
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('server-info exposes blocked standalone restart results for honest UI errors', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-blocked-restart-test-'));
  await writeAgentConfigs(stateDir);
  await mkdir(join(stateDir, 'run'), { recursive: true });
  await writeFile(
    join(stateDir, 'run', 'services-restart-result.json'),
    `${JSON.stringify({
      blockers: [
        {
          agentId: 'runner',
          itemId: 'item_running',
          since: '2026-05-29T12:38:45.950Z',
          status: 'running',
          summary: 'Long-running task',
          workerId: 'runner:123',
        },
      ],
      completedAt: '2026-05-29T12:46:22.000Z',
      message: 'Agents still working — restart did not run. Try again once they reach a safe point.',
      reason: 'drain_timeout',
      status: 'blocked',
    })}\n`,
    'utf8',
  );
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        lastRestart?: {
          blockers?: Array<{ agentId: string; itemId: string; status: string }>;
          logPath?: string;
          reason?: string;
          status?: string;
        };
      };
      assert.equal(body.lastRestart?.status, 'blocked');
      assert.equal(body.lastRestart?.reason, 'drain_timeout');
      assert.deepEqual(
        body.lastRestart?.blockers?.map((blocker) => ({
          agentId: blocker.agentId,
          itemId: blocker.itemId,
          status: blocker.status,
        })),
        [{ agentId: 'runner', itemId: 'item_running', status: 'running' }],
      );
      assert.equal(body.lastRestart?.logPath, join(stateDir, 'logs', 'services-restart.log'));
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('dashboard auth protects dashboard APIs and static app while leaving health checks public', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-dashboard-auth-test-'));
  const kbRepoDir = await mkdtemp(join(tmpdir(), 'anima-dashboard-auth-kb-'));
  try {
    await writeAgentConfigs(stateDir);
    await mkdir(join(kbRepoDir, 'docs'), { recursive: true });
    await writeFile(join(kbRepoDir, 'docs', 'report.html'), '<!doctype html><h1>Private KB</h1>\n', 'utf8');
    await mkdir(join(stateDir, 'kbs', 'test'), { recursive: true });
    await writeFile(
      join(stateDir, 'kbs', 'test', 'config.json'),
      `${JSON.stringify({ label: 'Test', path: kbRepoDir }, null, 2)}\n`,
      'utf8',
    );
    await withAnimaHome(stateDir, async () => {
      defaultKbRegistryService.clearCaches();
      await defaultDashboardAuthService.setPassword('correct horse battery staple');
      const storedConfig = await readFile(join(stateDir, 'config.json'), 'utf8');
      assert.match(storedConfig, /"dashboardAuth"/);
      assert.match(storedConfig, /"passwordHash"/);
      assert.doesNotMatch(storedConfig, /correct horse battery staple/);

      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        const base = `http://127.0.0.1:${address.port}`;

        await assertStatus(await fetch(`${base}/api/health`), 200, 'health');
        await assertStatus(await fetch(`${base}/api/server-info`), 200, 'server-info');

        const unauthenticatedAgents = await fetch(`${base}/api/agents`);
        await assertStatus(unauthenticatedAgents, 401, 'unauthenticated agents');
        const unauthenticatedBody = (await unauthenticatedAgents.json()) as {
          error?: string;
        };
        assert.equal(unauthenticatedBody.error, 'authentication_required');

        const unauthenticatedKbRaw = await fetch(`${base}/kb/raw/test/docs/report.html`);
        await assertStatus(unauthenticatedKbRaw, 401, 'unauthenticated kb raw');
        const unauthenticatedKbRawBody = (await unauthenticatedKbRaw.json()) as { error?: string };
        assert.equal(unauthenticatedKbRawBody.error, 'authentication_required');

        const rootRedirect = await fetch(`${base}/`, { redirect: 'manual' });
        await assertStatus(rootRedirect, 302, 'dashboard root redirect');
        assert.equal(rootRedirect.headers.get('location'), '/login?next=%2F');
        const agentRouteRedirect = await fetch(`${base}/agents/anima/activity`, { redirect: 'manual' });
        await assertStatus(agentRouteRedirect, 302, 'dashboard agent route redirect');
        assert.equal(agentRouteRedirect.headers.get('location'), '/login?next=%2Fagents%2Fanima%2Factivity');
        await assertStatus(await fetch(`${base}/login`), 200, 'login page');
        await assertStatus(await fetch(`${base}/favicon.svg`), 200, 'favicon');

        const missingAsset = await fetch(`${base}/assets/missing.js`);
        await assertStatus(missingAsset, 404, 'missing asset');
        assert.doesNotMatch(missingAsset.headers.get('content-type') ?? '', /text\/html/);
        const assetLikeAppRoute = await fetch(`${base}/agents/anima/activity.json`);
        await assertStatus(assetLikeAppRoute, 404, 'asset-like app route');
        assert.doesNotMatch(assetLikeAppRoute.headers.get('content-type') ?? '', /text\/html/);

        const badLogin = await postJson(`${base}/api/auth/login`, {
          password: 'wrong password',
        });
        await assertStatus(badLogin, 401, 'bad login');
        assert.equal(badLogin.headers.get('set-cookie')?.includes('Max-Age=0'), true);

        const goodLogin = await postJson(`${base}/api/auth/login`, {
          password: 'correct horse battery staple',
        });
        await assertStatus(goodLogin, 200, 'good login');
        const sessionCookie = goodLogin.headers.get('set-cookie')?.split(';')[0];
        assert.ok(sessionCookie?.startsWith('anima_dashboard_session='));
        if (!sessionCookie) throw new Error('Expected dashboard auth session cookie');

        await assertStatus(
          await fetch(`${base}/api/agents`, {
            headers: { cookie: sessionCookie },
          }),
          200,
          'authenticated agents',
        );
        const authenticatedKbRaw = await fetch(`${base}/kb/raw/test/docs/report.html`, {
          headers: { cookie: sessionCookie },
        });
        await assertStatus(authenticatedKbRaw, 200, 'authenticated kb raw');
        assert.match(await authenticatedKbRaw.text(), /Private KB/);

        const logout = await fetch(`${base}/api/auth/logout`, {
          headers: { cookie: sessionCookie },
          method: 'POST',
        });
        await assertStatus(logout, 200, 'logout');
        assert.equal(logout.headers.get('set-cookie')?.includes('Max-Age=0'), true);
      } finally {
        server.close();
        defaultKbRegistryService.clearCaches();
      }
    });
  } finally {
    await rm(kbRepoDir, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
  }
});
