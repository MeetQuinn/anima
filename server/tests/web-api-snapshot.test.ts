import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { defaultAgentConfig, writeAgentConfigs } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactAgentConfig } from '../agents/agent-config-ops.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { createWebServer } from '../web/app.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { recordRuntimeActivity, recordRuntimeEvent } from '../runtime/activity.js';
import { AgentHealthStore } from '../runtime/agent-health.store.js';
import { AgentHealthService } from '../runtime/agent-health.service.js';
import { setActiveRuntimeItem } from '../runtime/active-item.js';
import { recordLifetimeTokenUsageForItem, tokenDeltaForActivities } from '../runtime/usage.js';
import type { AgentActivityFeedPage } from '../../shared/activity.js';
import { withAnimaHome } from './anima-home.js';
import { agentService, writeActivityJsonl, webApiTestActivity, activityFeedReferencePages } from './helpers/web-api.js';

test('web snapshot summarizes state without exposing secrets', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-test-'));
  try {
    await writeAgentConfigs(stateDir);
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
      await recordRuntimeEvent({ agentId: 'anima', itemId: ctx.item.id }, 'codex-cli', undefined, {
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
      assert.equal(agentConfig.provider?.model, 'gpt-5.5');
      assert.ok(agentConfig.provider && 'reasoningEffort' in agentConfig.provider);
      assert.equal(agentConfig.provider.reasoningEffort, 'high');
      assert.equal(agentConfig.slack?.appToken, '');
      assert.equal(agentConfig.slack?.botToken, '');
      assert.equal(agentConfig.slack?.connected, true);
      assert.deepEqual(animaSession?.latestProviderStats, {
        activityId: animaSession?.latestProviderStats?.activityId,
        autoCompactWindow: 240000,
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

      // Activities are now a separate call and do not carry the inbound wake
      // queue; conversation rows are served by /messages.
      const activityFeed = await activityServiceForAgent('anima').listActivityFeed();
      assert.equal(
        activityFeed.events.some((event) => event.type === 'tool.call.completed'),
        true,
      );
      assert.deepEqual(Object.keys(activityFeed).sort(), ['events', 'nextCursor']);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('activity feed pages activity events without wake queue items', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-activity-feed-page-test-'));
  try {
    await writeAgentConfigs(stateDir);
    await withAnimaHome(stateDir, async () => {
      await ingestEvent(
        makeSlackEvent({
          channelId: 'D-demo',
          teamId: 'T-demo',
          text: 'First',
          ts: '1770000000.000001',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      const service = activityServiceForAgent('anima');
      const first = await service.record({
        createdAt: '2026-07-04T00:00:00.000Z',
        type: 'runtime.started',
      });
      const second = await service.record({
        createdAt: '2026-07-04T00:00:01.000Z',
        type: 'runtime.completed',
      });
      const third = await service.record({
        createdAt: '2026-07-04T00:00:02.000Z',
        type: 'runtime.started',
      });

      const page = await service.listActivityFeed({ limit: 2 });
      assert.equal(page.events.length, 2);
      assert.deepEqual(
        page.events.map((event) => event.activityId),
        [second.activityId, third.activityId],
      );
      assert.ok(page.nextCursor);
      assert.equal(
        page.events.some((event) => event.activityId === first.activityId),
        false,
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('activity feed cursor pagination matches readAll reference across archives', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-activity-feed-archive-page-test-'));
  try {
    await writeAgentConfigs(stateDir);
    await withAnimaHome(stateDir, async () => {
      const agentDir = join(stateDir, 'agents/anima');
      const archiveDir = join(agentDir, 'activity.archive');
      await mkdir(archiveDir, { recursive: true });

      const activities = [
        webApiTestActivity('archived-oldest', '2026-07-04T00:00:00.000Z'),
        webApiTestActivity('archived-before-cursor', '2026-07-04T00:00:01.000Z'),
        webApiTestActivity('archived-tie-skipped', '2026-07-04T00:00:03.000Z'),
        webApiTestActivity('archived-tie-cursor', '2026-07-04T00:00:03.000Z'),
        webApiTestActivity('archived-newer', '2026-07-04T00:00:04.000Z'),
        webApiTestActivity('live-newer', '2026-07-04T00:00:05.000Z'),
      ];
      await writeActivityJsonl(join(archiveDir, '0000000000001-activity-000.jsonl'), activities.slice(0, 3));
      await writeActivityJsonl(join(archiveDir, '0000000000002-activity-000.jsonl'), activities.slice(3, 5));
      await writeActivityJsonl(join(agentDir, 'activity.jsonl'), activities.slice(5));

      const service = activityServiceForAgent('anima');
      const actualPages: AgentActivityFeedPage[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.listActivityFeed({ before: cursor, limit: 3 });
        actualPages.push(page);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      assert.deepEqual(actualPages, activityFeedReferencePages(await service.readAll(), 3));
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('web snapshot includes Claude auto-compact threshold with provider stats', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-claude-stats-test-'));
  try {
    await writeAgentConfigs(stateDir, [
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
    await writeAgentConfigs(stateDir, [
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
    await writeAgentConfigs(stateDir);
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
      await recordRuntimeEvent({ agentId: 'anima', itemId: ctx.item.id }, 'codex-cli', undefined, {
        cacheReadInputTokens: 20,
        eventType: 'codex.session.stats',
        inputTokens: 100,
        outputTokens: 5,
        runtimeKind: 'codex-cli',
      });
      await recordRuntimeActivity({ agentId: 'anima', itemId: ctx.item.id }, 'codex-cli', 'runtime.completed');
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
    await writeAgentConfigs(stateDir);
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
        autoCompactWindow: 240000,
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

test('web snapshot includes active wake queue statuses', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-status-test-'));
  try {
    await writeAgentConfigs(stateDir, [
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
      await new WakeQueueService('milo').takeNextRunnable({ isWorkerAlive: () => true, workerId: 'worker-1' });
      await setActiveRuntimeItem({
        agentId: 'milo',
        startedAt: '2026-05-20T08:00:00.000Z',
        itemId: running.item.id,
        workerId: 'worker-1',
      });
      await new AgentHealthService(new AgentHealthStore({ animaHome: stateDir })).writeHealth({
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

      await ingestEvent(
        makeSlackEvent({
          channelId: 'C-demo',
          teamId: 'T-demo',
          text: 'Queued for Milo.',
          ts: '1770000000.000011',
          userId: 'U1',
        }),
        { agentId: 'milo', stateDir },
      );

      // Activities are agent-scoped and do not include Milo's active wake queue.
      const animaActivityFeed = await activityServiceForAgent('anima').listActivityFeed();
      assert.equal(animaActivityFeed.events.length, 0);

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
    await writeAgentConfigs(stateDir, [
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
      await new WakeQueueService('milo').takeNextRunnable({ isWorkerAlive: () => true, workerId: 'worker-dead' });
      await setActiveRuntimeItem({
        agentId: 'milo',
        startedAt: '2026-05-20T08:00:00.000Z',
        itemId: running.item.id,
        workerId: 'worker-dead',
      });
      await new AgentHealthService(new AgentHealthStore({ animaHome: stateDir })).writeHealth({
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
    await writeAgentConfigs(stateDir, [
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
      await new WakeQueueService('milo').takeNextRunnable({ isWorkerAlive: () => true, workerId: 'worker-1' });
      await setActiveRuntimeItem({
        agentId: 'milo',
        startedAt: new Date().toISOString(),
        itemId: running.item.id,
        workerId: 'worker-1',
      });
      await new AgentHealthService(new AgentHealthStore({ animaHome: stateDir })).writeHealth({
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
    await writeAgentConfigs(stateDir, [
      defaultAgentConfig('milo'),
    ]);
    await withAnimaHome(stateDir, async () => {
      const healthStore = new AgentHealthService(new AgentHealthStore({ animaHome: stateDir }));
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
    await writeAgentConfigs(stateDir, [
      defaultAgentConfig('milo'),
    ]);
    await withAnimaHome(stateDir, async () => {
      await new AgentHealthService(new AgentHealthStore({ animaHome: stateDir })).writeHealth({
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
    await writeAgentConfigs(stateDir, [
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
      await new AgentHealthService(new AgentHealthStore({ animaHome: stateDir })).writeHealth({
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
