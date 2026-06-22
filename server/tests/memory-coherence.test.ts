import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentConfig } from '../../shared/agent-config.js';
import type { InboxItem, MemoryCoherenceInboxItem } from '../../shared/inbox.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import {
  MemoryCoherenceScheduler,
  stableAgentOffsetMinutes,
} from '../memory/memory-coherence-scheduler.js';
import {
  memoryCoherenceSummary,
  parseMemoryCoherenceOutcome,
} from '../memory/memory-coherence-outcome.js';

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

test('memory coherence prompt includes the exact outcome marker contract', () => {
  const prompt = buildCodeAgentDeliveryPrompt(memoryItem('iris', '2026-06-22T05:47:00.000Z'));

  assert.match(prompt, /^Memory coherence system wake:/);
  assert.match(prompt, /scheduled_slot_at=2026-06-22T05:47:00\.000Z/);
  assert.match(prompt, /Full procedure: `\.\.\/\.\.\/design\/memory-coherence-procedure\.md`/);
  assert.match(prompt, /Boundary: edit only your own `MEMORY\.md` and files under `notes\/`/);
  assert.match(prompt, /End your final response with exactly one status line/);
  assert.match(prompt, /`Memory coherence outcome: completed`/);
  assert.match(prompt, /`Memory coherence outcome: quiet_skipped`/);
});

test('memory coherence outcome parser only accepts the exact quiet-skip marker', () => {
  assert.equal(parseMemoryCoherenceOutcome('No changes.\nMemory coherence outcome: quiet_skipped'), 'quiet_skipped');
  assert.equal(parseMemoryCoherenceOutcome('Updated notes.\nMemory coherence outcome: completed'), 'completed');
  assert.equal(parseMemoryCoherenceOutcome('quiet_skipped'), 'completed');
  assert.equal(parseMemoryCoherenceOutcome(undefined), 'completed');
});

test('memory coherence summary removes the exact final marker', () => {
  assert.equal(
    memoryCoherenceSummary('No changes needed.\nMemory coherence outcome: quiet_skipped'),
    'No changes needed.',
  );
  assert.equal(memoryCoherenceSummary('Memory coherence outcome: completed'), undefined);
  assert.equal(memoryCoherenceSummary('Malformed marker: quiet_skipped'), 'Malformed marker: quiet_skipped');
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

function agent(id: string, options: { connected?: boolean; enabled?: boolean } = {}): AgentConfig {
  const connected = options.connected ?? true;
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    enabled: options.enabled ?? true,
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
