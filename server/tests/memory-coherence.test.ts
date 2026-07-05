import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Activity } from '../../shared/activity.js';
import type { AgentMessageRecord } from '../../shared/messages.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import type { InboxItem, MemoryCoherenceInboxItem } from '../../shared/inbox.js';
import {
  DEFAULT_MEMORY_COHERENCE_CONSOLIDATION_THRESHOLD_BYTES,
  MemoryCoherenceConfig,
} from '../../shared/server-settings.js';
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

test('memory coherence config accepts consolidation threshold', () => {
  assert.equal(
    MemoryCoherenceConfig.parse({ consolidationThresholdBytes: 2048 }).consolidationThresholdBytes,
    2048,
  );
  assert.throws(() => MemoryCoherenceConfig.parse({ consolidationThresholdBytes: 0 }));
});

test('memory coherence prompt renders exact maintenance copy with memory size', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'anima-memory-prompt-test-'));
  try {
    await writeFile(join(homePath, 'MEMORY.md'), Buffer.alloc(1536, 'a'));

    const prompt = buildCodeAgentDeliveryPrompt(memoryItem('iris', '2026-06-22T05:47:00.000Z'), {
      memoryCoherence: {
        consolidationThresholdBytes: 2048,
        homePath,
      },
    });

    assert.equal(prompt, [
      'Memory coherence system wake:',
      '',
      '[time=2026-06-22T05:47:00Z scheduled=2026-06-22T05:47:00Z slot=05:47 agent-local]',
      '',
      'You are running your scheduled memory pass. Your `MEMORY.md` is currently 1.5 KB.',
      '',
      'Read `MEMORY.md` as if you had just recovered from a context reset: it is the first thing the recovered you would see. What reads as noise? What open obligation is missing? Which recorded fact no longer matches the world? Fix what you find; if your notes record friction from a real recovery since the last pass, fix those spots first.',
      '',
      'If it all reads clean and current, leaving it alone is the right call. Do not churn to look busy.',
    ].join('\n'));
    assert.doesNotMatch(prompt, /design\/memory-coherence-procedure\.md/);
    assert.doesNotMatch(prompt, /Memory coherence outcome:/);
  } finally {
    await rm(homePath, { force: true, recursive: true });
  }
});

test('memory coherence prompt renders exact consolidation copy above threshold', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'anima-memory-prompt-test-'));
  try {
    await writeFile(join(homePath, 'MEMORY.md'), Buffer.alloc(2560, 'a'));

    const prompt = buildCodeAgentDeliveryPrompt(memoryItem('iris', '2026-06-22T05:47:00.000Z'), {
      memoryCoherence: {
        consolidationThresholdBytes: 2048,
        homePath,
      },
    });

    assert.equal(prompt, [
      'Memory coherence system wake:',
      '',
      '[time=2026-06-22T05:47:00Z scheduled=2026-06-22T05:47:00Z slot=05:47 agent-local]',
      '',
      'You are running your scheduled memory pass. Your `MEMORY.md` is currently 2.5 KB, above the 2.0 KB consolidation threshold: this pass is structural consolidation, not routine upkeep.',
      '',
      'Read `MEMORY.md` as if you had just recovered from a context reset, and keep a line only if the recovering you needs it to take over correctly; everything else becomes a pointer into your `notes/`. Work in this order: first copy the full current `MEMORY.md` verbatim into a `notes/` archive file, so nothing can be lost. Then restructure: demote closed work to one-line pointers, merge duplicates, correct stale facts, keep open obligations sharp. If your notes record friction from a real recovery, fix those spots first.',
      '',
      'Do not delete anything that has not landed in `notes/` first. If the size turns out to be genuinely open work rather than leftovers, trimming little is a legitimate outcome.',
    ].join('\n'));
  } finally {
    await rm(homePath, { force: true, recursive: true });
  }
});

test('memory coherence prompt uses the default consolidation threshold', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'anima-memory-prompt-test-'));
  try {
    await writeFile(
      join(homePath, 'MEMORY.md'),
      Buffer.alloc(DEFAULT_MEMORY_COHERENCE_CONSOLIDATION_THRESHOLD_BYTES + 512, 'a'),
    );

    const prompt = buildCodeAgentDeliveryPrompt(memoryItem('iris', '2026-06-22T05:47:00.000Z'), {
      memoryCoherence: { homePath },
    });

    assert.match(
      prompt,
      /Your `MEMORY\.md` is currently 16\.5 KB, above the 16\.0 KB consolidation threshold/,
    );
  } finally {
    await rm(homePath, { force: true, recursive: true });
  }
});

