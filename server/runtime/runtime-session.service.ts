import type { Activity } from '../../shared/activity.js';
import type { ProviderSessionStatsSummary } from '../../shared/snapshot.js';
import { nowIso } from '../ids.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { numberField, stringField } from '../json.js';
import { AgentUsageStore, type AgentUsage } from '../storage/schema/agent-usage.store.js';
import {
  SessionStore,
  currentProviderSessionStartedAt,
  type ProviderSession,
  type Session,
} from '../storage/schema/session.store.js';
import { activitiesForInboxItemWindow } from './item-activities.js';
import { CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW, type ProviderSessionRecord } from '../providers/contract.js';

export type { ProviderSession, Session };

export class RuntimeSessionService {
  constructor(
    private readonly agentId: string,
    private readonly sessionStore: SessionStore = new SessionStore(agentId),
    private readonly usageStore: AgentUsageStore = new AgentUsageStore(agentId),
    private readonly wakeQueue: WakeQueueService = new WakeQueueService(agentId),
  ) {}

  async upsertPrimarySession(): Promise<Session> {
    const existing = await this.sessionStore.read();
    const now = nowIso();
    if (!existing) {
      const session: Session = { createdAt: now, currentStartedAt: now, updatedAt: now };
      await this.sessionStore.write(session);
      return session;
    }
    const updated = await this.sessionStore.update((session) => {
      if (!session) return undefined;
      return {
        ...session,
        currentStartedAt: session.currentStartedAt ?? currentProviderSessionStartedAt(session),
        updatedAt: now,
      };
    });
    return updated ?? existing;
  }

  async persistProviderSession(
    kind: string,
    session: ProviderSessionRecord,
  ): Promise<Session | undefined> {
    let updatedSession: Session | undefined;
    await this.sessionStore.update((stateSession) => {
      if (!stateSession) return undefined;
      const archivedProviderSessions = stateSession.archived ?? [];
      if (
        archivedProviderSessions.some((archivedSession) =>
          archivedSession.kind === kind && archivedSession.id === session.id
        )
      ) {
        updatedSession = stateSession;
        return stateSession;
      }
      const updatedAt = nowIso();
      const nextSession: ProviderSession = {
        ...session,
        kind,
        updatedAt,
      };
      updatedSession = {
        ...stateSession,
        current: nextSession,
        currentStartedAt: stateSession.currentStartedAt ?? currentProviderSessionStartedAt(stateSession),
        updatedAt,
      };
      return updatedSession;
    });
    return updatedSession;
  }

  async updateRuntimeStats(
    runtimeKind: string,
    runtimeEnv: Record<string, string> | undefined,
    activity: Activity,
  ): Promise<Session | undefined> {
    let updated: Session | undefined;
    await this.sessionStore.update((session) => {
      if (!session) return undefined;
      const currentStartedAt = session.currentStartedAt ?? currentProviderSessionStartedAt(session);
      if (activity.createdAt < currentStartedAt) {
        updated = session.currentStartedAt ? session : { ...session, currentStartedAt };
        return updated;
      }

      const latestProviderStats = nextProviderSessionStats(
        session.latestProviderStats,
        activity,
        runtimeKind,
        runtimeEnv,
      );
      if (latestProviderStats === session.latestProviderStats && currentStartedAt === session.currentStartedAt) {
        updated = session;
        return updated;
      }
      updated = {
        ...session,
        currentStartedAt,
        ...(latestProviderStats ? { latestProviderStats } : {}),
        ...(latestProviderStats ? { updatedAt: maxIso(session.updatedAt, activity.createdAt) } : {}),
      };
      return updated;
    });
    return updated;
  }

  async readLifetimeTokens(): Promise<number | undefined> {
    const usage = await this.readUsage();
    return validTokenCount(usage.totalTokens);
  }

  async recordLifetimeTokenUsageForItem(itemId: string): Promise<number | undefined> {
    const item = await this.wakeQueue.find(itemId);
    if (item?.handling.status !== 'completed') return undefined;

    const delta = tokenDeltaForActivities(await activitiesForInboxItemWindow(this.agentId, itemId));
    if (delta === undefined || delta <= 0) return undefined;

    const updatedAt = nowIso();
    const updated = await this.usageStore.update(async (current) => {
      const base = validTokenCount(current.totalTokens) !== undefined ? current : await this.readUsage();
      const totalTokens = (validTokenCount(base.totalTokens) ?? 0) + delta;
      return {
        totalTokens,
        updatedAt,
      };
    });
    const totalTokens = validTokenCount(updated.totalTokens);
    if (totalTokens !== undefined) {
      await this.sessionStore.update((session) =>
        session ? { ...session, lifetimeTokens: totalTokens, updatedAt } : undefined,
      );
    }
    return totalTokens;
  }

