import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';

import { makeSlackEvent } from './helpers/slack.js';
import { slackSurfaceForEvent } from '../inbox/slack-events.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { ingestEvent } from './helpers/inbox.js';
import { loadState } from './helpers/state.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { isFirstClassAnimaCliCommand } from '../activities/format.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { startChildProcess, terminateChildProcess } from '../providers/child-process.js';
import { clearRestartDrain, requestRestartDrain } from '../services/restart-drain.js';
import { recordRuntimeEvent } from '../runtime/activity.js';
import { AgentHealthStore } from '../runtime/agent-health.store.js';
import { AgentHealthService } from '../runtime/agent-health.service.js';
import { AgentRestartCommandStore } from '../runtime/agent-restart-command.store.js';
import { managedProviderEnvForAgent, RuntimeHost, type RunningAgentHandle } from '../runtime/host.js';
import { RuntimeSessionService } from '../runtime/runtime-session.service.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import { withAnimaHome } from './anima-home.js';
import type { Activity } from '../../shared/activity.js';
import type { InboxItem } from '../../shared/inbox.js';
import { sleep } from './helpers/harness.js';
import { SecretHandoffPendingStore } from '../env/secret-handoff-store.js';
import { SealedSecretHandoffPendingStore } from '../env/sealed-secret-handoff-store.js';
import { createHandoffKeyPair, createHandoffRequest } from '../../shared/secret-handoff.js';

// Several RuntimeHost tests reach the health and restart stores through
// reconcileOnce(), which - unlike start() - does not provision. They used to
// work because the first write recursively created the home for them. Writes no
// longer do that (#461), so the fixture provisions its own home, deliberately.
//
// A fresh mkdtemp per run, removed after: the literal /tmp/anima-home these
// tests used to share was never created and never cleaned, so a run inherited
// whatever health and restart state the previous run had left in it, and passed
// locally for the same reason the bug existed - a directory that was there
// because something had once written to it.
let testHome: string;
before(async () => {
  testHome = await mkdtemp(join(tmpdir(), 'anima-runtime-host-home-'));
});
after(async () => {
  await rm(testHome, { force: true, recursive: true });
});

test('child process completion preserves exit details when stream effects fail', async () => {
  const child = startChildProcess({
    args: ['-e', 'process.stdout.write("payload"); process.stderr.write("boom"); process.exit(7);'],
    command: process.execPath,
    env: process.env,
    label: 'test child',
    onStdoutChunk: async () => {
      throw new Error('callback parse failed');
    },
  });

  await assert.rejects(child.completion, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /test child exited with code 7/);
    assert.match(message, /stderr: boom/);
    assert.match(message, /stdout: payload/);
    assert.match(message, /stream effect failed: callback parse failed/);
    return true;
  });
});

test('child process termination escalates from SIGTERM to SIGKILL', async () => {
  let ready!: () => void;
  const childReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const child = startChildProcess({
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
    ],
    bufferOutput: false,
    command: process.execPath,
    env: process.env,
    label: 'stubborn child',
    onStdoutChunk: async (chunk) => {
      if (chunk.includes('ready')) ready();
    },
  });

  await childReady;
  const startedAt = Date.now();
  const result = await terminateChildProcess(child, { forceAfterMs: 50 });

  assert.equal(result.forced, true);
  assert.ok(Date.now() - startedAt < 1_000, 'termination should not wait for the ignored SIGTERM forever');
});

test('first-class anima CLI command detection covers plain agent-facing tools', () => {
  assert.equal(isFirstClassAnimaCliCommand('anima ask --question "Pick" --option A --option B'), true);
  assert.equal(isFirstClassAnimaCliCommand('ANIMA_AGENT_ID=scout anima reminder list'), true);
  assert.equal(isFirstClassAnimaCliCommand('anima env set SERVICE_TOKEN --secret'), true);
  assert.equal(isFirstClassAnimaCliCommand('ANIMA_AGENT_ID=scout anima env run --keys SERVICE_TOKEN -- node script.js'), true);
  assert.equal(isFirstClassAnimaCliCommand('anima subscription mute --channel C123'), true);
  assert.equal(isFirstClassAnimaCliCommand('anima message send --channel C123'), true);
  assert.equal(isFirstClassAnimaCliCommand('cd ~/anima && ANIMA_AGENT_ID=scout anima ask --question "Pick"'), false);
});

