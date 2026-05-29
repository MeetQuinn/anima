import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { redactAgentConfig } from '../server/agents/agent-config-ops.js';
import { activityServiceForAgent } from '../server/activities/activity.service.js';
import { createWebServer } from '../server/web/app.js';
import { defaultAgentRegistryService } from '../server/agents/agent.service.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { WakeQueueService } from '../server/inbox/wake-queue.service.js';
import { recordRuntimeEvent } from '../server/runtime/activity.js';
import { persistProviderSession } from '../server/runtime/runtime-bridge.js';
import { setActiveRuntimeItem } from '../server/runtime/active-item.js';
import { recordLifetimeTokenUsageForItem, tokenDeltaForActivities } from '../server/runtime/usage.js';
import { CURRENT_SLACK_MANIFEST_VERSION } from '../shared/slack-manifest.js';
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
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-agent-operator-test-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-web-api-agent-operator-home-'));
  const slackCalls: Array<{ body: Record<string, string>; method: string }> = [];
  const slackApi = await startSlackApiMock((method, body) => {
    slackCalls.push({ method, body: slackRequestBody(body) });
    if (method === 'users.list') {
      return {
        ok: true,
        members: [
          {
            id: 'U-operator',
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
    if (method === 'conversations.open') return { ok: true, channel: { id: 'D-operator' } };
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
        assert.deepEqual(usersBody.users.map((user) => user.slackUserId), ['U-operator']);

        const setOwner = await fetch(`${base}/api/agents/anima/slack/owner`, {
          body: JSON.stringify({ slackUserId: 'U-operator' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        assert.equal(setOwner.status, 200);
        const setOwnerBody = (await setOwner.json()) as {
          owner?: { displayName?: string; handle?: string; onboardingPromptedAt?: string; slackUserId?: string };
        };
        assert.equal(setOwnerBody.owner?.slackUserId, 'U-operator');
        assert.equal(setOwnerBody.owner?.displayName, 'Iris');
        assert.equal(setOwnerBody.owner?.handle, 'iris');
        assert.match(setOwnerBody.owner?.onboardingPromptedAt ?? '', /^\d{4}-/);

        const items = await new WakeQueueService('anima').list();
        const onboarding = items.find((item) => item.id === 'agent-onboarding:anima:U-operator');
        assert.equal(onboarding?.kind, 'onboarding');
        assert.equal(onboarding?.kind === 'onboarding' ? onboarding.channelId : undefined, 'D-operator');
        assert.equal(onboarding?.kind === 'onboarding' ? onboarding.teamId : undefined, 'T-demo');
        assert.equal(onboarding?.kind === 'onboarding' ? onboarding.operator.slackUserId : undefined, 'U-operator');
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /<@U-operator>/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /You've been set up here/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /Your owner is Iris/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /MEMORY\.md/);
        assert.match(onboarding?.kind === 'onboarding' ? onboarding.text : '', /introduce yourself to Iris/);

        const openCalls = slackCalls.filter((call) => call.method === 'conversations.open');
        assert.deepEqual(openCalls.map((call) => call.body['users']), ['U-operator']);
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