  private readUsage(): Promise<AgentUsage> {
    return this.usageStore.read();
  }
}

export function runtimeSessionServiceForAgent(agentId: string): RuntimeSessionService {
  return new RuntimeSessionService(agentId);
}

export function tokenDeltaForActivities(activities: Activity[]): number | undefined {
  const sessionStats = latestActivity(activities, (eventType) => eventType === 'claude.session.stats' || eventType === 'codex.session.stats');
  if (sessionStats) return tokenDeltaFromPayload(sessionStats.payload);

  const kimiStats = latestActivity(activities, (eventType) => eventType === 'kimi.context.stats');
  return kimiStats ? tokenDeltaFromPayload(kimiStats.payload) : undefined;
}

function latestActivity(
  activities: Activity[],
  matches: (eventType: string | undefined) => boolean,
): Activity | undefined {
  let latest: Activity | undefined;
  for (const activity of activities) {
    const eventType = stringField(activity.payload, 'eventType');
    if (!matches(eventType)) continue;
    if (!latest || activity.createdAt > latest.createdAt) latest = activity;
  }
  return latest;
}

function tokenDeltaFromPayload(payload: Activity['payload']): number | undefined {
  const totalTokens = validTokenCount(numberField(payload, 'totalTokens'));
  if (totalTokens !== undefined) return totalTokens;

  const parts = [
    numberField(payload, 'inputTokens'),
    numberField(payload, 'cacheReadInputTokens'),
    numberField(payload, 'cacheCreationInputTokens'),
    numberField(payload, 'outputTokens'),
  ].filter((value): value is number => value !== undefined);
  if (parts.length === 0) return undefined;
  return parts.reduce((sum, value) => sum + value, 0);
}

function validTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nextProviderSessionStats(
  current: ProviderSessionStatsSummary | undefined,
  activity: Activity,
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
): ProviderSessionStatsSummary | undefined {
  const statsPayload = providerSessionStatsPayload(activity.payload);
  if (statsPayload) return mergeSessionStats(current, activity, runtimeKind, runtimeEnv, statsPayload);

  const contextPayload = providerContextStatsPayload(activity.payload);
  if (contextPayload) return mergeContextStats(current, activity, runtimeKind, runtimeEnv, contextPayload);

  if (isCompletedCompactEvent(activity.payload)) {
    return mergeCompactionStats(current, activity, runtimeKind, runtimeEnv);
  }

  return current;
}

function mergeSessionStats(
  current: ProviderSessionStatsSummary | undefined,
  activity: Activity,
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
  payload: Record<string, unknown>,
): ProviderSessionStatsSummary {
  const summary = providerSessionStatsSummary(activity, runtimeKind, runtimeEnv, payload);
  const usedTokens =
    stringField(payload, 'eventType') === 'kimi.context.stats' ? undefined : summary.usedTokens;
  return providerStatsSummary({
    ...summary,
    contextWindow: summary.contextWindow ?? current?.contextWindow,
    currentContextTokens: summary.currentContextTokens ?? current?.currentContextTokens,
    sessionCompactionCount: current?.sessionCompactionCount,
    sessionTokenUsage: addOptional(current?.sessionTokenUsage, usedTokens),
  });
}

function mergeContextStats(
  current: ProviderSessionStatsSummary | undefined,
  activity: Activity,
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
  payload: Record<string, unknown>,
): ProviderSessionStatsSummary {
  const keepProviderStatsStamp = hasProviderSessionStats(current);
  return providerStatsSummary({
    ...(current ?? {}),
    activityId: keepProviderStatsStamp ? current?.activityId : activity.activityId,
    autoCompactWindow: autoCompactWindowFor(runtimeKind, runtimeEnv),
    createdAt: keepProviderStatsStamp ? current?.createdAt : activity.createdAt,
    runtimeKind: stringField(payload, 'runtimeKind') ?? current?.runtimeKind ?? runtimeKind,
    contextWindow: numberField(payload, 'contextWindow') ?? current?.contextWindow,
    currentContextTokens: numberField(payload, 'currentContextTokens') ?? current?.currentContextTokens,
  });
}