test('runtime host startup reconciliation deletes expired handoff private keys', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-handoff-cleanup-'));
  try {
    const keys = createHandoffKeyPair();
    const pending = new SecretHandoffPendingStore('alpha', stateDir);
    const request = createHandoffRequest({
      recipientAgentId: 'alpha',
      targetKey: 'SERVICE_TOKEN',
      purpose: 'Expired runtime cleanup fixture',
      sender: { kind: 'agent', agentId: 'bravo' },
      now: new Date(Date.now() - 2 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      publicKey: keys.publicKey,
    });
    await pending.create(request, keys.privateKey);
    const path = pending.pendingPath(request.requestId);
    const sealed = new SealedSecretHandoffPendingStore('alpha', stateDir);
    const sealedId = await sealed.create(
      keys.publicKey,
      keys.privateKey,
      new Date(Date.now() - 60 * 60 * 1000),
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );
    const sealedPath = sealed.pendingPath(sealedId);
    assert.equal((await stat(path)).isFile(), true);
    assert.equal((await stat(sealedPath)).isFile(), true);

    const host = new RuntimeHost({}, {
      animaHome: stateDir,
      ensureDefaultSkills: async () => {},
      loadAgents: async () => [runtimeHostAgent('alpha', { connected: false, enabled: false })],
      logger: silentLogger,
      validateAgent: async () => {},
    });
    await host.reconcileOnce();

    await assert.rejects(() => stat(path), /ENOENT/);
    await assert.rejects(() => stat(sealedPath), /ENOENT/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('recordRuntimeEvent skips runtime stats updates for noise events', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-activity-noise-'));
  const updateRuntimeStats = mock.method(
    RuntimeSessionService.prototype,
    'updateRuntimeStats',
    async () => undefined,
  );
  try {
    await withAnimaHome(stateDir, async () => {
      await recordRuntimeEvent({ agentId: 'anima' }, 'claude-code', undefined, {
        eventType: 'claude.stream.content.delta',
        text: 'token',
      });

      assert.equal(updateRuntimeStats.mock.callCount(), 0);
    });
  } finally {
    updateRuntimeStats.mock.restore();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('recordRuntimeEvent updates runtime stats for session stats events', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-runtime-activity-stats-'));
  const updateRuntimeStats = mock.method(
    RuntimeSessionService.prototype,
    'updateRuntimeStats',
    async () => undefined,
  );
  try {
    await withAnimaHome(stateDir, async () => {
      await recordRuntimeEvent({ agentId: 'anima' }, 'codex-cli', undefined, {
        eventType: 'codex.session.stats',
        inputTokens: 12,
        outputTokens: 3,
      });

      assert.equal(updateRuntimeStats.mock.callCount(), 1);
      const call = updateRuntimeStats.mock.calls[0];
      assert.ok(call);
      assert.equal(call.arguments[0], 'codex-cli');
      const activity = call.arguments[2];
      assert.ok(activity);
      assert.ok(activity.payload);
      assert.equal(activity.payload.eventType, 'codex.session.stats');
    });
  } finally {
    updateRuntimeStats.mock.restore();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime host idles with zero agents and starts a newly runnable agent once', async () => {
  let agents: AgentConfig[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => agents,
    logger: silentLogger,
    startAgent: async (agent) => {
      started.push(agent.id);
      return stopHandle(agent.id, stopped);
    },
    validateAgent: async () => {},
  });

  await host.reconcileOnce();
  assert.deepEqual(started, []);
  assert.deepEqual(host.runningAgentIds(), []);

  agents = [runtimeHostAgent('aria', { connected: true })];
  await host.reconcileOnce();
  await host.reconcileOnce();

  assert.deepEqual(started, ['aria']);
  assert.deepEqual(host.runningAgentIds(), ['aria']);
  await host.stop();
  assert.deepEqual(stopped, ['aria']);
});

test('runtime host reconciles memory coherence scheduler after agent reconciliation', async () => {
  const agents = [runtimeHostAgent('aria', { connected: true })];
  const scheduled: string[][] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => agents,
    logger: silentLogger,
    memoryCoherenceScheduler: {
      reconcile: async (runtimeAgents) => {
        scheduled.push(runtimeAgents.map((agent) => agent.id));
      },
    },
    startAgent: async (agent) => stopHandle(agent.id, []),
    validateAgent: async () => {},
  });

  await host.reconcileOnce();

  assert.deepEqual(scheduled, [['aria']]);
  await host.stop();
});

test('runtime host contains memory coherence scheduler failures', async () => {
  const errors: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => [runtimeHostAgent('aria', { connected: true })],
    logger: {
      error(message) {
        errors.push(String(message));
      },
      log() {},
    },
    memoryCoherenceScheduler: {
      reconcile: async () => {
        throw new Error('scheduler down');
      },
    },
    startAgent: async (agent) => stopHandle(agent.id, []),
    validateAgent: async () => {},
  });

  await host.reconcileOnce();

  assert.deepEqual(host.runningAgentIds(), ['aria']);
  assert.equal(errors.some((message) => message.includes('Memory coherence scheduler reconcile failed')), true);
  await host.stop();
});

test('runtime host starts after Slack connection and reloads idle agents after config changes', async () => {
  let scout = runtimeHostAgent('scout', { connected: false });
  const started: string[] = [];
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => [scout],
    logger: silentLogger,
    startAgent: async (agent) => {
      started.push(`${agent.id}:${agent.homePath}:${agent.provider.model ?? ''}:${agent.profile.role}`);
      return stopHandle(agent.id, stopped);
    },
    validateAgent: async () => {},
  });

  await host.reconcileOnce();
  assert.deepEqual(started, []);

  scout = runtimeHostAgent('scout', { connected: true, homePath: '/tmp/home-a', model: 'opus' });
  await host.reconcileOnce();
  assert.deepEqual(started, ['scout:/tmp/home-a:opus:general purpose']);

  scout = runtimeHostAgent('scout', { connected: true, homePath: '/tmp/home-a', model: 'opus', role: 'research lead' });
  await host.reconcileOnce();
  assert.deepEqual(stopped, ['scout']);
  assert.deepEqual(started, [
    'scout:/tmp/home-a:opus:general purpose',
    'scout:/tmp/home-a:opus:research lead',
  ]);

  scout = runtimeHostAgent('scout', { connected: true, homePath: '/tmp/home-b', model: 'sonnet', role: 'research lead' });
  await host.reconcileOnce();
  await host.reconcileOnce();
  assert.deepEqual(stopped, ['scout', 'scout']);
  assert.deepEqual(started, [
    'scout:/tmp/home-a:opus:general purpose',
    'scout:/tmp/home-a:opus:research lead',
    'scout:/tmp/home-b:sonnet:research lead',
  ]);
  assert.deepEqual(host.runningAgentIds(), ['scout']);

  await host.stop();
});

