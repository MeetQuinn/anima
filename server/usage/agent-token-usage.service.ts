import { createHash } from 'node:crypto';

import { DateTime } from 'luxon';

import {
  EMPTY_TOKEN_USAGE_TOTALS,
  type AgentTokenUsageDay,
  type AgentTokenUsageReport,
  type AgentTokenUsageSummary,
  type ProviderUsageInput,
  type TokenUsageTotals,
} from '../../shared/agent-token-usage.js';
import { nowIso } from '../ids.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import {
  AgentTokenUsageStore,
  type StoredProviderUsage,
} from '../storage/schema/agent-token-usage.store.js';

export class AgentTokenUsageService {
  constructor(
    private readonly agentId: string,
    private readonly store = new AgentTokenUsageStore(agentId),
  ) {}

  initialize(startedAt = nowIso()): Promise<{ coverageStartedAt?: string }> {
    return this.store.initialize(startedAt);
  }

  async record(itemId: string, runtimeKind: string, usage: ProviderUsageInput): Promise<{ inserted: boolean }> {
    const occurredAt = validIso(usage.occurredAt) ?? nowIso();
    await this.store.initialize(occurredAt);
    const normalized = normalizedUsage(usage);
    const eventId = createHash('sha256')
      .update(`${this.agentId}\0${itemId}\0${runtimeKind}\0${usage.sourceId}`)
      .digest('hex');
    return this.store.insert({
      ...normalized,
      ...(usage.accountId ? { accountId: usage.accountId } : {}),
      eventId,
      itemId,
      ...(usage.model ? { model: usage.model } : {}),
      occurredAt,
      runtimeKind,
      status: hasReportedUsage(normalized) ? 'reported' : 'unavailable',
    });
  }

  async summary(input: {
    agentName: string;
    from: string;
    through: string;
    timezone: string;
  }): Promise<AgentTokenUsageSummary> {
    const range = utcRange(input.from, input.through, input.timezone);
    const { coverageStartedAt, records } = await this.store.listBetween(range.fromUtc, range.throughUtc);
    return summarizeAgent(this.agentId, input.agentName, coverageStartedAt, records, input.timezone);
  }
}

export function agentTokenUsageServiceForAgent(agentId: string): AgentTokenUsageService {
  return new AgentTokenUsageService(agentId);
}

export async function agentTokenUsageReport(input: {
  agentId?: string;
  from: string;
  through: string;
  timezone: string;
}): Promise<AgentTokenUsageReport> {
  const agents = await defaultAgentRegistryService.listAgentConfigs();
  const selected = input.agentId ? agents.filter((agent) => agent.id === input.agentId) : agents;
  if (input.agentId && selected.length === 0) throw new Error(`Agent not found: ${input.agentId}`);
  const summaries = await Promise.all(selected.map(async (agent) => {
    const summary = await agentTokenUsageServiceForAgent(agent.id).summary({
      agentName: agent.profile.displayName,
      from: input.from,
      through: input.through,
      timezone: input.timezone,
    });
    const avatarUrl = configuredAgentAvatarUrl(agent);
    return avatarUrl ? { ...summary, avatarUrl } : summary;
  }));
  const totals = summaries.reduce<TokenUsageTotals>(addSummary, { ...EMPTY_TOKEN_USAGE_TOTALS });
  return {
    ...totals,
    agents: summaries,
    from: input.from,
    reportedRuns: summaries.reduce((sum, summary) => sum + summary.reportedRuns, 0),
    through: input.through,
    timezone: input.timezone,
    unknownRuns: summaries.reduce((sum, summary) => sum + summary.unknownRuns, 0),
  };
}

function configuredAgentAvatarUrl(agent: {
  feishu?: { avatarUrl?: string; connected?: boolean };
  slack?: { avatarUrl?: string; connected?: boolean };
}): string | undefined {
  if (agent.feishu?.connected && agent.feishu.avatarUrl) return agent.feishu.avatarUrl;
  if (agent.slack?.connected && agent.slack.avatarUrl) return agent.slack.avatarUrl;
  return agent.slack?.avatarUrl || agent.feishu?.avatarUrl;
}

