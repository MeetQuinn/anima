import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSlackEvent } from './helpers/slack.js';
import { slackSurfaceForEvent } from '../inbox/slack-events.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { ingestEvent } from './helpers/inbox.js';
import { loadState } from './helpers/state.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { isFirstClassAnimaCliCommand } from '../activities/format.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { startChildProcess } from '../providers/child-process.js';
import { RuntimeHost, type RunningAgentHandle } from '../runtime/host.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import { withAnimaHome } from './anima-home.js';

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

test('first-class anima CLI command detection covers plain agent-facing tools', () => {
  assert.equal(isFirstClassAnimaCliCommand('anima ask --question "Pick" --option A --option B'), true);
  assert.equal(isFirstClassAnimaCliCommand('ANIMA_AGENT_ID=scout anima reminder list'), true);
  assert.equal(isFirstClassAnimaCliCommand('anima subscription mute --channel C123'), true);
  assert.equal(isFirstClassAnimaCliCommand('anima message send --channel C123'), true);
  assert.equal(isFirstClassAnimaCliCommand('cd ~/anima && ANIMA_AGENT_ID=scout anima ask --question "Pick"'), false);
});

test('runtime host idles with zero agents and starts a newly runnable agent once', async () => {
  let agents: AgentConfig[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: '/tmp/anima-home',
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

test('runtime host starts after Slack connection and reloads idle agents after config changes', async () => {
  let scout = runtimeHostAgent('scout', { connected: false });
  const started: string[] = [];
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: '/tmp/anima-home',
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

test('runtime host defers config reload until the running agent is idle', async () => {
  let scout = runtimeHostAgent('scout', { connected: true, homePath: '/tmp/home-a', model: 'opus' });
  let active = false;
  const started: string[] = [];
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: '/tmp/anima-home',
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

test('runtime host stops a running agent after it becomes disabled', async () => {
  let scout = runtimeHostAgent('scout', { connected: true });
  const stopped: string[] = [];
  const host = new RuntimeHost({}, {
    animaHome: '/tmp/anima-home',
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
      assert.match(await readFile(join(stateDir, 'agents/anima/inbox.json'), 'utf8'), /Persist this in the folder state/);
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

function runtimeHostAgent(
  id: string,
  options: { connected: boolean; enabled?: boolean; homePath?: string; model?: string; role?: string },
): AgentConfig {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    enabled: options.enabled ?? true,
    homePath: options.homePath ?? `/tmp/${id}`,
    id,
    profile: {
      displayName: id,
      role: options.role ?? 'general purpose',
    },
    provider: {
      kind: 'claude-code',
      model: options.model ?? 'opus',
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

function stopHandle(agentId: string, stopped: string[], isActive = () => false): RunningAgentHandle {
  return {
    isActive,
    async stop() {
      stopped.push(agentId);
    },
  };
}

const silentLogger = {
  error() {},
  log() {},
};