test('runtime host refreshes Slack display info before starting an agent', async () => {
  const scout = runtimeHostAgent('scout', { connected: true });
  const started: string[] = [];
  const synced: string[] = [];
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => [scout],
    logger: silentLogger,
    startAgent: async (agent) => {
      started.push(`${agent.id}:${agent.slack.botHandle ?? ''}:${agent.slack.botUserId ?? ''}`);
      return stopHandle(agent.id, stopped);
    },
    syncSlackDisplayInfo: async (agent) => {
      synced.push(agent.id);
      return {
        ...agent,
        slack: {
          ...agent.slack,
          avatarUrl: 'https://example.test/fresh-bot.png',
          botHandle: 'fresh-scout',
          botName: 'Fresh Scout',
          botProfileSyncedAt: '2026-07-04T00:00:00.000Z',
          botUserId: 'U-FRESH-SCOUT',
        },
      };
    },
    validateAgent: async () => {},
  });

  await host.reconcileOnce();
  await host.reconcileOnce();

  assert.deepEqual(synced, ['scout']);
  assert.deepEqual(started, ['scout:fresh-scout:U-FRESH-SCOUT']);
  await host.stop();
  assert.deepEqual(stopped, ['scout']);
});

test('runtime host does not block startup when Slack display-info refresh fails', async () => {
  const errors: string[] = [];
  const started: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => [runtimeHostAgent('scout', { connected: true })],
    logger: {
      error(message) {
        errors.push(String(message));
      },
      log() {},
    },
    startAgent: async (agent) => {
      started.push(agent.id);
      return stopHandle(agent.id, []);
    },
    syncSlackDisplayInfo: async () => {
      throw new Error('Slack profile temporarily unavailable');
    },
    validateAgent: async () => {},
  });

  await host.reconcileOnce();

  assert.deepEqual(started, ['scout']);
  assert.equal(errors.some((message) => message.includes('Slack display-info sync failed before runtime start')), true);
  await host.stop();
});

test('runtime host starts Feishu-connected agents without Slack tokens', async () => {
  const scout = runtimeHostAgent('scout', { connected: false, feishuConnected: true });
  const started: string[] = [];
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => [scout],
    logger: silentLogger,
    startAgent: async (agent) => {
      started.push(agent.id);
      return stopHandle(agent.id, stopped);
    },
    validateAgent: async () => {},
  });

  await host.reconcileOnce();
  await host.reconcileOnce();

  assert.deepEqual(started, ['scout']);
  assert.deepEqual(host.runningAgentIds(), ['scout']);

  await host.stop();
  assert.deepEqual(stopped, ['scout']);
});

test('managed provider env injects Feishu credentials and tenant token when connected', async () => {
  const scout = runtimeHostAgent('scout', { connected: true });
  scout.feishu = {
    appId: 'cli_test',
    appSecret: 'feishu-secret',
    botOpenId: 'ou_bot',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };

  const env = await managedProviderEnvForAgent(scout, testHome, 'xoxb-test', {
    async fetchFeishuTenantAccessToken(config) {
      assert.equal(config.appId, 'cli_test');
      assert.equal(config.appSecret, 'feishu-secret');
      return {
        expiresAt: '2026-06-03T01:00:00.000Z',
        tenantAccessToken: 't-tenant',
      };
    },
  });

  assert.equal(env.ANIMA_HOME, testHome);
  assert.equal(env.SLACK_BOT_TOKEN, 'xoxb-test');
  assert.equal(env.FEISHU_API_BASE_URL, 'https://open.feishu.cn/open-apis');
  assert.equal(env.FEISHU_APP_ID, 'cli_test');
  assert.equal(env.FEISHU_APP_SECRET, 'feishu-secret');
  assert.equal(env.FEISHU_BOT_OPEN_ID, 'ou_bot');
  assert.equal(env.FEISHU_TENANT_ACCESS_TOKEN, 't-tenant');
  assert.equal(env.FEISHU_TENANT_ACCESS_TOKEN_EXPIRES_AT, '2026-06-03T01:00:00.000Z');
});

test('managed provider env omits Slack tokens when no Slack bot token is configured', async () => {
  const scout = runtimeHostAgent('scout', { connected: false, feishuConnected: true });
  const env = await managedProviderEnvForAgent(scout, testHome, undefined, {
    async fetchFeishuTenantAccessToken() {
      return { tenantAccessToken: 't-tenant' };
    },
  });

  assert.equal(env.ANIMA_HOME, testHome);
  assert.equal(env.ANIMA_RUNTIME_HOME, testHome);
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  assert.equal(env.ANIMA_SLACK_BOT_TOKEN, undefined);
  assert.equal(env.FEISHU_TENANT_ACCESS_TOKEN, 't-tenant');
});

test('runtime host defers config reload until the running agent is idle', async () => {
  let scout = runtimeHostAgent('scout', { connected: true, homePath: '/tmp/home-a', model: 'opus' });
  let active = false;
  const started: string[] = [];
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => [scout],
    logger: silentLogger,
    startAgent: async (agent) => {
      started.push(`${agent.id}:${agent.homePath}:${agent.provider.model ?? ''}`);
      return stopHandle(agent.id, stopped, () => active);
    },
    validateAgent: async () => {},
  });

  await host.reconcileOnce();
  assert.deepEqual(started, ['scout:/tmp/home-a:opus']);

  active = true;
  scout = runtimeHostAgent('scout', { connected: true, homePath: '/tmp/home-b', model: 'sonnet' });
  await host.reconcileOnce();
  await host.reconcileOnce();
  assert.deepEqual(stopped, []);
  assert.deepEqual(started, ['scout:/tmp/home-a:opus']);
  assert.deepEqual(host.runningAgentIds(), ['scout']);

  active = false;
  await host.reconcileOnce();
  assert.deepEqual(stopped, ['scout']);
  assert.deepEqual(started, ['scout:/tmp/home-a:opus', 'scout:/tmp/home-b:sonnet']);

  await host.stop();
});

