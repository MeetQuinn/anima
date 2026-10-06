import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeBackgroundEvidence } from '../providers/claude-background-evidence.js';

const at = '2026-10-06T00:00:00.000Z';
const level = (ids: unknown[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: ids.map((task_id) => ({ task_id })),
});
const terminal = (task_id: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id,
  status: 'completed',
  summary: 'PRIVATE_SENTINEL',
  output_file: '/private/sentinel',
});

test('terminal-only evidence distinguishes an unobserved list from an observed empty list', () => {
  const e = new ClaudeBackgroundEvidence();
  e.record(terminal('early-task'), at);
  assert.deepEqual(e.snapshot(), {
    terminalNotifications: [{ taskId: 'early-task', status: 'completed', receivedAt: at }],
  });
  const later = '2026-10-06T00:00:01.000Z';
  e.record(level([]), later);
  assert.deepEqual(e.snapshot(), {
    snapshotReceivedAt: later,
    listedTaskIds: [],
    ambientTaskIds: [],
    listedTaskIdsTruncated: false,
    terminalNotifications: [{ taskId: 'early-task', status: 'completed', receivedAt: at }],
  });
});

test('background evidence keeps level and terminal streams independent in either order', () => {
  for (const edgesFirst of [true, false]) {
    const e = new ClaudeBackgroundEvidence();
    if (edgesFirst) e.record(terminal('task-1'), at);
    e.record(level(['task-1']), at);
    if (!edgesFirst) e.record(terminal('task-1'), at);
    assert.deepEqual(e.snapshot(), {
      snapshotReceivedAt: at,
      listedTaskIds: ['task-1'],
      ambientTaskIds: [],
      listedTaskIdsTruncated: false,
      terminalNotifications: [{ taskId: 'task-1', status: 'completed', receivedAt: at }],
    });
    e.record(level([]), at);
    assert.deepEqual(e.snapshot()?.listedTaskIds, []);
    assert.equal(e.snapshot()?.terminalNotifications.length, 1);
  }
});

test('ambient task IDs remain visible as evidence without implying they contribute to the count', () => {
  const e = new ClaudeBackgroundEvidence();
  e.record(
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'ambient', ambient: true }, { task_id: 'visible' }],
    },
    at,
  );
  assert.deepEqual(e.snapshot()?.listedTaskIds, ['ambient', 'visible']);
  assert.deepEqual(e.snapshot()?.ambientTaskIds, ['ambient']);
  e.record(level(['visible']), at);
  assert.deepEqual(e.snapshot()?.ambientTaskIds, []);
});

test('diagnostics are bounded, omit untrusted text and invalid IDs, and cannot be mutated through snapshots', () => {
  const e = new ClaudeBackgroundEvidence();
  e.record(
    level([
      ...Array.from({ length: 40 }, (_, i) => `task-${i}`),
      'private/path',
      'x'.repeat(129),
      null,
    ]),
    at,
  );
  for (let i = 0; i < 30; i++) e.record(terminal(`task-${i}`), at);
  e.record(terminal('private/path'), at);
  const s = e.snapshot()!;
  assert.ok(s.listedTaskIds);
  assert.equal(s.listedTaskIds.length, 32);
  assert.equal(s.listedTaskIdsTruncated, true);
  assert.equal(s.terminalNotifications.length, 16);
  assert.equal(s.terminalNotifications[0]?.taskId, 'task-14');
  assert.equal(JSON.stringify(s).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(s).includes('private/path'), false);
  s.listedTaskIds.length = 0;
  s.terminalNotifications[0]!.status = 'failed';
  assert.equal(e.snapshot()?.listedTaskIds?.length, 32);
  assert.equal(e.snapshot()?.terminalNotifications[0]?.status, 'completed');
});

test('a new controller evidence instance cannot inherit an earlier process list', () => {
  const previous = new ClaudeBackgroundEvidence();
  previous.record(level(['old-process-task']), at);
  previous.record(terminal('old-process-task'), at);
  const current = new ClaudeBackgroundEvidence();
  assert.equal(current.snapshot(), undefined);
  current.record({ type: 'system', subtype: 'background_tasks_changed', tasks: null }, at);
  current.record(
    { type: 'system', subtype: 'task_notification', task_id: 'unknown', status: 'running' },
    at,
  );
  assert.equal(current.snapshot(), undefined);
  current.record(level(['new-process-task']), at);
  assert.deepEqual(current.snapshot()?.listedTaskIds, ['new-process-task']);
  assert.deepEqual(current.snapshot()?.terminalNotifications, []);
});
