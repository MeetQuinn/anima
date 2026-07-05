import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessageRecord } from '../../shared/messages.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import type { InboxItem, MemoryCoherenceInboxItem } from '../../shared/inbox.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import {
  hasMeaningfulActivitySinceLastMemoryPass,
  MemoryCoherenceScheduler,
  stableAgentOffsetMinutes,
} from '../memory/memory-coherence-scheduler.js';
import {
  determineMemoryCoherenceOutcome,
  memoryCoherenceDigest,
  memoryCoherenceSummary,
} from '../memory/memory-coherence-outcome.js';
import { MessageStore } from '../storage/schema/message.store.js';
import { withAnimaHome } from './anima-home.js';

test('memory coherence scheduler is off by default', async () => {
  const queues = new TestMemoryQueues();
  const scheduler = new MemoryCoherenceScheduler({
    now: () => new Date('2026-06-22T08:00:00.000Z'),
    queueForAgent: (agentId) => queues.queueForAgent(agentId),
    readServerConfig: async () => ({}),
    timezoneForAgent: () => 'UTC',
  });

  await scheduler.reconcile([agent('iris')]);

  assert.deepEqual(queues.enqueuedIds(), []);
});

test('memory coherence scheduler treats empty scopeAgentIds as all enabled runnable agents', async () => {
  const queues = new TestMemoryQueues();
  const scheduler = new MemoryCoherenceScheduler({
    hasMeaningfulActivitySinceLastPass: async () => true,
    now: () => new Date('2026-06-22T08:00:00.000Z'),
    queueForAgent: (agentId) => queues.queueForAgent(agentId),
    readServerConfig: async () => ({
      memoryCoherence: {
        enabled: true,
        maxConcurrent: 10,
        scopeAgentIds: [],
        timezone: 'UTC',
        windowDurationMinutes: 60,
        windowStart: '05:00',
      },
    }),
    timezoneForAgent: () => 'UTC',
  });

  await scheduler.reconcile([
    agent('iris'),
    agent('nora'),
    agent('disabled', { enabled: false }),
    agent('unconnected', { connected: false }),
  ]);

  assert.deepEqual(queues.enqueuedIds().map((entry) => entry.agentId).sort(), ['iris', 'nora']);
  for (const entry of queues.enqueuedIds()) {
    assert.equal(entry.item.kind, 'memory_coherence');
    assert.equal(entry.item.scheduledSlotLabel.endsWith(' agent-local'), true);
    assert.match(entry.item.id, /^memory-coherence:/);
  }
});

test('memory coherence scheduler skips due slots with no meaningful activity since last pass', async () => {
  const queues = new TestMemoryQueues();
  const scheduler = new MemoryCoherenceScheduler({
    hasMeaningfulActivitySinceLastPass: async () => false,
    now: () => new Date('2026-06-22T08:00:00.000Z'),
    queueForAgent: (agentId) => queues.queueForAgent(agentId),
    readServerConfig: async () => ({
      memoryCoherence: {
        enabled: true,
        maxConcurrent: 10,
        scopeAgentIds: [],
        timezone: 'UTC',
        windowDurationMinutes: 60,
        windowStart: '05:00',
      },
    }),
    timezoneForAgent: () => 'UTC',
  });

  await scheduler.reconcile([agent('aria')]);

  assert.deepEqual(queues.enqueuedIds(), []);
});

test('memory coherence scheduler scopes agents and respects active memory cap', async () => {
  const queues = new TestMemoryQueues();
  const active = memoryItem('iris', '2026-06-22T05:00:00.000Z');
  active.handling.status = 'running';
  queues.itemsForAgent('iris').push(active);
  const scheduler = new MemoryCoherenceScheduler({
    now: () => new Date('2026-06-22T08:00:00.000Z'),
    queueForAgent: (agentId) => queues.queueForAgent(agentId),
    readServerConfig: async () => ({
      memoryCoherence: {
        enabled: true,
        maxConcurrent: 1,
        scopeAgentIds: ['iris', 'nora'],
        timezone: 'UTC',
        windowDurationMinutes: 60,
        windowStart: '05:00',
      },
    }),
    timezoneForAgent: () => 'UTC',
  });

  await scheduler.reconcile([agent('iris'), agent('nora'), agent('tess')]);

  assert.equal(queues.itemsForAgent('iris').length, 1);
  assert.equal(queues.itemsForAgent('nora').length, 0);
  assert.equal(queues.itemsForAgent('tess').length, 0);
});