function mergeCompactionStats(
  current: ProviderSessionStatsSummary | undefined,
  activity: Activity,
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
): ProviderSessionStatsSummary {
  const keepProviderStatsStamp = hasProviderSessionStats(current);
  return providerStatsSummary({
    ...(current ?? {}),
    activityId: keepProviderStatsStamp ? current?.activityId : activity.activityId,
    autoCompactWindow: autoCompactWindowFor(runtimeKind, runtimeEnv),
    createdAt: keepProviderStatsStamp ? current?.createdAt : activity.createdAt,
    runtimeKind: stringField(activity.payload, 'runtimeKind') ?? current?.runtimeKind ?? runtimeKind,
    sessionCompactionCount: (current?.sessionCompactionCount ?? 0) + 1,
  });
}

function providerSessionStatsSummary(
  activity: Activity,
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
  payload: Record<string, unknown>,
): ProviderSessionStatsSummary {
  const summary = providerStatsSummary({
    activityId: activity.activityId,
    autoCompactWindow: autoCompactWindowFor(runtimeKind, runtimeEnv),
    cacheCreationInputTokens: numberField(payload, 'cacheCreationInputTokens'),
    cacheReadInputTokens: numberField(payload, 'cacheReadInputTokens'),
    contextWindow: numberField(payload, 'contextWindow'),
    createdAt: activity.createdAt,
    currentContextTokens: numberField(payload, 'currentContextTokens'),
    inputTokens: numberField(payload, 'inputTokens'),
    model: stringField(payload, 'model'),
    outputTokens: numberField(payload, 'outputTokens'),
    runtimeKind: stringField(payload, 'runtimeKind') ?? runtimeKind,
    serviceTier: stringField(payload, 'serviceTier'),
    terminalReason: stringField(payload, 'terminalReason'),
    totalTokens: numberField(payload, 'totalTokens'),
  });
  const usedTokens = providerUsedTokens(summary);
  return usedTokens !== undefined ? { ...summary, usedTokens } : summary;
}

function providerStatsSummary(value: Record<string, unknown>): ProviderSessionStatsSummary {
  return compact(value) as unknown as ProviderSessionStatsSummary;
}

function providerSessionStatsPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const eventType = stringField(payload, 'eventType');
  return eventType === 'claude.session.stats' || eventType === 'codex.session.stats' || eventType === 'kimi.context.stats' ? payload : undefined;
}

function providerContextStatsPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const eventType = stringField(payload, 'eventType');
  return eventType === 'claude.context.stats' || eventType === 'codex.context.stats' || eventType === 'kimi.context.stats' ? payload : undefined;
}

function isCompletedCompactEvent(payload: Record<string, unknown> | undefined): boolean {
  return stringField(payload, 'eventType')?.endsWith('.compact.completed') === true;
}

function autoCompactWindowFor(
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
): number | undefined {
  if (runtimeKind !== 'claude-code') return undefined;
  const configured = runtimeEnv?.['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];
  if (configured !== undefined) {
    const value = Number(configured);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  return CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW;
}

function providerUsedTokens(stats: ProviderSessionStatsSummary): number | undefined {
  if (stats.totalTokens !== undefined) return stats.totalTokens;
  const parts = [
    stats.inputTokens,
    stats.cacheReadInputTokens,
    stats.cacheCreationInputTokens,
    stats.outputTokens,
  ].filter((value): value is number => value !== undefined);
  return parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : undefined;
}

function hasProviderSessionStats(stats: ProviderSessionStatsSummary | undefined): boolean {
  return Boolean(
    stats?.usedTokens !== undefined
    || stats?.totalTokens !== undefined
    || stats?.inputTokens !== undefined
    || stats?.outputTokens !== undefined
    || stats?.cacheReadInputTokens !== undefined
    || stats?.cacheCreationInputTokens !== undefined
    || stats?.model !== undefined
    || stats?.serviceTier !== undefined
    || stats?.terminalReason !== undefined,
  );
}

function addOptional(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return (current ?? 0) + next;
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}