test('memory coherence prompt treats equal threshold as maintenance', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'anima-memory-prompt-test-'));
  try {
    await writeFile(join(homePath, 'MEMORY.md'), Buffer.alloc(2048, 'a'));

    const prompt = buildCodeAgentDeliveryPrompt(memoryItem('iris', '2026-06-22T05:47:00.000Z'), {
      memoryCoherence: {
        consolidationThresholdBytes: 2048,
        homePath,
      },
    });

    assert.match(prompt, /Your `MEMORY\.md` is currently 2\.0 KB\./);
    assert.doesNotMatch(prompt, /consolidation threshold/);
  } finally {
    await rm(homePath, { force: true, recursive: true });
  }
});

test('memory coherence prompt omits size fact when MEMORY.md cannot be read', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'anima-memory-prompt-test-'));
  try {
    const prompt = buildCodeAgentDeliveryPrompt(memoryItem('iris', '2026-06-22T05:47:00.000Z'), {
      memoryCoherence: {
        consolidationThresholdBytes: 2048,
        homePath,
      },
    });

    assert.equal(prompt, [
      'Memory coherence system wake:',
      '',
      '[time=2026-06-22T05:47:00Z scheduled=2026-06-22T05:47:00Z slot=05:47 agent-local]',
      '',
      'You are running your scheduled memory pass.',
      '',
      'Read `MEMORY.md` as if you had just recovered from a context reset: it is the first thing the recovered you would see. What reads as noise? What open obligation is missing? Which recorded fact no longer matches the world? Fix what you find; if your notes record friction from a real recovery since the last pass, fix those spots first.',
      '',
      'If it all reads clean and current, leaving it alone is the right call. Do not churn to look busy.',
    ].join('\n'));
    assert.doesNotMatch(prompt, /currently/);
  } finally {
    await rm(homePath, { force: true, recursive: true });
  }
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
  assert.match(prompt, /scheduled=2026-06-22T05:47:00Z slot=05:47 agent-local/);
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