test('memory coherence scheduler uses a stable per-agent offset', () => {
  const first = stableAgentOffsetMinutes('iris', 120);
  const second = stableAgentOffsetMinutes('iris', 120);
  assert.equal(first, second);
  assert.equal(first >= 0 && first < 120, true);
});

test('memory coherence prompt uses the self-contained scheduled memory pass copy', () => {
  const prompt = buildCodeAgentDeliveryPrompt(memoryItem('iris', '2026-06-22T05:47:00.000Z'));

  assert.match(prompt, /^Memory coherence system wake:/);
  // envelopeTime renders second granularity (stale .000Z assertion predated #353's envelope rewrite).
  assert.match(prompt, /scheduled_slot_at=2026-06-22T05:47:00Z/);
  assert.match(prompt, /You are running your scheduled memory pass\./);
  assert.match(prompt, /Do not churn to look busy\./);
  assert.doesNotMatch(prompt, /design\/memory-coherence-procedure\.md/);
  assert.doesNotMatch(prompt, /Memory coherence outcome:/);
  assert.doesNotMatch(prompt, /End your final response with exactly one status line/);
});

test('memory coherence prompt time= reflects claim time, matching reminder envelopes', () => {
  const item = memoryItem('iris', '2026-06-22T05:47:00.000Z');
  item.handling = {
    ...item.handling,
    startedAt: '2026-06-22T06:02:15.000Z',
    status: 'running',
    updatedAt: '2026-06-22T06:02:15.000Z',
    workerId: 'worker-memory',
  };

  const prompt = buildCodeAgentDeliveryPrompt(item);

  assert.match(prompt, /time=2026-06-22T06:02:15Z/);
  assert.match(prompt, /scheduled_slot_at=2026-06-22T05:47:00Z/);
});

test('memory coherence outcome derives from a coarse memory digest change boolean', () => {
  assert.equal(determineMemoryCoherenceOutcome(false), 'quiet_skipped');
  assert.equal(determineMemoryCoherenceOutcome(true), 'completed');
});

test('memory coherence digest changes when MEMORY.md or notes change', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'anima-memory-digest-test-'));
  try {
    const empty = await memoryCoherenceDigest(homePath);
    await writeFile(join(homePath, 'MEMORY.md'), '# Memory\n', 'utf8');
    const memoryWritten = await memoryCoherenceDigest(homePath);
    assert.notEqual(memoryWritten, empty);

    await mkdir(join(homePath, 'notes'), { recursive: true });
    await writeFile(join(homePath, 'notes', 'detail.md.tmp'), 'detail\n', 'utf8');
    await rename(join(homePath, 'notes', 'detail.md.tmp'), join(homePath, 'notes', 'detail.md'));
    const noteMovedIntoPlace = await memoryCoherenceDigest(homePath);
    assert.notEqual(noteMovedIntoPlace, memoryWritten);

    await writeFile(join(homePath, 'scratch.md'), 'outside scope\n', 'utf8');
    assert.equal(await memoryCoherenceDigest(homePath), noteMovedIntoPlace);
  } finally {
    await rm(homePath, { force: true, recursive: true });
  }
});

test('memory coherence summary preserves provider prose without parsing outcome markers', () => {
  assert.equal(memoryCoherenceSummary('No changes needed.'), 'No changes needed.');
  assert.equal(
    memoryCoherenceSummary('No changes needed.\nMemory coherence outcome: quiet_skipped'),
    'No changes needed.\nMemory coherence outcome: quiet_skipped',
  );
  assert.equal(memoryCoherenceSummary(''), undefined);
});

