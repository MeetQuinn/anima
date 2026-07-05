import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from './anima-home.js';
import { allActivities, loadState } from './helpers/state.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import {
  FatalProviderRuntime,
  MemoryWritingRuntime,
  StaticTextRuntime,
  ToolActivityRuntime,
  ensureTestAgentConfig,
  makeMemoryCoherenceInboxItem,
  memoryCoherenceCoordinator,
  prepareMemoryCoherenceHome,
  queueFor,
  silentLogger,
} from './helpers/runtime-worker.js';

test('runtime worker records memory coherence quiet-skip outcome without parsing prose markers', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-worker-test-'));
  const scheduledSlotAt = new Date(Date.now() - 60_000).toISOString();
  const runtime = new StaticTextRuntime('Nothing needed changing.\nMemory coherence outcome: completed');
  const coordinator = memoryCoherenceCoordinator(stateDir);
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await prepareMemoryCoherenceHome(coordinator);
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        homePath: coordinator.homePath,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const item = makeMemoryCoherenceInboxItem({
        scheduledSlotAt,
        timestamp: scheduledSlotAt,
      });
      await queueFor('scout').enqueue(item);

      assert.equal(await worker.drainOnce(), 1);
      assert.equal(await queueFor('scout').find(item.id), undefined);

      const outcome = allActivities(await loadState()).find((activity) =>
        activity.type === 'memory_coherence.outcome'
      );
      assert.equal(outcome?.payload?.['outcome'], 'quiet_skipped');
      assert.equal(outcome?.payload?.['summary'], 'Nothing needed changing.\nMemory coherence outcome: completed');
      assert.equal(outcome?.payload?.['scheduledSlotAt'], scheduledSlotAt);
      assert.equal(outcome?.payload?.['scheduledSlotLabel'], '05:47 agent-local');
      assert.equal(typeof outcome?.payload?.['delayMs'], 'number');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker derives memory coherence completed from memory file changes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-worker-test-'));
  const scheduledSlotAt = new Date(Date.now() - 60_000).toISOString();
  const runtime = new MemoryWritingRuntime('Updated memory.', [
    { path: 'MEMORY.md', text: '# Updated memory\n' },
  ]);
  const coordinator = memoryCoherenceCoordinator(stateDir);
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await prepareMemoryCoherenceHome(coordinator);
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        homePath: coordinator.homePath,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const item = makeMemoryCoherenceInboxItem({
        scheduledSlotAt,
        timestamp: scheduledSlotAt,
      });
      await queueFor('scout').enqueue(item);

      assert.equal(await worker.drainOnce(), 1);

      const outcome = allActivities(await loadState()).find((activity) =>
        activity.type === 'memory_coherence.outcome'
      );
      assert.equal(outcome?.payload?.['outcome'], 'completed');
      assert.equal(outcome?.payload?.['summary'], 'Updated memory.');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker derives memory coherence completed from Bash memory writes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-worker-test-'));
  const scheduledSlotAt = new Date(Date.now() - 60_000).toISOString();
  const runtime = new MemoryWritingRuntime(
    'Demoted a long memory block with a line splice.',
    [{ path: 'MEMORY.md', text: '# Updated by splice\n' }],
    [
      {
        command: [
          "python3 - <<'PY'",
          'path = "MEMORY.md"',
          'with open(path, "r", encoding="utf-8") as f:',
          '    lines = f.readlines()',
          'with open(path, "w", encoding="utf-8") as f:',
          '    f.writelines(lines)',
          'PY',
        ].join('\n'),
        providerToolId: 'bash-splice-1',
        providerToolName: 'Bash',
        target: 'line-splice MEMORY.md',
        tool: 'claude.Bash',
      },
    ],
  );
  const coordinator = memoryCoherenceCoordinator(stateDir);
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await prepareMemoryCoherenceHome(coordinator);
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        homePath: coordinator.homePath,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const item = makeMemoryCoherenceInboxItem({
        scheduledSlotAt,
        timestamp: scheduledSlotAt,
      });
      await queueFor('scout').enqueue(item);

      assert.equal(await worker.drainOnce(), 1);

      const outcome = allActivities(await loadState()).find((activity) =>
        activity.type === 'memory_coherence.outcome'
      );
      assert.equal(outcome?.payload?.['outcome'], 'completed');
      assert.equal(outcome?.payload?.['summary'], 'Demoted a long memory block with a line splice.');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker derives memory coherence completed from temp-file moves into notes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-worker-test-'));
  const scheduledSlotAt = new Date(Date.now() - 60_000).toISOString();
  const runtime = new MemoryWritingRuntime('Moved detail into notes.', [
    { path: 'notes/detail.md', tempPath: 'notes/detail.md.tmp', text: 'durable detail\n' },
  ]);
  const coordinator = memoryCoherenceCoordinator(stateDir);
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await prepareMemoryCoherenceHome(coordinator);
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        homePath: coordinator.homePath,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const item = makeMemoryCoherenceInboxItem({
        scheduledSlotAt,
        timestamp: scheduledSlotAt,
      });
      await queueFor('scout').enqueue(item);

      assert.equal(await worker.drainOnce(), 1);

      const outcome = allActivities(await loadState()).find((activity) =>
        activity.type === 'memory_coherence.outcome'
      );
      assert.equal(outcome?.payload?.['outcome'], 'completed');
      assert.equal(outcome?.payload?.['summary'], 'Moved detail into notes.');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker does not mark memory coherence completed from read or list activity', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-worker-test-'));
  const scheduledSlotAt = new Date(Date.now() - 60_000).toISOString();
  const runtime = new ToolActivityRuntime('Inspected memory; nothing to change.', [
    { providerToolId: 'read-1', providerToolName: 'Read', target: 'MEMORY.md', tool: 'claude.Read' },
    { providerToolId: 'glob-1', providerToolName: 'Glob', target: 'notes/*', tool: 'claude.Glob' },
    {
      command: "sed -n '1,120p' MEMORY.md && find notes -maxdepth 1 -type f",
      providerToolId: 'bash-read-1',
      providerToolName: 'Bash',
      target: 'inspect memory',
      tool: 'claude.Bash',
    },
  ]);
  const coordinator = memoryCoherenceCoordinator(stateDir);
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await prepareMemoryCoherenceHome(coordinator);
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        homePath: coordinator.homePath,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const item = makeMemoryCoherenceInboxItem({
        scheduledSlotAt,
        timestamp: scheduledSlotAt,
      });
      await queueFor('scout').enqueue(item);

      assert.equal(await worker.drainOnce(), 1);

      const outcome = allActivities(await loadState()).find((activity) =>
        activity.type === 'memory_coherence.outcome'
      );
      assert.equal(outcome?.payload?.['outcome'], 'quiet_skipped');
      assert.equal(outcome?.payload?.['summary'], 'Inspected memory; nothing to change.');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runtime worker records failed memory coherence outcome on provider error', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-worker-test-'));
  const scheduledSlotAt = new Date(Date.now() - 60_000).toISOString();
  const runtime = new FatalProviderRuntime('memory provider failed');
  const coordinator = memoryCoherenceCoordinator(stateDir);
  let worker: AgentRuntimeWorker | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await prepareMemoryCoherenceHome(coordinator);
      await ensureTestAgentConfig(coordinator);
      worker = new AgentRuntimeWorker({
        agentId: 'scout',
        agentRuntime: runtime,
        homePath: coordinator.homePath,
        queue: queueFor('scout'),
        pollIntervalMs: 10_000,
        stateDir,
        workerId: 'test-worker',
      }, silentLogger);
      const item = makeMemoryCoherenceInboxItem({
        scheduledSlotAt,
        timestamp: scheduledSlotAt,
      });
      await queueFor('scout').enqueue(item);

      assert.equal(await worker.drainOnce(), 1);
      assert.equal(await queueFor('scout').find(item.id), undefined);

      const outcome = allActivities(await loadState()).find((activity) =>
        activity.type === 'memory_coherence.outcome'
      );
      assert.equal(outcome?.payload?.['outcome'], 'failed');
      assert.equal(outcome?.payload?.['failureReason'], 'memory provider failed');
    });
  } finally {
    await worker?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});
