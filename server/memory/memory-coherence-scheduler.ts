import { createHash } from 'node:crypto';

import { DateTime } from 'luxon';

import type { AgentConfig } from '../../shared/agent-config.js';
import { agentHasConnectedTransport } from '../../shared/agent-transports.js';
import type { Activity } from '../../shared/activity.js';
import type { MemoryCoherenceConfig } from '../../shared/server-settings.js';
import type { InboxItem, MemoryCoherenceInboxItem } from '../../shared/inbox.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { isAgentRunnable } from '../agents/agent-config-ops.js';
import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
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
    const activeCount = await this.activeMemoryCoherenceCount(candidates);
    let available = Math.max(0, config.maxConcurrent - activeCount);
    if (available <= 0) return;

    const due = candidates
      .map((agent) => dueMemoryCoherenceSlot(agent, config, now, this.timezoneForAgent(agent, config.timezone)))
      .filter((slot): slot is MemoryCoherenceDueSlot => Boolean(slot))
      .sort((a, b) => a.scheduledSlotAt.localeCompare(b.scheduledSlotAt));

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

export async function hasMeaningfulActivitySinceLastMemoryPass(agentId: string): Promise<boolean> {
  const activities = await activityServiceForAgent(agentId).readAll();
  const latestMemoryPassAt = latestMemoryCoherenceOutcomeAt(activities);
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
  const current = DateTime.fromJSDate(now, { zone: timezone });
  if (!current.isValid) throw new Error(`Invalid memory coherence timezone: ${timezone}`);
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
  const [hourText, minuteText] = windowStart.split(':');
  const hour = Number.parseInt(hourText ?? '', 10);
  const minute = Number.parseInt(minuteText ?? '', 10);
  const start = DateTime.fromObject(
    { day: day.day, hour, minute, month: day.month, year: day.year },
    { zone: timezone },
  );
  if (!start.isValid) {
    throw new Error(`Invalid memory coherence windowStart ${windowStart}: ${start.invalidReason ?? 'invalid'}`);
  }
  return start.plus({ minutes: offsetMinutes });
}

export function stableAgentOffsetMinutes(agentId: string, windowDurationMinutes: number): number {
  const digest = createHash('sha256').update(agentId).digest();
  const value = digest.readUInt32BE(0);
  return value % windowDurationMinutes;
}

function latestMemoryCoherenceOutcomeAt(activities: Activity[]): string | undefined {
  let latest: string | undefined;
  for (const activity of activities) {
    if (activity.type !== 'memory_coherence.outcome') continue;
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
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