test('memory coherence activity gate requires a message after the latest memory outcome', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-gate-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), false);

      await activityServiceForAgent('aria').record({
        createdAt: '2026-06-22T05:05:00.000Z',
        payload: {
          completedAt: '2026-06-22T05:05:00.000Z',
          outcome: 'quiet_skipped',
          scheduledSlotAt: '2026-06-22T05:00:00.000Z',
          scheduledSlotLabel: '05:00 agent-local',
          startedAt: '2026-06-22T05:04:00.000Z',
        },
        type: 'memory_coherence.outcome',
      });
      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), false);

      const store = new MessageStore('aria');
      await store.appendManyIfAbsent([
        messageRecord('older', '2026-06-22T04:00:00.000Z'),
      ]);
      await store.markLegacyBackfilled();
      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), false);

      await store.appendManyIfAbsent([
        messageRecord('newer', '2026-06-22T06:00:00.000Z'),
      ]);
      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), true);

      // A newer outcome closes the gate again: the gate must key off the
      // LATEST memory_coherence.outcome, not the first one it finds.
      await activityServiceForAgent('aria').record({
        createdAt: '2026-06-22T06:30:00.000Z',
        payload: {
          completedAt: '2026-06-22T06:30:00.000Z',
          outcome: 'completed',
          scheduledSlotAt: '2026-06-22T05:00:00.000Z',
          scheduledSlotLabel: '05:00 agent-local',
          startedAt: '2026-06-22T06:29:00.000Z',
        },
        type: 'memory_coherence.outcome',
      });
      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), false);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

class TestMemoryQueues {
  private readonly byAgent = new Map<string, InboxItem[]>();

  queueForAgent(agentId: string) {
    const items = this.itemsForAgent(agentId);
    return {
      enqueue: async (item: MemoryCoherenceInboxItem) => {
        const existing = items.find((candidate) => candidate.id === item.id);
        if (existing) return { duplicate: true, queued: false };
        items.push(item);
        return { duplicate: false, queued: true };
      },
      list: async () => items,
    };
  }

  itemsForAgent(agentId: string): InboxItem[] {
    const existing = this.byAgent.get(agentId);
    if (existing) return existing;
    const items: InboxItem[] = [];
    this.byAgent.set(agentId, items);
    return items;
  }

  enqueuedIds(): Array<{ agentId: string; item: MemoryCoherenceInboxItem }> {
    return [...this.byAgent.entries()].flatMap(([agentId, items]) =>
      items
        .filter((item): item is MemoryCoherenceInboxItem => item.kind === 'memory_coherence')
        .map((item) => ({ agentId, item })),
    );
  }
}

function memoryItem(agentId: string, scheduledSlotAt: string): MemoryCoherenceInboxItem {
  return {
    handling: {
      createdAt: scheduledSlotAt,
      queuedAt: scheduledSlotAt,
      status: 'queued',
      updatedAt: scheduledSlotAt,
    },
    id: `memory-coherence:${agentId}:2026-06-22`,
    kind: 'memory_coherence',
    receivedAt: scheduledSlotAt,
    scheduledSlotAt,
    scheduledSlotLabel: '05:47 agent-local',
  };
}

function messageRecord(messageId: string, timestamp: string): AgentMessageRecord {
  return {
    direction: 'in',
    kind: 'message',
    messageId,
    source: { id: messageId, kind: 'inbox' },
    text: messageId,
    timestamp,
  };
}

function agent(id: string, options: { connected?: boolean; enabled?: boolean } = {}): AgentConfig {
  const connected = options.connected ?? true;
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    enabled: options.enabled ?? true,
    teamId: 'default',
    feishu: {
      appId: '',
      appSecret: '',
      connected: false,
      encryptKey: '',
      verificationToken: '',
    },
    homePath: `/tmp/${id}`,
    id,
    profile: {
      displayName: id,
      role: 'general purpose',
    },
    provider: {
      kind: 'claude-code',
      model: 'opus',
    },
    slack: {
      appToken: connected ? 'xapp-test' : '',
      botToken: connected ? 'xoxb-test' : '',
      connected,
      manifestVersion: 0,
      teamId: connected ? 'T-test' : '',
      workspaceIconUrl: '',
      workspaceName: connected ? 'Test' : '',
    },
  };
}
