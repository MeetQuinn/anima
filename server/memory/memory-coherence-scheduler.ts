import { createHash } from 'node:crypto';

import type { DateTime } from 'luxon';

import type { AgentConfig } from '../../shared/agent-config.js';
import { agentHasConnectedTransport } from '../../shared/agent-transports.js';
import type { MemoryCoherenceConfig } from '../../shared/server-settings.js';
import type { InboxItem, MemoryCoherenceInboxItem } from '../../shared/inbox.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { isAgentRunnable } from '../agents/agent-config-ops.js';
import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { systemTimezone, timeOnLocalDay, zonedDateTime } from '../schedule/local-time.js';
import { serverConfigStore, type ServerConfig } from '../storage/schema/server.store.js';

const DEFAULT_WINDOW_START = '05:00';
const DEFAULT_WINDOW_DURATION_MINUTES = 120;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_TIMEZONE = 'agent-local';

export interface MemoryCoherenceSchedulerConfig {
  enabled: boolean;
  maxConcurrent: number;
  scopeAgentIds: string[];
  timezone: string;
  windowDurationMinutes: number;
  windowStart: string;
}

export interface MemoryCoherenceQueue {
  enqueue(item: MemoryCoherenceInboxItem): Promise<{ duplicate: boolean; queued: boolean }>;
  list(): Promise<InboxItem[]>;
}

export interface MemoryCoherenceSchedulerDeps {
  hasMeaningfulActivitySinceLastPass?: (agentId: string) => Promise<boolean>;
  now?: () => Date;
  queueForAgent?: (agentId: string) => MemoryCoherenceQueue;
  readServerConfig?: () => Promise<ServerConfig>;
  timezoneForAgent?: (agent: AgentConfig, requested: string) => string;
}

export class MemoryCoherenceScheduler {
  private readonly now: () => Date;
  private readonly hasMeaningfulActivitySinceLastPass: (agentId: string) => Promise<boolean>;
  private readonly queueForAgent: (agentId: string) => MemoryCoherenceQueue;
  private readonly readServerConfig: () => Promise<ServerConfig>;
  private readonly timezoneForAgent: (agent: AgentConfig, requested: string) => string;

  constructor(deps: MemoryCoherenceSchedulerDeps = {}) {
    this.hasMeaningfulActivitySinceLastPass =
      deps.hasMeaningfulActivitySinceLastPass ?? hasMeaningfulActivitySinceLastMemoryPass;
    this.now = deps.now ?? (() => new Date());
    this.queueForAgent = deps.queueForAgent ?? ((agentId) => wakeQueueServiceForAgent(agentId));
    this.readServerConfig = deps.readServerConfig ?? (() => serverConfigStore.read());
    this.timezoneForAgent = deps.timezoneForAgent ?? defaultTimezoneForAgent;
  }

  async reconcile(agents: AgentConfig[]): Promise<void> {
    const config = normalizeMemoryCoherenceConfig((await this.readServerConfig()).memoryCoherence);
    if (!config.enabled) return;

    const candidates = memoryCoherenceAgents(agents, config);
    if (candidates.length === 0) return;

    const now = this.now();
    // Due-slot computation is pure time math, so it runs before any file I/O.
    // Note: with the 2-day catchup window ([0, -1]) every candidate always has
    // a most-recent slot, so `due` is only empty when there are no candidates;
    // it is the enqueue-side settled-id dedupe (wake-queue `seen` markers) and
    // the activity gate that make this loop a no-op on most ticks.
    const due = candidates
      .map((agent) => dueMemoryCoherenceSlot(agent, config, now, this.timezoneForAgent(agent, config.timezone)))
      .filter((slot): slot is MemoryCoherenceDueSlot => Boolean(slot))
      .sort((a, b) => a.scheduledSlotAt.localeCompare(b.scheduledSlotAt));
    if (due.length === 0) return;

    const activeCount = await this.activeMemoryCoherenceCount(candidates);
    let available = Math.max(0, config.maxConcurrent - activeCount);
    if (available <= 0) return;

    for (const slot of due) {
      if (available <= 0) break;
      if (!await this.hasMeaningfulActivitySinceLastPass(slot.agent.id)) continue;
      const queue = this.queueForAgent(slot.agent.id);
      const result = await queue.enqueue(memoryCoherenceInboxItem(slot, now));
      if (result.queued) available -= 1;
    }
  }

  private async activeMemoryCoherenceCount(agents: AgentConfig[]): Promise<number> {
    let count = 0;
    for (const agent of agents) {
      for (const item of await this.queueForAgent(agent.id).list()) {
        if (item.kind !== 'memory_coherence') continue;
        const status = item.handling.status;
        if (status === 'queued' || status === 'running') count += 1;
      }
    }
    return count;
  }
}