test('memory coherence activity gate matches legacy decisions across rotated logs', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-rotated-gate-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeRotatedGateFixture(stateDir, 'aria');

      assert.equal(await legacyMeaningfulActivityGate('aria'), true);
      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), true);

      await activityServiceForAgent('aria').record(memoryOutcomeActivity(
        'latest-outcome',
        '2026-06-22T06:30:00.000Z',
      ));

      assert.equal(await legacyMeaningfulActivityGate('aria'), false);
      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), false);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('memory coherence activity gate ignores irrelevant older message archives', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-ledger-bound-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const agentDir = join(stateDir, 'agents/aria');
      const archiveDir = join(agentDir, 'messages.archive');
      await mkdir(archiveDir, { recursive: true });

      await writeMessageJsonl(join(archiveDir, '0000000000001-messages-000.jsonl'), [
        messageRecord('ancient-1', '2025-01-01T00:00:00.000Z'),
        messageRecord('ancient-2', '2025-01-02T00:00:00.000Z'),
      ]);
      await writeMessageJsonl(join(archiveDir, '0000000000002-messages-000.jsonl'), [
        messageRecord('before-since', '2026-06-21T00:00:00.000Z'),
      ]);
      await writeMessageJsonl(join(agentDir, 'messages.jsonl'), [
        messageRecord('after-since', '2026-06-22T06:00:00.000Z'),
      ]);

      const store = new MessageStore('aria');
      assert.equal((await store.readAll()).length, 4);

      const oldestArchive = (await readdir(archiveDir)).sort((a, b) => a.localeCompare(b))[0];
      assert.ok(oldestArchive);
      await writeFile(join(archiveDir, oldestArchive), '{not-json}\n', 'utf8');
      await assert.rejects(store.readAll(), SyntaxError);

      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), true);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('memory coherence activity gate with zero outcomes stops before old activity archives', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-memory-coherence-zero-outcome-bound-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const agentDir = join(stateDir, 'agents/aria');
      const archiveDir = join(agentDir, 'activity.archive');
      await mkdir(archiveDir, { recursive: true });

      await writeActivityJsonl(join(archiveDir, '0000000000001-activity-000.jsonl'), [
        runtimeActivity('old-activity', '2025-01-01T00:00:00.000Z'),
      ]);
      await writeActivityJsonl(join(agentDir, 'activity.jsonl'), [
        runtimeActivity('before-message', '2026-06-22T05:59:59.000Z'),
      ]);
      await new MessageStore('aria').appendManyIfAbsent([
        messageRecord('live-message', '2026-06-22T06:00:00.000Z'),
      ]);

      const oldestArchive = (await readdir(archiveDir)).sort((a, b) => a.localeCompare(b))[0];
      assert.ok(oldestArchive);
      await writeFile(join(archiveDir, oldestArchive), '{not-json}\n', 'utf8');
      await assert.rejects(activityServiceForAgent('aria').readAll(), SyntaxError);

      assert.equal(await hasMeaningfulActivitySinceLastMemoryPass('aria'), true);
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

async function writeRotatedGateFixture(stateDir: string, agentId: string): Promise<void> {
  const agentDir = join(stateDir, 'agents', agentId);
  const activityArchiveDir = join(agentDir, 'activity.archive');
  const messageArchiveDir = join(agentDir, 'messages.archive');
  await mkdir(activityArchiveDir, { recursive: true });
  await mkdir(messageArchiveDir, { recursive: true });

  await writeActivityJsonl(join(activityArchiveDir, '0000000000001-activity-000.jsonl'), [
    runtimeActivity('old-runtime', '2026-06-21T23:00:00.000Z'),
  ]);
  await writeActivityJsonl(join(activityArchiveDir, '0000000000002-activity-000.jsonl'), [
    memoryOutcomeActivity('archived-outcome', '2026-06-22T05:05:00.000Z'),
  ]);
  await writeActivityJsonl(join(agentDir, 'activity.jsonl'), [
    runtimeActivity('live-runtime', '2026-06-22T06:00:30.000Z'),
  ]);

  await writeMessageJsonl(join(messageArchiveDir, '0000000000001-messages-000.jsonl'), [
    messageRecord('old-message', '2026-06-22T04:00:00.000Z'),
  ]);
  await writeMessageJsonl(join(agentDir, 'messages.jsonl'), [
    messageRecord('new-message', '2026-06-22T06:00:00.000Z'),
  ]);
}

async function legacyMeaningfulActivityGate(agentId: string): Promise<boolean> {
  const outcomes = (await activityServiceForAgent(agentId).readAll())
    .filter((activity) => activity.type === 'memory_coherence.outcome')
    .reverse()
    .slice(0, 5);
  let latestMemoryPassAt: string | undefined;
  for (const activity of outcomes) {
    const completedAt = completedAtForTestOutcome(activity);
    if (!latestMemoryPassAt || completedAt > latestMemoryPassAt) latestMemoryPassAt = completedAt;
  }

  const latestMessageAt = (await new MessageStore(agentId).readAll())
    .reverse()
    .find((entry) => !latestMemoryPassAt || entry.timestamp >= latestMemoryPassAt)
    ?.timestamp;
  if (!latestMessageAt) return false;
  return !latestMemoryPassAt || latestMessageAt > latestMemoryPassAt;
}

function completedAtForTestOutcome(activity: Activity): string {
  return typeof activity.payload?.completedAt === 'string'
    ? activity.payload.completedAt
    : activity.createdAt;
}

function memoryOutcomeActivity(activityId: string, createdAt: string): Activity {
  return {
    activityId,
    createdAt,
    payload: {
      completedAt: createdAt,
      outcome: 'quiet_skipped',
      scheduledSlotAt: '2026-06-22T05:00:00.000Z',
      scheduledSlotLabel: '05:00 agent-local',
      startedAt: createdAt,
    },
    type: 'memory_coherence.outcome',
  };
}

function runtimeActivity(activityId: string, createdAt: string): Activity {
  return {
    activityId,
    createdAt,
    type: 'runtime.event',
  };
}

async function writeActivityJsonl(path: string, records: Activity[]): Promise<void> {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

async function writeMessageJsonl(path: string, records: AgentMessageRecord[]): Promise<void> {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
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
