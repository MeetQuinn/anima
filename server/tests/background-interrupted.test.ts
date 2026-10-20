import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRuntimeHandleSnapshot, AgentRuntimeHealthSummary } from '../../shared/snapshot.js';
import { InboxItemSchema } from '../../shared/inbox.js';
import {
  backgroundInterruptedInboxItem,
  bootInterruptedBackgroundWork,
  interruptedBackgroundWork,
} from '../runtime/background-interrupted.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { formatBackgroundProviderWorkWarning, listBackgroundProviderWork } from '../services/restart-gate.js';

const observedAt = '2026-10-20T12:49:00.000Z';

function runtime(overrides: Partial<AgentRuntimeHandleSnapshot> = {}): AgentRuntimeHandleSnapshot {
  return { processId: 4242, providerChildExpected: true, ...overrides };
}

function health(rt: AgentRuntimeHandleSnapshot | undefined, updatedAt = observedAt): AgentRuntimeHealthSummary {
  return { ...(rt ? { runtime: rt } : {}), state: 'healthy', updatedAt };
}

test('background work after the Anima item ended is interrupted work', () => {
  const work = interruptedBackgroundWork(runtime({
    providerWork: {
      backgroundEvidence: {
        ambientTaskIds: ['monitor'],
        listedTaskIds: ['task-a', 'monitor', 'task-b'],
        terminalNotifications: [],
      },
      backgroundTaskCount: 2,
      state: 'background',
    },
  }), observedAt);
  assert.deepEqual(work, {
    backgroundTaskCount: 2,
    lastObservedAt: observedAt,
    processId: 4242,
    providerState: 'background',
    taskIds: ['task-a', 'task-b'],
    taskIdsTruncated: false,
  });
});

test('an active item without background tasks is left to the runtime_restart continuation', () => {
  assert.equal(interruptedBackgroundWork(runtime({ activeItemId: 'item', providerWork: { state: 'working' } }), observedAt), undefined);
  assert.equal(interruptedBackgroundWork(runtime(), observedAt), undefined);
  assert.equal(interruptedBackgroundWork(undefined, observedAt), undefined);
});

test('background tasks still count when an active item is also running', () => {
  const work = interruptedBackgroundWork(runtime({
    activeItemId: 'item',
    providerWork: { backgroundTaskCount: 1, state: 'working' },
  }), observedAt);
  assert.equal(work?.backgroundTaskCount, 1);
  assert.equal(work?.providerState, 'working');
});

test('a native provider turn outside any Anima item is interrupted work', () => {
  const work = interruptedBackgroundWork(runtime({ providerWork: { state: 'working' } }), observedAt);
  assert.equal(work?.providerState, 'working');
  assert.equal(work?.backgroundTaskCount, undefined);
});

test('boot detection only trusts snapshots published by a previous server process', () => {
  const previous = health(runtime({ processId: 111, providerWork: { backgroundTaskCount: 3, state: 'background' } }));
  assert.equal(bootInterruptedBackgroundWork(previous, 111), undefined);
  assert.equal(bootInterruptedBackgroundWork(previous, 222)?.backgroundTaskCount, 3);
  assert.equal(bootInterruptedBackgroundWork(previous, 222)?.lastObservedAt, observedAt);
  assert.equal(bootInterruptedBackgroundWork(health(runtime({ processId: undefined, providerWork: { backgroundTaskCount: 1, state: 'background' } })), 222), undefined);
  assert.equal(bootInterruptedBackgroundWork(undefined, 222), undefined);
});

test('the notice item validates and renders a reconcile prompt', () => {
  const work = interruptedBackgroundWork(runtime({
    providerWork: {
      backgroundEvidence: { listedTaskIds: ['task-a'], listedTaskIdsTruncated: true, terminalNotifications: [] },
      backgroundTaskCount: 2,
      state: 'background',
    },
  }), observedAt);
  assert.ok(work);
  const item = backgroundInterruptedInboxItem({
    agentId: 'wirth',
    cause: 'server_restart',
    interruptionKey: `4242:${observedAt}`,
    now: '2026-10-20T13:00:00.000Z',
    work,
  });
  assert.equal(item.id, `background-interrupted:wirth:4242:${observedAt}`);
  assert.deepEqual(InboxItemSchema.parse(item), item);

  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /^Background work interrupted:/);
  assert.match(prompt, /cause=server_restart/);
  assert.match(prompt, /the Anima runtime restarted while your provider still had 2 background task\(s\)/);
  assert.match(prompt, /Task IDs: task-a \(truncated\)\./);
  assert.match(prompt, /will not report back or wake you on its own/);
  assert.match(prompt, /anima outbox/);

  const operator = buildCodeAgentDeliveryPrompt(backgroundInterruptedInboxItem({
    agentId: 'wirth',
    cause: 'agent_restart',
    interruptionKey: 'restart-1',
    now: '2026-10-20T13:00:00.000Z',
    work: { lastObservedAt: observedAt, providerState: 'working', taskIds: [], taskIdsTruncated: false },
  }));
  assert.match(operator, /an operator restarted this agent while your provider still had a provider turn running outside any Anima item/);
  assert.doesNotMatch(operator, /Task IDs/);
});

test('restart warning lists fresh background work and skips stale snapshots', async () => {
  const now = Date.parse('2026-10-20T13:00:00.000Z');
  const snapshots: Record<string, AgentRuntimeHealthSummary> = {
    nicholas: health(runtime({ providerWork: { backgroundTaskCount: 1, state: 'background' } }), '2026-10-20T12:59:55.000Z'),
    quiet: health(runtime(), '2026-10-20T12:59:55.000Z'),
    stale: health(runtime({ providerWork: { backgroundTaskCount: 4, state: 'background' } }), '2026-10-20T11:00:00.000Z'),
    wirth: health(runtime({ providerWork: { backgroundTaskCount: 5, state: 'background' } }), '2026-10-20T12:59:58.000Z'),
  };
  const work = await listBackgroundProviderWork({ list: async () => snapshots }, now);
  assert.deepEqual(work, [
    { agentId: 'nicholas', backgroundTaskCount: 1 },
    { agentId: 'wirth', backgroundTaskCount: 5 },
  ]);
  assert.equal(
    formatBackgroundProviderWorkWarning(work),
    'Background provider work is running for nicholas (1 background task), wirth (5 background tasks). '
      + 'A restart stops any of it still running; affected agents are woken with a background-interrupted notice after the restart.',
  );
  assert.equal(formatBackgroundProviderWorkWarning([]), undefined);
});
