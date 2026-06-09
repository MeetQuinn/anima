import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { redactAgentConfig } from '../agents/agent-config-ops.js';
import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { createWebServer } from '../web/app.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { defaultKbRegistryService } from '../kb/kb.service.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { recordRuntimeEvent } from '../runtime/activity.js';
import { AgentHealthStore } from '../runtime/agent-health.store.js';
import { AgentRestartCommandStore } from '../runtime/agent-restart-command.store.js';
import { persistProviderSession } from '../runtime/runtime-bridge.js';
import { setActiveRuntimeItem } from '../runtime/active-item.js';
import { recordLifetimeTokenUsageForItem, tokenDeltaForActivities } from '../runtime/usage.js';
import { CURRENT_SLACK_MANIFEST_VERSION } from '../../shared/slack-manifest.js';
import { withAnimaHome } from './anima-home.js';

const agentService = (agentId: string) => defaultAgentRegistryService.serviceFor(agentId);

test('web snapshot summarizes state without exposing secrets', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-test-'));
  try {
    await writeConfig(stateDir);
    await withAnimaHome(stateDir, async () => {
      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          text: 'Show this in the web app.',
          ts: '1770000000.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      await activityServiceForAgent('anima').record({
        payload: {
          channel: 'D-demo',
          payload: {
            channel: 'D-demo',
            text: 'Visible in output.',
          },
          status: 'dry-run',
          text: 'Visible in output.',
          tool: 'anima.message.send',
        },
        type: 'tool.call.completed',
      });
      await recordRuntimeEvent({ agentId: 'anima' }, 'codex-cli', undefined, {
        contextWindow: 200000,
        currentContextTokens: 1300,
        eventType: 'codex.context.stats',
        runtimeKind: 'codex-cli',
      });
      await recordRuntimeEvent({ agentId: 'anima' }, 'codex-cli', undefined, {
        contextWindow: 200000,
        eventType: 'codex.session.stats',
        inputTokens: 1200,
        outputTokens: 80,
        runtimeKind: 'codex-cli',
      });

      const agentConfig = redactAgentConfig(await agentService('anima').getConfig());
      const animaSession = await agentService('anima').getSession();
      const sessionRecord = JSON.parse(await readFile(join(stateDir, 'agents/anima/sessions.json'), 'utf8')) as {
        currentStartedAt?: string;
        latestProviderStats?: unknown;
      };
      assert.equal(animaSession?.currentStartedAt, ctx.session.createdAt);
      assert.equal(sessionRecord.currentStartedAt, ctx.session.createdAt);
      assert.deepEqual(sessionRecord.latestProviderStats, animaSession?.latestProviderStats);
      assert.deepEqual(Object.keys(agentConfig.provider?.env ?? {}), ['CODEX_SECRET']);
      assert.equal(agentConfig.provider?.env?.['CODEX_SECRET'], '');
      assert.equal(agentConfig.provider?.model, 'gpt-5.2-codex');
      assert.ok(agentConfig.provider && 'reasoningEffort' in agentConfig.provider);
      assert.equal(agentConfig.provider.reasoningEffort, 'high');
      assert.equal(agentConfig.slack?.appToken, '');
      assert.equal(agentConfig.slack?.botToken, '');
      assert.equal(agentConfig.slack?.connected, true);
      assert.deepEqual(animaSession?.latestProviderStats, {
        activityId: animaSession?.latestProviderStats?.activityId,
        contextWindow: 200000,
        createdAt: animaSession?.latestProviderStats?.createdAt,
        currentContextTokens: 1300,
        inputTokens: 1200,
        outputTokens: 80,
        runtimeKind: 'codex-cli',
        sessionTokenUsage: 1280,
        usedTokens: 1280,
      });

      const serialized = JSON.stringify(agentConfig);
      assert.match(serialized, /CODEX_SECRET/);
      assert.doesNotMatch(serialized, /runtime-secret-value/);
      assert.doesNotMatch(serialized, /xapp-secret-value/);
      assert.doesNotMatch(serialized, /xoxb-secret-value/);

      // Activities are now a separate call
      const activityFeed = await activityServiceForAgent('anima').listActivityFeed();
      const inboxEvent = activityFeed.events.find((event) => event.kind === 'inbox');
      assert.equal(inboxEvent?.kind === 'inbox' ? inboxEvent.item.id : undefined, ctx.item.id);
      assert.deepEqual(Object.keys(activityFeed).sort(), ['events', 'nextCursor']);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('activity feed pages combined feed events without returning all inbox items', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-activity-feed-page-test-'));
  try {
    await writeConfig(stateDir);
    await withAnimaHome(stateDir, async () => {
      const first = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          text: 'First',
          ts: '1770000000.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      const second = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          text: 'Second',
          ts: '1770000001.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      const third = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          text: 'Third',
          ts: '1770000002.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );

      const page = await activityServiceForAgent('anima').listActivityFeed({ limit: 2 });
      assert.equal(page.events.length, 2);
      assert.deepEqual(
        page.events.map((event) => event.kind === 'inbox' ? event.item.id : event.activity.activityId),
        [second.item.id, third.item.id],
      );
      assert.ok(page.nextCursor);
      assert.equal(
        page.events.some((event) => event.kind === 'inbox' && event.item.id === first.item.id),
        false,
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web snapshot includes Claude auto-compact threshold with provider stats', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-claude-stats-test-'));
  try {
    await writeConfig(stateDir, [
      {
        ...defaultAgentConfig('iris'),
        provider: {
          env: {
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123456',
            CODEX_SECRET: 'runtime-secret-value',
          },
          kind: 'claude-code',
          model: 'opus',
          reasoningEffort: 'xhigh',
        },
      } as ReturnType<typeof defaultAgentConfig>,
    ]);
    await withAnimaHome(stateDir, async () => {
      await ingestEvent(
        makeSlackEvent({
          channelId: 'D-iris',
          teamId: 'T-demo',
          text: 'Record Claude stats.',
          ts: '1770000000.000002',
          userId: 'U1',
        }),
        { agentId: 'iris', stateDir },
      );
      await recordRuntimeEvent({ agentId: 'iris' }, 'claude-code', {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123456',
      }, {
        currentContextTokens: 120000,
        eventType: 'claude.context.stats',
        runtimeKind: 'claude-code',
      });
      await recordRuntimeEvent({ agentId: 'iris' }, 'claude-code', {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123456',
      }, {
        cacheReadInputTokens: 210000,
        contextWindow: 1000000,
        eventType: 'claude.session.stats',
        outputTokens: 1000,
        runtimeKind: 'claude-code',
      });
      await recordRuntimeEvent({ agentId: 'iris' }, 'claude-code', {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123456',
      }, {
        eventType: 'claude.compact.completed',
        runtimeKind: 'claude-code',
      });

      const irisSession = await agentService('iris').getSession();
      assert.deepEqual(irisSession?.latestProviderStats, {
        activityId: irisSession?.latestProviderStats?.activityId,
        autoCompactWindow: 123456,
        cacheReadInputTokens: 210000,
        contextWindow: 1000000,
        createdAt: irisSession?.latestProviderStats?.createdAt,
        currentContextTokens: 120000,
        outputTokens: 1000,
        runtimeKind: 'claude-code',
        sessionCompactionCount: 1,
        sessionTokenUsage: 211000,
        usedTokens: 211000,
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web snapshot includes Kimi context-window occupancy', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-kimi-stats-test-'));
  try {
    await writeConfig(stateDir, [
      {
        ...defaultAgentConfig('kimi'),
        provider: {
          kind: 'kimi-cli',
          model: 'kimi-code/kimi-for-coding',
        },
      } as ReturnType<typeof defaultAgentConfig>,
    ]);
    await withAnimaHome(stateDir, async () => {
      await ingestEvent(
        makeSlackEvent({
          channelId: 'D-kimi',
          teamId: 'T-demo',
          text: 'Record Kimi stats.',
          ts: '1770000000.000003',
          userId: 'U1',
        }),
        { agentId: 'kimi', stateDir },
      );
      await recordRuntimeEvent({ agentId: 'kimi' }, 'kimi-cli', undefined, {
        cacheReadInputTokens: 1024,
        contextWindow: 262144,
        currentContextTokens: 13131,
        eventType: 'kimi.context.stats',
        inputTokens: 12107,
        outputTokens: 24,
        runtimeKind: 'kimi-cli',
      });

      const kimiSession = await agentService('kimi').getSession();
      assert.deepEqual(kimiSession?.latestProviderStats, {
        activityId: kimiSession?.latestProviderStats?.activityId,
        cacheReadInputTokens: 1024,
        contextWindow: 262144,
        createdAt: kimiSession?.latestProviderStats?.createdAt,
        currentContextTokens: 13131,
        inputTokens: 12107,
        outputTokens: 24,
        runtimeKind: 'kimi-cli',
        usedTokens: 13155,
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web snapshot exposes persisted lifetime token usage', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-lifetime-usage-test-'));
  try {
    await writeConfig(stateDir);
    await withAnimaHome(stateDir, async () => {
      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          text: 'Record lifetime usage.',
          ts: '1770000000.000004',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      await recordRuntimeEvent({ agentId: 'anima' }, 'codex-cli', undefined, {
        cacheReadInputTokens: 20,
        eventType: 'codex.session.stats',
        inputTokens: 100,
        outputTokens: 5,
        runtimeKind: 'codex-cli',
      });
      await new WakeQueueService('anima').complete(ctx.item.id);

      await recordLifetimeTokenUsageForItem('anima', ctx.item.id);
      await recordLifetimeTokenUsageForItem('anima', ctx.item.id);

      const animaSessionTokens = await agentService('anima').getSession();
      assert.equal(animaSessionTokens?.lifetimeTokens, 250);

      const usage = JSON.parse(await readFile(join(stateDir, 'agents', 'anima', 'usage.json'), 'utf8')) as {
        totalTokens: number;
      };
      assert.equal(usage.totalTokens, 250);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web snapshot scopes current-session metrics to the latest rotation boundary', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-current-session-test-'));
  try {
    await writeConfig(stateDir);
    await withAnimaHome(stateDir, async () => {
      const before = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          text: 'Before rotation.',
          ts: '1770000000.000020',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      await new WakeQueueService('anima').replaceItem({
        ...before.item,
        handling: {
          ...before.item.handling,
          createdAt: '2026-05-22T04:28:00.000Z',
          updatedAt: '2026-05-22T04:28:00.000Z',
        },
      });
      await recordRuntimeEvent({ agentId: 'anima' }, 'codex-cli', undefined, {
        cacheReadInputTokens: 900,
        eventType: 'codex.session.stats',
        inputTokens: 100,
        outputTokens: 1,
        runtimeKind: 'codex-cli',
      }, '2026-05-22T04:28:30.000Z');
      await recordRuntimeEvent({ agentId: 'anima' }, 'codex-cli', undefined, {
        eventType: 'codex.compact.completed',
        runtimeKind: 'codex-cli',
      }, '2026-05-22T04:28:31.000Z');

      const rotatedAt = '2026-05-22T04:29:56.481Z';
      const sessionPath = join(stateDir, 'agents/anima/sessions.json');
      const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
      await writeFile(sessionPath, `${JSON.stringify({
        ...session,
        archived: [
          {
            archivedAt: rotatedAt,
            archivedBy: 'operator',
            id: 'old-provider-session',
            kind: 'codex-cli',
            updatedAt: '2026-05-22T04:29:00.000Z',
          },
        ],
        current: {
          id: 'new-provider-session',
          kind: 'codex-cli',
          updatedAt: '2026-05-22T04:31:00.000Z',
        },
        currentStartedAt: rotatedAt,
        latestProviderStats: undefined,
      }, null, 2)}\n`, 'utf8');

      await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          text: 'After rotation.',
          ts: '1770000001.000020',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      await recordRuntimeEvent({ agentId: 'anima' }, 'codex-cli', undefined, {
        contextWindow: 200000,
        currentContextTokens: 2000,
        eventType: 'codex.context.stats',
        runtimeKind: 'codex-cli',
      }, '2026-05-22T04:31:00.000Z');
      await recordRuntimeEvent({ agentId: 'anima' }, 'codex-cli', undefined, {
        eventType: 'codex.session.stats',
        inputTokens: 20,
        outputTokens: 3,
        runtimeKind: 'codex-cli',
      }, '2026-05-22T04:31:01.000Z');

      const animaSessionRotated = await agentService('anima').getSession();
      assert.equal(animaSessionRotated?.currentStartedAt, rotatedAt);
      assert.deepEqual(animaSessionRotated?.latestProviderStats, {
        activityId: animaSessionRotated?.latestProviderStats?.activityId,
        contextWindow: 200000,
        createdAt: animaSessionRotated?.latestProviderStats?.createdAt,
        currentContextTokens: 2000,
        inputTokens: 20,
        outputTokens: 3,
        runtimeKind: 'codex-cli',
        sessionTokenUsage: 23,
        usedTokens: 23,
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('lifetime token delta uses one terminal stats activity per item', () => {
  assert.equal(tokenDeltaForActivities([
    {
      activityId: 'actv_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        cacheReadInputTokens: 10,
        eventType: 'kimi.context.stats',
        inputTokens: 20,
        outputTokens: 5,
      },
      type: 'runtime.event',
    },
    {
      activityId: 'actv_2',
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: {
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 30,
        eventType: 'kimi.context.stats',
        inputTokens: 40,
        outputTokens: 6,
      },
      type: 'runtime.event',
    },
  ]), 78);
  assert.equal(tokenDeltaForActivities([
    {
      activityId: 'actv_3',
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        eventType: 'claude.session.stats',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 99,
      },
      type: 'runtime.event',
    },
  ]), 99);
});

test('web snapshot includes unfiltered agent queue statuses', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-status-test-'));
  try {
    await writeConfig(stateDir, [
      defaultAgentConfig('anima'),
      defaultAgentConfig('milo'),
    ]);
    await withAnimaHome(stateDir, async () => {
      const running = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-demo',
          teamId: 'T-demo',
          text: 'Run for Milo.',
          ts: '1770000000.000010',
          userId: 'U1',
        }),
        { agentId: 'milo', stateDir },
      );
      await new WakeQueueService('milo').claimNext('worker-1');
      await setActiveRuntimeItem({
        agentId: 'milo',
        startedAt: '2026-05-20T08:00:00.000Z',
        itemId: running.item.id,
        workerId: 'worker-1',
      });
      await new AgentHealthStore({ animaHome: stateDir }).writeHealth({
        agentId: 'milo',
        runtime: {
          activeItemId: running.item.id,
          activeItemStartedAt: '2026-05-20T08:00:00.000Z',
          processId: process.pid,
          providerChildExpected: false,
          workerId: 'worker-1',
        },
        state: 'healthy',
        updatedAt: '2026-05-20T08:00:01.000Z',
      });

      const queued = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-demo',
          teamId: 'T-demo',
          text: 'Queued for Milo.',
          ts: '1770000000.000011',
          userId: 'U1',
        }),
        { agentId: 'milo', stateDir },
      );

      // Activities are agent-scoped — anima activities contain no milo items
      const animaActivityFeed = await activityServiceForAgent('anima').listActivityFeed();
      assert.equal(
        animaActivityFeed.events.some((event) => event.kind === 'inbox' && event.item.id === queued.item.id),
        false,
      );

      // Agent statuses cover all agents regardless of filter
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected API server to listen on a TCP address.');
        }
        const statusesRes = await fetch(`http://127.0.0.1:${address.port}/api/agent-statuses`);
        assert.equal(statusesRes.status, 200);
        const statuses = (await statusesRes.json()) as Array<{
          agentId: string;
          currentItemStartedAt?: string;
          currentItemId?: string;
          queueDepth: number;
          itemCount: number;
        }>;
        assert.deepEqual(statuses.find((s) => s.agentId === 'milo'), {
          agentId: 'milo',
          currentItemStartedAt: '2026-05-20T08:00:00.000Z',
          currentItemId: running.item.id,
          health: {
            runtime: {
              activeItemId: running.item.id,
              activeItemStartedAt: '2026-05-20T08:00:00.000Z',
              processId: process.pid,
              providerChildExpected: false,
              workerId: 'worker-1',
            },
            state: 'healthy',
            updatedAt: '2026-05-20T08:00:01.000Z',
          },
          queueDepth: 1,
          itemCount: 2,
        });
      } finally {
        server.close();
      }
      const miloSession = await agentService('milo').getSession();
      assert.equal(miloSession?.createdAt, running.session.createdAt);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web status marks a running item unhealthy when no live worker identity matches', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-stale-worker-test-'));
  try {
    await writeConfig(stateDir, [
      defaultAgentConfig('milo'),
    ]);
    await withAnimaHome(stateDir, async () => {
      const running = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-demo',
          teamId: 'T-demo',
          text: 'Run for Milo.',
          ts: '1770000000.000012',
          userId: 'U1',
        }),
        { agentId: 'milo', stateDir },
      );
      await new WakeQueueService('milo').claimNext('worker-dead');
      await setActiveRuntimeItem({
        agentId: 'milo',
        startedAt: '2026-05-20T08:00:00.000Z',
        itemId: running.item.id,
        workerId: 'worker-dead',
      });
      await new AgentHealthStore({ animaHome: stateDir }).writeHealth({
        agentId: 'milo',
        runtime: {
          activeItemId: running.item.id,
          activeItemStartedAt: '2026-05-20T08:00:00.000Z',
          processId: process.pid,
          providerChildExpected: false,
          workerId: 'worker-other',
        },
        state: 'healthy',
        updatedAt: '2026-05-20T08:00:01.000Z',
      });

      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected API server to listen on a TCP address.');
        }
        const statusesRes = await fetch(`http://127.0.0.1:${address.port}/api/agent-statuses`);
        assert.equal(statusesRes.status, 200);
        const statuses = (await statusesRes.json()) as Array<{
          agentId: string;
          health?: { reason?: string; state?: string };
        }>;
        const status = statuses.find((s) => s.agentId === 'milo');
        assert.equal(status?.health?.state, 'unhealthy');
        assert.equal(status?.health?.reason, 'stale_running_item');
      } finally {
        server.close();
      }
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web status does not flash stale health for a freshly claimed running item before health publish catches up', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-fresh-running-health-test-'));
  try {
    await writeConfig(stateDir, [
      defaultAgentConfig('milo'),
    ]);
    await withAnimaHome(stateDir, async () => {
      const running = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-demo',
          teamId: 'T-demo',
          text: 'Run for Milo.',
          ts: '1770000000.000013',
          userId: 'U1',
        }),
        { agentId: 'milo', stateDir },
      );
      await new WakeQueueService('milo').claimNext('worker-1');
      await setActiveRuntimeItem({
        agentId: 'milo',
        startedAt: new Date().toISOString(),
        itemId: running.item.id,
        workerId: 'worker-1',
      });
      await new AgentHealthStore({ animaHome: stateDir }).writeHealth({
        agentId: 'milo',
        runtime: {
          processId: process.pid,
          providerChildExpected: false,
          workerId: 'worker-1',
        },
        state: 'healthy',
        updatedAt: new Date().toISOString(),
      });

      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected API server to listen on a TCP address.');
        }
        const statusesRes = await fetch(`http://127.0.0.1:${address.port}/api/agent-statuses`);
        assert.equal(statusesRes.status, 200);
        const statuses = (await statusesRes.json()) as Array<{
          agentId: string;
          currentItemId?: string;
          health?: { reason?: string; state?: string };
        }>;
        const status = statuses.find((s) => s.agentId === 'milo');
        assert.equal(status?.currentItemId, running.item.id);
        assert.equal(status?.health?.state, 'healthy');
        assert.equal(status?.health?.reason, undefined);
      } finally {
        server.close();
      }
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web status does not carry stale failed restart onto healthy agents', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-stale-restart-test-'));
  try {
    await writeConfig(stateDir, [
      defaultAgentConfig('milo'),
    ]);
    await withAnimaHome(stateDir, async () => {
      const healthStore = new AgentHealthStore({ animaHome: stateDir });
      await healthStore.writeHealth({
        agentId: 'milo',
        reason: 'restart_failed',
        restart: {
          completedAt: '2026-06-03T19:30:00.000Z',
          outcome: 'failed',
          reason: 'restart_failed',
          requestId: 'restart-1',
          requestedAt: '2026-06-03T19:29:00.000Z',
        },
        state: 'unhealthy',
        updatedAt: '2026-06-03T19:30:00.000Z',
      });
      await healthStore.writeHealth({
        agentId: 'milo',
        runtime: {
          processId: process.pid,
          providerChildExpected: false,
          workerId: `milo:${process.pid}:healthy`,
        },
        state: 'healthy',
        updatedAt: '2026-06-03T19:31:00.000Z',
      });

      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected API server to listen on a TCP address.');
        }
        const statusesRes = await fetch(`http://127.0.0.1:${address.port}/api/agent-statuses`);
        assert.equal(statusesRes.status, 200);
        const statuses = (await statusesRes.json()) as Array<{
          agentId: string;
          health?: { restart?: { outcome?: string }; state?: string };
        }>;
        const status = statuses.find((s) => s.agentId === 'milo');
        assert.equal(status?.health?.state, 'healthy');
        assert.equal(status?.health?.restart?.outcome, undefined);
      } finally {
        server.close();
      }
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web status surfaces provider failure health reasons', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-provider-health-test-'));
  try {
    await writeConfig(stateDir, [
      defaultAgentConfig('milo'),
    ]);
    await withAnimaHome(stateDir, async () => {
      await new AgentHealthStore({ animaHome: stateDir }).writeHealth({
        agentId: 'milo',
        reason: 'provider_quota_exhausted',
        state: 'unhealthy',
        updatedAt: '2026-06-04T01:20:00.000Z',
      });

      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected API server to listen on a TCP address.');
        }
        const statusesRes = await fetch(`http://127.0.0.1:${address.port}/api/agent-statuses`);
        assert.equal(statusesRes.status, 200);
        const statuses = (await statusesRes.json()) as Array<{
          agentId: string;
          health?: { reason?: string; state?: string };
        }>;
        const status = statuses.find((s) => s.agentId === 'milo');
        assert.equal(status?.health?.state, 'unhealthy');
        assert.equal(status?.health?.reason, 'provider_quota_exhausted');
      } finally {
        server.close();
      }
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('agent diagnostics endpoint returns allowlisted support state without secrets or message bodies', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-diagnostics-test-'));
  try {
    await writeConfig(stateDir, [
      {
        ...defaultAgentConfig('anima'),
        profile: {
          displayName: 'Anima',
          role: 'Do not leak role copy.',
        },
      },
    ]);
    await withAnimaHome(stateDir, async () => {
      await ingestEvent(
        makeSlackEvent({
          channelId: 'D-diag',
          teamId: 'T-demo',
          text: 'Do not leak incoming text.',
          ts: '1770000000.000030',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      await activityServiceForAgent('anima').record({
        payload: {
          command: 'cat /tmp/secret-file',
          error: 'Do not leak tool error.',
          status: 'completed',
          text: 'Do not leak tool text.',
          tool: 'anima.message.send',
        },
        type: 'tool.call.completed',
      });
      await activityServiceForAgent('anima').record({
        payload: {
          error: 'Do not leak runtime error.',
          failureSource: 'provider',
          maxRetries: 1,
          providerReason: 'quota_exhausted',
          reason: 'Do not leak free text reason.',
          retryAttempts: 1,
          retryable: false,
          runtimeKind: 'claude-code',
        },
        type: 'runtime.failed',
      });
      await new AgentHealthStore({ animaHome: stateDir }).writeHealth({
        agentId: 'anima',
        runtime: {
          processId: process.pid,
          providerChild: {
            alive: true,
            command: 'claude --resume /private/raw-command-secret',
            exited: false,
            label: 'claude-code',
            pid: process.pid,
            startedAt: '2026-06-04T08:00:00.000Z',
            stdinWritable: true,
          },
          providerChildExpected: true,
          workerId: 'worker-diagnostics',
        },
        state: 'healthy',
        updatedAt: '2026-06-04T08:00:00.000Z',
      });
      await mkdir(join(stateDir, 'logs'), { recursive: true });
      await writeFile(join(stateDir, 'logs', 'agent.log'), [
        '[2026-06-04T08:01:00.000Z] Agent anima: restart requested requestId=restart-1',
        '[2026-06-04T08:01:01.000Z] Agent anima: provider error xoxb-log-secret',
        '[2026-06-04T08:01:02.000Z] Agent anima: failed payload {"text":"Do not leak log message body.","token":"xoxb-log-payload"}',
        '[2026-06-04T08:01:03.000Z] Agent anima: SLACK_BOT_TOKEN=xoxb-env-secret',
      ].join('\n'), 'utf8');
      await writeFile(join(stateDir, 'logs', 'web.log'), [
        '[2026-06-04T08:01:04.000Z] web: health error for dashboard',
      ].join('\n'), 'utf8');

      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected API server to listen on a TCP address.');
        }
        const diagnosticsRes = await fetch(`http://127.0.0.1:${address.port}/api/agents/anima/diagnostics`);
        assert.equal(diagnosticsRes.status, 200);
        const body = (await diagnosticsRes.json()) as {
          agent?: {
            provider?: Record<string, unknown>;
          };
          logs?: { lines?: Array<{ message?: string }> };
          recentActivity?: Array<Record<string, unknown>>;
          redaction?: { mode?: string };
          status?: {
            health?: {
              runtime?: {
                providerChild?: {
                  command?: string;
                };
              };
              state?: string;
            };
            queueDepth?: number;
          };
        };
        assert.equal(body.redaction?.mode, 'allowlist');
        assert.equal(body.status?.queueDepth, 1);
        assert.equal(body.status?.health?.state, 'healthy');
        assert.equal(body.status?.health?.runtime?.providerChild?.command, 'claude-code');
        assert.equal(body.agent?.provider && 'env' in body.agent.provider, false);
        assert.ok(body.recentActivity?.some((activity) => activity.providerReason === 'quota_exhausted'));
        assert.ok(body.logs?.lines?.some((line) => /restart requested/.test(line.message ?? '')));
        assert.ok((body.logs?.lines?.length ?? 0) <= 80);

        const serialized = JSON.stringify(body);
        assert.doesNotMatch(serialized, /CODEX_SECRET/);
        assert.doesNotMatch(serialized, /runtime-secret-value/);
        assert.doesNotMatch(serialized, /xapp-secret-value/);
        assert.doesNotMatch(serialized, /xoxb-secret-value/);
        assert.doesNotMatch(serialized, /xoxb-log-secret/);
        assert.doesNotMatch(serialized, /xoxb-log-payload/);
        assert.doesNotMatch(serialized, /xoxb-env-secret/);
        assert.doesNotMatch(serialized, /SLACK_BOT_TOKEN/);
        assert.doesNotMatch(serialized, /Do not leak incoming text/);
        assert.doesNotMatch(serialized, /Do not leak tool text/);
        assert.doesNotMatch(serialized, /Do not leak tool error/);
        assert.doesNotMatch(serialized, /Do not leak runtime error/);
        assert.doesNotMatch(serialized, /Do not leak free text reason/);
        assert.doesNotMatch(serialized, /Do not leak log message body/);
        assert.doesNotMatch(serialized, /Do not leak role copy/);
        assert.doesNotMatch(serialized, /cat \/tmp\/secret-file/);
        assert.doesNotMatch(serialized, /raw-command-secret/);
        assert.doesNotMatch(serialized, /claude --resume/);
      } finally {
        server.close();
      }
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web API stop endpoint writes stopRequestedAt onto the item record', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-stop-test-'));
  await writeConfig(stateDir);
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
  await writeConfig(stateDir);
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
  await writeConfig(stateDir);
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
  await writeConfig(stateDir, [{ ...defaultAgentConfig('anima'), enabled: false }]);
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
  await writeConfig(stateDir);
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
        .flatMap((event) => event.kind === 'activity' ? [event.activity] : [])
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
  await writeConfig(stateDir);
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

test('web API serves the web app and agents API', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-server-test-'));
  await writeConfig(stateDir);
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
      const statusesBody = (await statusesRes.json()) as Array<{ agentId: string }>;
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
      assert.deepEqual(await orderRead.json(), { sidebarOrder: { agents: ['anima'], kbs: ['team'] } });

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
    await writeConfig(stateDir);
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

test('web API validates Slack tokens with structured reasons before persisting', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-slack-validate-test-'));
  const slackApi = await startSlackApiMock((method, body, request) => {
    const token = bearerToken(request) || slackRequestBody(body)['token'] || '';
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
    await writeConfig(stateDir, [
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
    const token = bearerToken(request) || slackRequestBody(body)['token'] || '';
    if (method === 'apps.connections.open') {
      return { ok: true, url: 'wss://socket.example.test/' };
    }
    if (method === 'auth.test') {
      const scopes = token.includes('with-commands') ? 'chat:write,commands,users:read' : 'chat:write,users:read';
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
    await writeConfig(stateDir, [
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
  const slackCalls: Array<{ body: Record<string, string>; method: string }> = [];
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
    await writeConfig(stateDir, [{ ...defaultAgentConfig('anima'), homePath: homeDir }]);
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
    await writeConfig(stateDir, [{ ...defaultAgentConfig('anima'), homePath: homeDir }]);
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
    await writeConfig(stateDir, [{ ...defaultAgentConfig('anima'), homePath: homeDir }]);
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
  const slackCalls: Array<{ body: Record<string, string>; method: string }> = [];
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
    await writeConfig(stateDir, [
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
  const slackCalls: Array<{ body: Record<string, string>; method: string }> = [];
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
    await writeConfig(stateDir, [
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
    await writeConfig(stateDir, [
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

test('web API reports provider availability', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-provider-availability-test-'));
  await writeConfig(stateDir);
  await withAnimaHome(stateDir, async () => {
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/provider-availability`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { providers: Array<{ authed?: unknown; kind: string; present: unknown }> };
      assert.deepEqual(body.providers.map((provider) => provider.kind).sort(), ['claude-code', 'codex-cli', 'kimi-cli']);
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

test('server-info exposes the last standalone restart result for UI echoes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-last-restart-test-'));
  await writeConfig(stateDir);
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
  await writeConfig(stateDir);
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
      assert.deepEqual(body.lastRestart?.blockers?.map((blocker) => ({
        agentId: blocker.agentId,
        itemId: blocker.itemId,
        status: blocker.status,
      })), [
        { agentId: 'runner', itemId: 'item_running', status: 'running' },
      ]);
      assert.equal(body.lastRestart?.logPath, join(stateDir, 'logs', 'services-restart.log'));
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API exposes Slack manifest install links without secrets', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-slack-install-test-'));
  await writeConfig(stateDir, [
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
      assert.match(url.searchParams.get('manifest_yaml') ?? '', /display_name: Lens/);
    } finally {
      server.close();
    }
  });
  await rm(stateDir, { force: true, recursive: true });
});

test('web API stamps and exposes createdAt through create response and snapshot', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-created-at-test-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-web-api-created-at-home-'));
  await writeConfig(stateDir);
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

test('dashboard auth protects dashboard APIs and static app while leaving health checks public', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-dashboard-auth-test-'));
  const kbRepoDir = await mkdtemp(join(tmpdir(), 'anima-dashboard-auth-kb-'));
  try {
    await writeConfig(stateDir);
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
        const unauthenticatedBody = (await unauthenticatedAgents.json()) as { error?: string };
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

        const badLogin = await postJson(`${base}/api/auth/login`, { password: 'wrong password' });
        await assertStatus(badLogin, 401, 'bad login');
        assert.equal(badLogin.headers.get('set-cookie')?.includes('Max-Age=0'), true);

        const goodLogin = await postJson(`${base}/api/auth/login`, { password: 'correct horse battery staple' });
        await assertStatus(goodLogin, 200, 'good login');
        const sessionCookie = goodLogin.headers.get('set-cookie')?.split(';')[0];
        assert.ok(sessionCookie?.startsWith('anima_dashboard_session='));
        if (!sessionCookie) throw new Error('Expected dashboard auth session cookie');

        await assertStatus(
          await fetch(`${base}/api/agents`, { headers: { cookie: sessionCookie } }),
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

function defaultAgentConfig(id: string) {
  return {
    id,
    provider: {
      env: {
        CODEX_SECRET: 'runtime-secret-value',
      },
      kind: 'codex-cli',
      model: 'gpt-5.2-codex',
      reasoningEffort: 'high',
    },
    slack: {
      appToken: 'xapp-secret-value',
      botToken: 'xoxb-secret-value',
    },
  };
}

function testRuntime() {
  return { kind: 'codex-cli', model: 'gpt-5.5', reasoningEffort: 'medium' };
}

type TestAgentConfig = Omit<ReturnType<typeof defaultAgentConfig>, 'slack'> & {
  enabled?: boolean;
  homePath?: string;
  profile?: { displayName?: string; role?: string };
  slack?: ReturnType<typeof defaultAgentConfig>['slack'] & { appId?: string; manifestVersion?: number; teamId?: string };
};

async function writeConfig(configDir: string, agents: TestAgentConfig[] = [defaultAgentConfig('anima')]): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  for (const agent of agents) {
    const agentDir = join(configDir, 'agents', agent.id);
    const homePath = agent.homePath ?? join(configDir, 'agent-homes', agent.id);
    await mkdir(homePath, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'config.json'), `${JSON.stringify({ ...agent, homePath }, null, 2)}\n`, 'utf8');
  }
}

type SlackApiMockResponse = object | { body: object; headers?: Record<string, string> };

async function startSlackApiMock(
  handler: (method: string, body: string, request: IncomingMessage) => SlackApiMockResponse,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const method = pathname.replace(/^\/api\//, '');
      const result = handler(method, body, request);
      const payload = isMockResponseWithHeaders(result) ? result.body : result;
      response.writeHead(200, {
        'content-type': 'application/json',
        ...(isMockResponseWithHeaders(result) ? result.headers : {}),
      });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ok: false }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected Slack API mock to listen on a TCP address.');
  }
  return {
    close: async () => {
      server.close();
      await once(server, 'close');
    },
    url: `http://127.0.0.1:${address.port}/api`,
  };
}

function isMockResponseWithHeaders(value: SlackApiMockResponse): value is { body: object; headers?: Record<string, string> } {
  return 'body' in value && typeof value.body === 'object';
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

async function assertStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status === expected) return;
  const body = await response.clone().text().catch((error: unknown) => `failed to read body: ${String(error)}`);
  assert.equal(response.status, expected, `${label} returned ${response.status}: ${body}`);
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
}

function slackRequestBody(body: string): Record<string, string> {
  try {
    return JSON.parse(body) as Record<string, string>;
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}