test('runtime host bounds idle config reload shutdown with a force timeout', async () => {
  let scout = runtimeHostAgent('scout', { connected: true, homePath: '/tmp/home-a', model: 'opus' });
  const stopped: string[] = [];
  const stopOptions: Array<Parameters<RunningAgentHandle['stop']>[0]> = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    forceRestartTimeoutMs: 123,
    loadAgents: async () => [scout],
    logger: silentLogger,
    startAgent: async (agent) => stopHandle(agent.id, stopped, undefined, (options) => {
      stopOptions.push(options);
    }),
    validateAgent: async () => {},
  });

  await host.reconcileOnce();
  scout = runtimeHostAgent('scout', { connected: true, homePath: '/tmp/home-b', model: 'opus' });
  await host.reconcileOnce();

  assert.deepEqual(stopped, ['scout']);
  assert.deepEqual(stopOptions[0], { drainActive: true, forceAfterMs: 123 });

  await host.stop();
});

test('runtime host uses restart-drain aborts while the restart drain marker is active', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-host-restart-drain-stop-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await requestRestartDrain(60_000);
      const stopOptions: Array<Parameters<RunningAgentHandle['stop']>[0]> = [];
      const host = new RuntimeHost({}, {
        animaHome: stateDir,
        forceRestartTimeoutMs: 123,
        loadAgents: async () => [runtimeHostAgent('scout', { connected: true })],
        logger: silentLogger,
        startAgent: async (agent) => stopHandle(agent.id, [], undefined, (options) => {
          stopOptions.push(options);
        }),
        validateAgent: async () => {},
      });

      await host.reconcileOnce();
      await host.stop();

      assert.deepEqual(stopOptions, [{ abortReason: 'restart_drain', forceAfterMs: 123 }]);
      await clearRestartDrain();
    });
  } finally {
    await withAnimaHome(stateDir, async () => clearRestartDrain().catch(() => undefined));
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime host stops a running agent after it becomes disabled', async () => {
  let scout = runtimeHostAgent('scout', { connected: true });
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: testHome,
    loadAgents: async () => [scout],
    logger: silentLogger,
    startAgent: async (agent) => stopHandle(agent.id, stopped),
    validateAgent: async () => {},
  });

  await host.reconcileOnce();
  assert.deepEqual(host.runningAgentIds(), ['scout']);

  scout = runtimeHostAgent('scout', { connected: true, enabled: false });
  await host.reconcileOnce();
  await host.reconcileOnce();

  assert.deepEqual(stopped, ['scout']);
  assert.deepEqual(host.runningAgentIds(), []);

  await host.stop();
});