function normalizedUsage(usage: ProviderUsageInput): Omit<StoredProviderUsage,
  'eventId' | 'itemId' | 'occurredAt' | 'runtimeKind' | 'status' | 'model' | 'accountId'> {
  const inputTokens = tokenCount(usage.inputTokens);
  const cacheReadInputTokens = tokenCount(usage.cacheReadInputTokens);
  const cacheCreationInputTokens = tokenCount(usage.cacheCreationInputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const reasoningOutputTokens = tokenCount(usage.reasoningOutputTokens);
  const suppliedTotal = tokenCount(usage.totalTokens);
  const parts = [inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens]
    .filter((value): value is number => value !== undefined);
  const totalTokens = suppliedTotal ?? (parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : undefined);
  return {
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function summarizeAgent(
  agentId: string,
  agentName: string,
  coverageStartedAt: string | undefined,
  records: StoredProviderUsage[],
  timezone: string,
): AgentTokenUsageSummary {
  const days = new Map<string, AgentTokenUsageDay>();
  for (const record of records) {
    const date = DateTime.fromISO(record.occurredAt, { setZone: true }).setZone(timezone).toISODate();
    if (!date) continue;
    const day = days.get(date) ?? {
      ...EMPTY_TOKEN_USAGE_TOTALS,
      date,
      reportedRuns: 0,
      unknownRuns: 0,
    };
    if (record.status === 'reported') day.reportedRuns += 1;
    else day.unknownRuns += 1;
    addRecord(day, record);
    days.set(date, day);
  }
  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totals = sortedDays.reduce<TokenUsageTotals>(addSummary, { ...EMPTY_TOKEN_USAGE_TOTALS });
  return {
    ...totals,
    agentId,
    agentName,
    ...(coverageStartedAt ? { coverageStartedAt } : {}),
    days: sortedDays,
    reportedRuns: sortedDays.reduce((sum, day) => sum + day.reportedRuns, 0),
    unknownRuns: sortedDays.reduce((sum, day) => sum + day.unknownRuns, 0),
  };
}

function addRecord(target: TokenUsageTotals, record: StoredProviderUsage): void {
  target.cacheCreationInputTokens += record.cacheCreationInputTokens ?? 0;
  target.cacheReadInputTokens += record.cacheReadInputTokens ?? 0;
  target.inputTokens += record.inputTokens ?? 0;
  target.outputTokens += record.outputTokens ?? 0;
  target.reasoningOutputTokens += record.reasoningOutputTokens ?? 0;
  target.totalTokens += record.totalTokens ?? 0;
}

function addSummary<T extends TokenUsageTotals>(target: TokenUsageTotals, current: T): TokenUsageTotals {
  return {
    cacheCreationInputTokens: target.cacheCreationInputTokens + current.cacheCreationInputTokens,
    cacheReadInputTokens: target.cacheReadInputTokens + current.cacheReadInputTokens,
    inputTokens: target.inputTokens + current.inputTokens,
    outputTokens: target.outputTokens + current.outputTokens,
    reasoningOutputTokens: target.reasoningOutputTokens + current.reasoningOutputTokens,
    totalTokens: target.totalTokens + current.totalTokens,
  };
}

function hasReportedUsage(usage: ReturnType<typeof normalizedUsage>): boolean {
  return Object.values(usage).some((value) => typeof value === 'number');
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.toUTC().toISO() ?? undefined : undefined;
}

function utcRange(from: string, through: string, timezone: string): { fromUtc: string; throughUtc: string } {
  const start = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(through, { zone: timezone }).endOf('day');
  if (!start.isValid || !end.isValid || start > end) throw new Error('Invalid token usage range');
  return {
    fromUtc: start.toUTC().toISO()!,
    throughUtc: end.toUTC().toISO()!,
  };
}