// Activity gate: enqueue a pass only if the message ledger has at least one
// entry newer than the latest memory_coherence.outcome. This couples the gate
// to two projection rules that must hold for it to stay correct:
// - memory_coherence outcomes are recorded to the activity log for EVERY
//   terminal state (success and failure alike), so a failed pass still
//   advances the gate instead of retrying forever;
// - memory_coherence items never project into the message ledger (see
//   message.projection.ts), so a pass cannot count as the "meaningful
//   activity" that justifies the next pass.
export async function hasMeaningfulActivitySinceLastMemoryPass(agentId: string): Promise<boolean> {
  const latestMemoryPassAt = await latestMemoryCoherenceOutcomeAt(agentId);
  const latestMessages = await messageServiceForAgent(agentId).list({
    limit: 1,
    ...(latestMemoryPassAt ? { since: latestMemoryPassAt } : {}),
  });
  const latestMessageAt = latestMessages.entries[0]?.timestamp;
  if (!latestMessageAt) return false;
  return !latestMemoryPassAt || latestMessageAt > latestMemoryPassAt;
}

export function normalizeMemoryCoherenceConfig(
  raw: MemoryCoherenceConfig | undefined,
): MemoryCoherenceSchedulerConfig {
  return {
    enabled: raw?.enabled === true,
    maxConcurrent: raw?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    scopeAgentIds: raw?.scopeAgentIds ?? [],
    timezone: raw?.timezone ?? DEFAULT_TIMEZONE,
    windowDurationMinutes: raw?.windowDurationMinutes ?? DEFAULT_WINDOW_DURATION_MINUTES,
    windowStart: raw?.windowStart ?? DEFAULT_WINDOW_START,
  };
}

export function memoryCoherenceAgents(
  agents: AgentConfig[],
  config: MemoryCoherenceSchedulerConfig,
): AgentConfig[] {
  const scoped = new Set(config.scopeAgentIds);
  return agents
    .filter((agent) => scoped.size === 0 || scoped.has(agent.id))
    .filter((agent) => agent.enabled !== false && agentHasConnectedTransport(agent) && isAgentRunnable(agent));
}

interface MemoryCoherenceDueSlot {
  agent: AgentConfig;
  localDate: string;
  scheduledSlotAt: string;
  scheduledSlotLabel: string;
}

function dueMemoryCoherenceSlot(
  agent: AgentConfig,
  config: MemoryCoherenceSchedulerConfig,
  now: Date,
  timezone: string,
): MemoryCoherenceDueSlot | undefined {
  const current = zonedDateTime(now, timezone);
  const offsetMinutes = stableAgentOffsetMinutes(agent.id, config.windowDurationMinutes);
  const candidates = [0, -1]
    .map((dayOffset) => slotForLocalDay(current.plus({ days: dayOffset }), config.windowStart, offsetMinutes, timezone))
    .filter((slot) => slot <= current)
    .sort((a, b) => b.toMillis() - a.toMillis());
  const slot = candidates[0];
  if (!slot) return undefined;
  const labelTime = slot.toFormat('HH:mm');
  return {
    agent,
    localDate: slot.minus({ minutes: offsetMinutes }).toISODate() ?? slot.toISODate() ?? slot.toFormat('yyyy-LL-dd'),
    scheduledSlotAt: slot.toUTC().toISO() ?? slot.toJSDate().toISOString(),
    scheduledSlotLabel: `${labelTime} agent-local`,
  };
}

function slotForLocalDay(day: DateTime, windowStart: string, offsetMinutes: number, timezone: string): DateTime {
  return timeOnLocalDay(day, windowStart, timezone, 'memory coherence windowStart').plus({ minutes: offsetMinutes });
}

export function stableAgentOffsetMinutes(agentId: string, windowDurationMinutes: number): number {
  const digest = createHash('sha256').update(agentId).digest();
  const value = digest.readUInt32BE(0);
  return value % windowDurationMinutes;
}

// Outcomes are appended at completion time, so the newest few records by
// position contain the latest completion; reading newest-first avoids loading
// the full activity log on every reconcile tick. A small window (rather than
// exactly one) keeps the max-of-completedAt semantics robust to near-
// simultaneous appends.
const LATEST_OUTCOME_WINDOW = 5;

async function latestMemoryCoherenceOutcomeAt(agentId: string): Promise<string | undefined> {
  const outcomes = await activityServiceForAgent(agentId).readNewestMatching(
    LATEST_OUTCOME_WINDOW,
    (activity) => activity.type === 'memory_coherence.outcome',
  );
  let latest: string | undefined;
  for (const activity of outcomes) {
    const completedAt = typeof activity.payload?.completedAt === 'string'
      ? activity.payload.completedAt
      : activity.createdAt;
    if (!latest || completedAt > latest) latest = completedAt;
  }
  return latest;
}

function memoryCoherenceInboxItem(slot: MemoryCoherenceDueSlot, now: Date): MemoryCoherenceInboxItem {
  const receivedAt = now.toISOString();
  return {
    handling: {
      createdAt: receivedAt,
      queuedAt: receivedAt,
      status: 'queued',
      updatedAt: receivedAt,
    },
    id: `memory-coherence:${slot.agent.id}:${slot.localDate}`,
    kind: 'memory_coherence',
    receivedAt,
    scheduledSlotAt: slot.scheduledSlotAt,
    scheduledSlotLabel: slot.scheduledSlotLabel,
  };
}

function defaultTimezoneForAgent(_agent: AgentConfig, requested: string): string {
  if (requested !== 'agent-local') return requested;
  return systemTimezone();
}