test('runtime host force-restarts only the requested agent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-host-restart-test-'));
  try {
    const restartCommands = new AgentRestartCommandStore({ animaHome: stateDir });
    const agents = [
      runtimeHostAgent('alpha', { connected: true }),
      runtimeHostAgent('bravo', { connected: true }),
    ];
    const started: string[] = [];
    const stopped: Array<{ agentId: string; options: Parameters<RunningAgentHandle['stop']>[0] }> = [];
    const host = new RuntimeHost({}, {
      animaHome: stateDir,
      forceRestartTimeoutMs: 42,
      loadAgents: async () => agents,
      logger: silentLogger,
      restartCommands,
      startAgent: async (agent) => {
        started.push(agent.id);
        return stopHandle(agent.id, [], () => false, (options) => {
          stopped.push({ agentId: agent.id, options });
        });
      },
      validateAgent: async () => {},
    });

    await host.reconcileOnce();
    assert.deepEqual(started, ['alpha', 'bravo']);

    const command = await restartCommands.request('alpha');
    await host.reconcileOnce();

    assert.deepEqual(started, ['alpha', 'bravo', 'alpha']);
    assert.deepEqual(stopped, [
      {
        agentId: 'alpha',
        options: {
          abortReason: command.reason,
          forceAfterMs: 42,
        },
      },
    ]);
    assert.deepEqual(host.runningAgentIds(), ['alpha', 'bravo']);

    await host.stop();
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime host writes recovered restart health snapshots', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-host-health-restart-test-'));
  try {
    const restartCommands = new AgentRestartCommandStore({ animaHome: stateDir });
    const healthStore = new AgentHealthStore({ animaHome: stateDir });
    const agents = [runtimeHostAgent('alpha', { connected: true })];
    let generation = 0;
    const host = new RuntimeHost({}, {
      animaHome: stateDir,
      healthStore,
      loadAgents: async () => agents,
      logger: silentLogger,
      restartCommands,
      startAgent: async (agent) => {
        generation += 1;
        return healthHandle(agent.id, generation);
      },
      validateAgent: async () => {},
    });

    await host.reconcileOnce();
    const started = await healthStore.get('alpha');
    assert.equal(started?.state, 'healthy');
    assert.equal(started?.runtime?.workerId, `alpha:${process.pid}:1`);
    assert.equal(started?.runtime?.providerChildExpected, false);

    const command = await restartCommands.request('alpha');
    await host.reconcileOnce();

    const restarted = await healthStore.get('alpha');
    assert.equal(restarted?.state, 'healthy');
    assert.equal(restarted?.runtime?.workerId, `alpha:${process.pid}:2`);
    assert.equal(restarted?.restart?.requestId, command.requestId);
    assert.equal(restarted?.restart?.outcome, 'recovered');
    assert.equal(restarted?.restart?.workerPid, process.pid);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime host marks runnable agents starting before serial boot completes without hiding provider failures', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-host-boot-health-test-'));
  try {
    const healthStore = new AgentHealthStore({ animaHome: stateDir });
    const agents = [
      runtimeHostAgent('alpha', { connected: true }),
      runtimeHostAgent('bravo', { connected: true }),
      runtimeHostAgent('quota', { connected: true }),
    ];
    const healthService = new AgentHealthService(healthStore);
    await healthService.writeHealth({
      agentId: 'bravo',
      reason: 'stale_running_item',
      state: 'unhealthy',
      updatedAt: '2026-06-06T00:00:00.000Z',
    });
    await healthService.writeHealth({
      agentId: 'quota',
      reason: 'provider_quota_exhausted',
      state: 'unhealthy',
      updatedAt: '2026-06-06T00:00:00.000Z',
    });
    let releaseAlpha!: () => void;
    let alphaStarted!: () => void;
    const alphaBlock = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    const alphaStartedPromise = new Promise<void>((resolve) => {
      alphaStarted = resolve;
    });
    const started: string[] = [];
    const host = new RuntimeHost({}, {
      animaHome: stateDir,
      healthStore,
      loadAgents: async () => agents,
      logger: silentLogger,
      startAgent: async (agent) => {
        started.push(agent.id);
        if (agent.id === 'alpha') {
          alphaStarted();
          await alphaBlock;
        }
        return healthHandle(agent.id, 1);
      },
      validateAgent: async () => {},
    });

    const reconcile = host.reconcileOnce();
    await alphaStartedPromise;

    const bravoDuringBoot = await healthStore.get('bravo');
    assert.equal(bravoDuringBoot?.state, 'starting');
    assert.equal(bravoDuringBoot?.reason, undefined);
    const quotaDuringBoot = await healthStore.get('quota');
    assert.equal(quotaDuringBoot?.state, 'unhealthy');
    assert.equal(quotaDuringBoot?.reason, 'provider_quota_exhausted');

    releaseAlpha();
    await reconcile;
    assert.deepEqual(started, ['alpha', 'bravo', 'quota']);
    await host.stop();
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime host times out a blocked agent start and continues booting later agents', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-host-start-timeout-test-'));
  try {
    const healthStore = new AgentHealthStore({ animaHome: stateDir });
    const agents = [
      runtimeHostAgent('alpha', { connected: true }),
      runtimeHostAgent('bravo', { connected: true }),
      runtimeHostAgent('charlie', { connected: true }),
    ];
    let releaseAlpha!: () => void;
    let alphaStopOptions: Parameters<RunningAgentHandle['stop']>[0];
    let alphaStopped!: () => void;
    const alphaStoppedPromise = new Promise<void>((resolve) => {
      alphaStopped = resolve;
    });
    const started: string[] = [];
    const stopped: string[] = [];
    const errors: string[] = [];
    const host = new RuntimeHost({}, {
      animaHome: stateDir,
      healthStore,
      loadAgents: async () => agents,
      logger: {
        error(message) {
          errors.push(String(message));
        },
        log() {},
      },
      startAgent: async (agent) => {
        started.push(agent.id);
        if (agent.id === 'alpha') {
          return new Promise<RunningAgentHandle>((resolve) => {
            releaseAlpha = () => resolve(stopHandle('alpha', stopped, () => false, (options) => {
              alphaStopOptions = options;
              alphaStopped();
              throw new Error('late stop failed');
            }));
          });
        }
        return healthHandle(agent.id, 1, stopped);
      },
      startAgentTimeoutMs: 10,
      validateAgent: async () => {},
    });

    await host.reconcileOnce();

    assert.deepEqual(started, ['alpha', 'bravo', 'charlie']);
    const alpha = await healthStore.get('alpha');
    assert.equal(alpha?.state, 'unhealthy');
    assert.equal(alpha?.reason, 'start_failed');
    const bravo = await healthStore.get('bravo');
    assert.equal(bravo?.state, 'healthy');
    const charlie = await healthStore.get('charlie');
    assert.equal(charlie?.state, 'healthy');

    releaseAlpha();
    await alphaStoppedPromise;
    // yield to pending microtasks/IO.
    await sleep(0);
    assert.deepEqual(stopped, ['alpha']);
    assert.equal(alphaStopOptions?.abortReason, 'operator_restart');
    assert.deepEqual(errors, [
      'Agent alpha failed to start: Agent alpha startup timed out after 10ms',
      'Agent alpha: late startup handle stop failed: late stop failed',
    ]);
    await host.stop();
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime host debounces missing provider children before marking unhealthy', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-host-child-health-debounce-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const healthStore = new AgentHealthStore({ animaHome: stateDir });
      const agents = [runtimeHostAgent('alpha', { connected: true })];
      const stopped: string[] = [];
      const host = new RuntimeHost({}, {
        animaHome: stateDir,
        healthStore,
        loadAgents: async () => agents,
        logger: silentLogger,
        startAgent: async (agent) => providerChildMissingHandle(agent.id, stopped),
        validateAgent: async () => {},
      });

      await host.reconcileOnce();
      const firstSnapshot = await healthStore.get('alpha');
      assert.equal(firstSnapshot?.state, 'degraded');
      assert.equal(firstSnapshot?.reason, 'provider_child_missing');

      await new AgentHealthService(healthStore).writeHealth({
        agentId: 'alpha',
        reason: 'provider_child_missing',
        runtime: firstSnapshot?.runtime,
        state: 'degraded',
        updatedAt: new Date(Date.now() - 11_000).toISOString(),
      });

      await host.reconcileOnce();
      const escalated = await healthStore.get('alpha');
      assert.equal(escalated?.state, 'unhealthy');
      assert.equal(escalated?.reason, 'provider_child_missing');

      await host.stop();
      assert.deepEqual(stopped, ['alpha']);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime host restart clears only the requested stale running item', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-host-stale-restart-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const restartCommands = new AgentRestartCommandStore({ animaHome: stateDir });
      const healthStore = new AgentHealthStore({ animaHome: stateDir });
      const agents = [
        runtimeHostAgent('alpha', { connected: true }),
        runtimeHostAgent('bravo', { connected: true }),
      ];
      const started: string[] = [];
      const stopped: string[] = [];
      let alphaGeneration = 0;
      const host = new RuntimeHost({}, {
        animaHome: stateDir,
        healthStore,
        loadAgents: async () => agents,
        logger: silentLogger,
        restartCommands,
        startAgent: async (agent) => {
          started.push(agent.id);
          if (agent.id === 'alpha') {
            alphaGeneration += 1;
            return healthHandle(agent.id, alphaGeneration, stopped);
          }
          return healthHandle(agent.id, 1, stopped);
        },
        validateAgent: async () => {},
      });

      await host.reconcileOnce();

      const alphaPrimary = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-alpha',
          teamId: 'T-demo',
          text: 'stale alpha turn',
          ts: '1770000100.000001',
          userId: 'U1',
        }),
        { agentId: 'alpha', stateDir },
      );
      const alphaAppended = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-alpha',
          teamId: 'T-demo',
          text: 'alpha follow-up already appended',
          ts: '1770000100.000002',
          userId: 'U1',
        }),
        { agentId: 'alpha', stateDir },
      );
      const alphaQueued = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-alpha',
          teamId: 'T-demo',
          text: 'alpha queued follow-up',
          ts: '1770000100.000003',
          userId: 'U1',
        }),
        { agentId: 'alpha', stateDir },
      );
      const alphaQueue = new WakeQueueService('alpha');
      await alphaQueue.markRunning({
        itemId: alphaPrimary.item.id,
        startedAt: '2026-06-03T18:33:50.000Z',
        workerId: 'dead-worker',
      });
      await alphaQueue.markAppended({
        itemId: alphaAppended.item.id,
        parentItemId: alphaPrimary.item.id,
        workerId: 'dead-worker',
      });

      const bravoPrimary = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-bravo',
          teamId: 'T-demo',
          text: 'bravo active turn',
          ts: '1770000100.000004',
          userId: 'U1',
        }),
        { agentId: 'bravo', stateDir },
      );
      await new WakeQueueService('bravo').markRunning({
        itemId: bravoPrimary.item.id,
        startedAt: '2026-06-03T18:34:00.000Z',
        workerId: `bravo:${process.pid}:1`,
      });

      await restartCommands.request('alpha');
      await host.reconcileOnce();

      assert.deepEqual(started, ['alpha', 'bravo', 'alpha']);
      assert.deepEqual(stopped, ['alpha']);
      assert.deepEqual(host.runningAgentIds(), ['alpha', 'bravo']);

      const failedAlpha = await alphaQueue.find(alphaPrimary.item.id);
      const requeuedAlpha = await alphaQueue.find(alphaAppended.item.id);
      const stillQueuedAlpha = await alphaQueue.find(alphaQueued.item.id);
      assert.equal(failedAlpha, undefined);
      assert.equal(requeuedAlpha?.handling.status, 'queued');
      assert.equal(stillQueuedAlpha?.handling.status, 'queued');

      const bravoAfter = await new WakeQueueService('bravo').find(bravoPrimary.item.id);
      assert.equal(bravoAfter?.handling.status, 'running');
      assert.equal(bravoAfter?.handling.workerId, `bravo:${process.pid}:1`);

      const alphaHealth = await healthStore.get('alpha');
      assert.equal(alphaHealth?.state, 'healthy');
      assert.equal(alphaHealth?.restart?.outcome, 'recovered');
      assert.equal(alphaHealth?.runtime?.workerId, `alpha:${process.pid}:2`);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime host does not restart disabled agents from stale commands', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-host-restart-disabled-test-'));
  try {
    const restartCommands = new AgentRestartCommandStore({ animaHome: stateDir });
    const agents = [runtimeHostAgent('alpha', { connected: true, enabled: false })];
    const started: string[] = [];
    const host = new RuntimeHost({}, {
      animaHome: stateDir,
      loadAgents: async () => agents,
      logger: silentLogger,
      restartCommands,
      startAgent: async (agent) => {
        started.push(agent.id);
        return stopHandle(agent.id, []);
      },
      validateAgent: async () => {},
    });

    await restartCommands.request('alpha');
    await host.reconcileOnce();

    assert.deepEqual(started, []);
    assert.deepEqual(await restartCommands.pendingAgentIds(), []);
    assert.deepEqual(host.runningAgentIds(), []);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Slack DM and channel events share one primary session', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const config = { agentId: 'anima', stateDir };
      const first = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-product',
          channelName: 'product',
          teamId: 'T-demo',
          text: 'We should improve rough CEO ideas into tracked spikes.',
          threadTs: '1770000000.000001',
          userId: 'U1',
        }),
        config,
      );
      const second = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-user-anima',
          teamId: 'T-demo',
          text: 'Private context: this is about review friction.',
          userId: 'U1',
        }),
        config,
      );
      const third = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-product',
          channelName: 'product',
          teamId: 'T-demo',
          text: 'Can you summarize the decision and next step?',
          threadTs: '1770000000.000001',
          userId: 'U1',
        }),
        config,
      );

      assert.equal(first.session.createdAt, second.session.createdAt);
      assert.equal(second.session.createdAt, third.session.createdAt);

      const state = await loadState();
      const storedEvent = state.events[third.item.id];
      assert.equal(storedEvent?.kind, 'slack');
      assert.equal(storedEvent?.kind === 'slack' ? slackSurfaceForEvent(storedEvent).id : undefined, 'slack:T-demo:C-product:thread:1770000000.000001');
      assert.equal(storedEvent && storedEvent.kind === 'slack' ? storedEvent.channelName : undefined, 'product');

      const activities = await activitiesForInboxItemWindow('anima', third.item.id);
      assert.equal(activities.length, 0);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('activitiesForInboxItemWindow uses a bounded rotated activity scan for recent items', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-item-activity-window-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const agentDir = join(stateDir, 'agents/anima');
      const archiveDir = join(agentDir, 'activity.archive');
      await mkdir(archiveDir, { recursive: true });

      const recentItem = runtimeTestSlackItem({
        createdAt: '2026-01-03T00:00:00.000Z',
        id: 'recent-item',
        startedAt: '2026-01-03T00:01:15.000Z',
        updatedAt: '2026-01-03T00:03:00.000Z',
      });
      await writeFile(join(agentDir, 'wake-queue.json'), `${JSON.stringify({
        items: { [recentItem.id]: recentItem },
        seen: {},
      })}\n`, 'utf8');

      await writeJsonl(join(archiveDir, '0000000000001-activity-000.jsonl'), [
        runtimeTestActivity('old-a', '2026-01-01T00:00:00.000Z', { itemId: 'old-item' }),
        runtimeTestActivity('old-b', '2026-01-01T00:01:00.000Z', { itemId: 'old-item' }),
      ]);
      await writeJsonl(join(archiveDir, '0000000000002-activity-000.jsonl'), [
        runtimeTestActivity('before-window', '2026-01-02T23:59:59.000Z'),
      ]);
      await writeJsonl(join(archiveDir, '0000000000003-activity-000.jsonl'), [
        runtimeTestActivity('recent-archived-a', '2026-01-03T00:00:30.000Z', { itemId: recentItem.id }),
        runtimeTestActivity('recent-archived-b', '2026-01-03T00:01:30.000Z', { itemId: recentItem.id }),
      ]);
      await writeJsonl(join(agentDir, 'activity.jsonl'), [
        runtimeTestActivity('recent-live', '2026-01-03T00:02:00.000Z', { itemId: recentItem.id }),
      ]);

      const allActivities = await activityServiceForAgent('anima').readAll();
      const reference = readAllItemActivityReference(allActivities, recentItem);
      assert.deepEqual(reference.map((activity) => activity.activityId), [
        'recent-archived-a',
        'recent-archived-b',
        'recent-live',
      ]);

      const oldestArchive = (await readdir(archiveDir))
        .sort((a, b) => a.localeCompare(b))[0];
      assert.ok(oldestArchive);
      await writeFile(join(archiveDir, oldestArchive), '{not-json}\n', 'utf8');
      await assert.rejects(activityServiceForAgent('anima').readAll(), SyntaxError);

      assert.deepEqual(await activitiesForInboxItemWindow('anima', recentItem.id), reference);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('duplicate queue enqueue creates one item', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-duplicate-ingest-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const config = { agentId: 'anima', stateDir };
      const event = makeSlackEvent({
        channelId: 'C-product',
        eventId: 'slack:T-demo:C-product:1770000042.000001',
        teamId: 'T-demo',
        text: '<@U999> same delivery',
        ts: '1770000042.000001',
        userId: 'U1',
      });

      const queue = new WakeQueueService(config.agentId);
      const results = [];
      for (let i = 0; i < 20; i += 1) {
        results.push(await queue.enqueue(event));
      }
      const events = await queue.list();
      const state = await loadState();
      const items = Object.values(state.items).filter((item) => item.id === event.id);

      assert.equal(events.filter((stored) => stored.id === event.id).length, 1);
      assert.equal(items.length, 1);
      assert.equal(results.filter((result) => result.duplicate).length, 19);
      assert.equal(new Set(results.map((result) => result.item.id)).size, 1);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Slack message send activity can target another channel without item ownership', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const config = { agentId: 'anima', stateDir };
      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'C-product',
          channelName: 'product',
          teamId: 'T-demo',
          text: 'Please post the summary to ops too.',
          userId: 'U1',
        }),
        config,
      );

      const activity = await activityServiceForAgent('anima').record({
        payload: {
          channel: 'C-ops',
          channelName: 'ops',
          payload: {
            channel: 'C-ops',
            text: 'Summary for ops.',
          },
          status: 'dry-run',
          text: 'Summary for ops.',
          tool: 'anima.message.send',
        },
        type: 'tool.call.completed',
      });

      assert.equal(Object.hasOwn(activity, 'itemId'), false);
      assert.equal(activity.payload?.['channel'], 'C-ops');
      assert.equal(activity.payload?.['channelName'], 'ops');
      assert.deepEqual(activity.payload?.['payload'], {
        channel: 'C-ops',
        text: 'Summary for ops.',
      });

      const state = await loadState();
      const storedEvent = state.events[ctx.item.id];
      assert.equal(storedEvent?.kind, 'slack');
      assert.equal(storedEvent && storedEvent.kind === 'slack' ? storedEvent.channelId : undefined, 'C-product');
      assert.equal(state.activities[activity.activityId]?.payload?.['channel'], 'C-ops');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('state is stored per agent with append-only activity logs', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-state-layout-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const ctx = await ingestEvent(
        makeSlackEvent({
          channelId: 'D-anima',
          teamId: 'T-demo',
          text: 'Persist this in the folder state.',
          userId: 'U1',
        }),
        { agentId: 'anima', stateDir },
      );
      await activityServiceForAgent('anima').record({
        payload: {
          status: 'dry-run',
          text: 'Folder activity.',
          tool: 'anima.message.send',
        },
        type: 'tool.call.completed',
      });

      await assert.rejects(readFile(join(stateDir, 'state.json'), 'utf8'), /ENOENT/);
      const sessionJson = await readFile(join(stateDir, 'agents/anima/sessions.json'), 'utf8');
      const sessionRecord = JSON.parse(sessionJson) as Record<string, unknown>;
      assert.equal(Object.hasOwn(sessionRecord, 'sessionKey'), false);
      assert.equal(Object.hasOwn(sessionRecord, 'activeTopicSummary'), false);
      assert.equal(Object.hasOwn(sessionRecord, 'eventIds'), false);
      assert.equal(Object.hasOwn(sessionRecord, 'turnIds'), false);
      assert.match(await readFile(join(stateDir, 'agents/anima/wake-queue.json'), 'utf8'), /Persist this in the folder state/);
      await assert.rejects(readFile(join(stateDir, 'state/agents/anima/items', ctx.item.id, 'item.json'), 'utf8'), /ENOENT/);
      assert.match(await readFile(join(stateDir, 'agents/anima/activity.jsonl'), 'utf8'), /Folder activity/);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('inbox queue does not bootstrap home memory', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-bootstrap-test-'));
  try {
    const homePath = join(stateDir, 'agents', 'anima');

    await withAnimaHome(stateDir, () => new WakeQueueService('anima').enqueue(
      makeSlackEvent({ channelId: 'D-anima', teamId: 'T-demo', text: 'Start', userId: 'U1' }),
    ));

    await assert.rejects(readFile(join(homePath, 'MEMORY.md'), 'utf8'), /ENOENT/);
    await assert.rejects(readFile(join(homePath, 'notes'), 'utf8'), /ENOENT/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function writeJsonl(path: string, records: Activity[]): Promise<void> {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function runtimeTestActivity(
  activityId: string,
  createdAt: string,
  payload?: Record<string, unknown>,
): Activity {
  return {
    activityId,
    createdAt,
    ...(payload ? { payload } : {}),
    type: 'runtime.event',
  };
}

function runtimeTestSlackItem(input: {
  createdAt?: string;
  id: string;
  startedAt: string;
  updatedAt: string;
}): InboxItem {
  const createdAt = input.createdAt ?? input.startedAt;
  return {
    channelId: 'D-test',
    handling: {
      createdAt,
      queuedAt: createdAt,
      startedAt: input.startedAt,
      status: 'running',
      updatedAt: input.updatedAt,
      workerId: 'worker-test',
    },
    id: input.id,
    kind: 'slack',
    messageTs: '1770000000.000001',
    receivedAt: createdAt,
    teamId: 'T-test',
    text: 'recent item',
  };
}

function readAllItemActivityReference(activities: Activity[], item: InboxItem): Activity[] {
  const tagged = activities.filter((activity) => (
    activity.payload?.['itemId'] === item.id || activity.payload?.['activeItemId'] === item.id
  ));
  if (tagged.length > 0) return sortTestActivities(tagged);
  const start = item.handling.startedAt ?? item.handling.queuedAt ?? item.handling.createdAt;
  const end = item.handling.status === 'completed' || item.handling.status === 'failed'
    ? item.handling.updatedAt
    : undefined;
  return sortTestActivities(activities.filter((activity) => {
    if (activity.createdAt < start) return false;
    if (end && activity.createdAt > end) return false;
    return true;
  }));
}

function sortTestActivities(activities: Activity[]): Activity[] {
  return activities.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function runtimeHostAgent(
  id: string,
  options: {
    connected: boolean;
    enabled?: boolean;
    feishuConnected?: boolean;
    homePath?: string;
    model?: string;
    role?: string;
  },
): AgentConfig {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    enabled: options.enabled ?? true,
    homePath: options.homePath ?? `/tmp/${id}`,
    id,
    teamId: 'default',
    profile: {
      displayName: id,
      role: options.role ?? 'general purpose',
    },
    provider: {
      kind: 'claude-code',
      model: options.model ?? 'opus',
    },
    feishu: {
      appId: options.feishuConnected ? 'cli-test' : '',
      appSecret: options.feishuConnected ? 'feishu-secret' : '',
      connected: options.feishuConnected ?? false,
      encryptKey: '',
      verificationToken: '',
    },
    slack: {
      appToken: options.connected ? 'xapp-test' : '',
      botToken: options.connected ? 'xoxb-test' : '',
      connected: options.connected,
      manifestVersion: 0,
      teamId: options.connected ? 'T-test' : '',
      workspaceIconUrl: '',
      workspaceName: options.connected ? 'Test' : '',
    },
  };
}

function stopHandle(
  agentId: string,
  stopped: string[],
  isActive = () => false,
  onStop?: (options: Parameters<RunningAgentHandle['stop']>[0]) => void,
): RunningAgentHandle {
  return {
    health() {
      return {
        processId: process.pid,
        providerChildExpected: false,
        workerId: `${agentId}:${process.pid}`,
      };
    },
    isActive,
    async stop(options) {
      stopped.push(agentId);
      onStop?.(options);
    },
  };
}

function healthHandle(agentId: string, generation: number, stopped: string[] = []): RunningAgentHandle {
  return {
    health() {
      return {
        processId: process.pid,
        providerChildExpected: false,
        workerId: `${agentId}:${process.pid}:${generation}`,
      };
    },
    async stop() {
      stopped.push(agentId);
    },
  };
}

function providerChildMissingHandle(agentId: string, stopped: string[] = []): RunningAgentHandle {
  return {
    health() {
      return {
        processId: process.pid,
        providerChildExpected: true,
        workerId: `${agentId}:${process.pid}:missing-child`,
      };
    },
    async stop() {
      stopped.push(agentId);
    },
  };
}

const silentLogger = {
  error() {},
  log() {},
};
