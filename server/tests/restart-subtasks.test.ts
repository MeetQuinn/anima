import assert from 'node:assert/strict';
import test from 'node:test';
import type { Activity } from '../../shared/activity.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { AgentRuntimeBridge } from '../runtime/runtime-bridge.js';
import { restartSubtaskObservations, restartSubtaskPrompt } from '../runtime/restart-subtasks.js';
import type { AgentRuntime } from '../providers/contract.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { enqueueInbox } from './helpers/runtime-worker.js';
import { makeSlackEvent } from './helpers/slack.js';

function activity(payload: Record<string, unknown>, type = 'agent.text', time = '2026-09-30T00:01:00Z'): Activity {
  return { activityId: 'fixture', createdAt: time, type, payload: { runtimeKind: 'claude-code', itemId: 'item', ...payload } };
}

test('restart observations retain unresolved spawns, dedupe children and preserve the delegated goal', () => {
  const rows = [
    activity({ providerToolName: 'Agent', providerToolId: 'spawn', target: 'Review upgrade flow' }, 'tool.call.started'),
    activity({ parentToolCallId: 'spawn', subRunId: 'child', name: 'reviewer', role: 'Explore' }),
    activity({ parentToolCallId: 'spawn', subRunId: 'child', target: 'a child shell command' }, 'tool.call.started', '2026-09-30T00:02:00Z'),
    activity({ parentToolCallId: 'spawn', subRunId: 'child-2' }),
    activity({ providerToolName: 'Agent', providerToolId: 'spawn' }, 'tool.call.started'),
    activity({ providerToolName: 'Task', providerToolId: 'unresolved', target: 'Check tests' }, 'tool.call.started'),
    activity({ providerToolName: 'TaskCreate', providerToolId: 'todo' }, 'tool.call.started'),
    activity({ parentToolCallId: 'other', subRunId: 'wrong-provider', runtimeKind: 'codex-cli' }),
    activity({ parentToolCallId: 'other', subRunId: 'wrong-item', itemId: 'another-item' }),
  ];
  const observations = restartSubtaskObservations(rows, 'claude-code', 'item');
  assert.equal(observations.length, 3);
  assert.deepEqual(observations.find((row) => row.subRunId === 'child'), {
    parentToolCallId: 'spawn', subRunId: 'child', name: 'reviewer', role: 'Explore',
    target: 'Review upgrade flow', lastObservedAt: '2026-09-30T00:02:00Z',
  });
  assert.equal(observations.find((row) => row.subRunId === 'child-2')?.target, 'Review upgrade flow');
  assert.equal(observations.find((row) => row.parentToolCallId === 'unresolved')?.subRunId, undefined);
  const prompt = restartSubtaskPrompt(observations);
  assert.match(prompt, /historical, not current status/);
  assert.match(prompt, /may include completed tasks/);
  assert.match(prompt, /Missing IDs do not mean no subagent was started/);
  assert.doesNotMatch(prompt, /wrong-provider|wrong-item|a child shell command/);
});

test('restart observations include Codex linkage and bound the rendered evidence with an omission notice', () => {
  const rows = Array.from({ length: 35 }, (_, index) => activity({
    runtimeKind: 'codex-cli', parentToolCallId: `spawn-${index}`, subRunId: `thread-${index}`,
    eventType: 'codex.subagent.delegated',
  }));
  const prompt = restartSubtaskPrompt(restartSubtaskObservations(rows, 'codex-cli', 'item'));
  assert.match(prompt, /3 older references omitted/);
  assert.doesNotMatch(prompt, /"subRunId":"thread-0"/);
  assert.match(prompt, /"subRunId":"thread-34"/);
  assert.equal(restartSubtaskPrompt([]), '');
});

test('bridge recovers durable same-item subagent evidence after restart and keeps the Slack cursor delta', async () => {
  await withTempAnimaHome(async (stateDir) => {
    const options = { agentId: 'anima', stateDir, homePath: stateDir };
    const event = makeSlackEvent({
      channelId: 'D-user', teamId: 'T-demo', text: 'continue task', ts: '1790726400.000001', userId: 'U1',
      handling: { status: 'queued', createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' },
    });
    const { ctx } = await enqueueInbox(event, options);
    const service = activityServiceForAgent('anima');
    for (const [itemId, child, time] of [
      [event.id, 'archived-session-child', '2026-09-30T00:00:00Z'],
      ['another-item', 'other-task-child', '2026-09-30T00:02:00Z'],
      [event.id, 'same-task-child', '2026-09-30T00:03:00Z'],
    ]) {
      await service.record({ type: 'agent.text', createdAt: time, payload: {
        itemId, runtimeKind: 'claude-code', parentToolCallId: `spawn-${child}`, subRunId: child,
      } });
    }
    ctx.session.currentStartedAt = '2026-09-30T00:01:00Z';
    ctx.item.handling.resumeReason = 'runtime_restart';
    ctx.cursorDelivery = {
      agentId: 'anima', triggerItemId: event.id, triggerEventId: event.id,
      surfaces: [], committed: false, promptBody: 'Slack cursor delta sentinel',
    };
    const runtime: AgentRuntime = {
      kind: 'claude-code', run: async () => ({}), appendToActiveRun: async () => ({ accepted: false }),
    };
    const input = await new AgentRuntimeBridge(runtime).runInput({
      context: ctx, profile: { displayName: 'Anima', transports: { slack: true, feishu: false } },
    });
    assert.match(input.prompt, /same-task-child/);
    assert.doesNotMatch(input.prompt, /archived-session-child|other-task-child/);
    assert.match(input.prompt, /resume an interrupted subagent.*otherwise reassign only the unfinished work/);
    assert.match(input.prompt, /Check external-action receipts/);
    assert.match(input.prompt, /anima outbox/);
    assert.ok(input.prompt.endsWith('Slack cursor delta sentinel'));

    ctx.item.handling.resumeReason = undefined;
    const ordinary = await new AgentRuntimeBridge(runtime).runInput({
      context: ctx, profile: { displayName: 'Anima', transports: { slack: true, feishu: false } },
    });
    assert.equal(ordinary.prompt, 'Slack cursor delta sentinel');
  });
});
