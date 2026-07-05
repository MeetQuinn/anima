import { dateKey } from '@/lib/format';
import { buildActivityFeed, buildMessageFeed, type ActivityFeedItem } from '@/lib/activity-feed';
import { isNarrativeStep } from '@/lib/activities';
import { isMessageItem } from '@/views/agents/conversation/SlackTimeline';
import type { Activity as ActivityRecord, AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';

export type Step = Extract<ActivityFeedItem, { kind: 'step' }>;

export type DayBlock = { type: 'msgs' | 'steps' | 'system'; items: ActivityFeedItem[] };

export type TimelineEntry =
  | { type: 'conv'; ts: number; timestamp: string; item: ActivityFeedItem }
  | { type: 'lifecycle'; ts: number; timestamp: string; step: Step }
  | { type: 'fold'; ts: number; timestamp: string; id: string; steps: Step[] };

type TimelineAtom =
  | { ts: number; timestamp: string; kind: 'conv'; item: ActivityFeedItem }
  | { ts: number; timestamp: string; kind: 'lifecycle'; step: Step }
  | { ts: number; timestamp: string; kind: 'fold'; step: Step };

export function mergeActivityPages(
  pages: AgentActivityFeedPage[] | undefined,
): Pick<AgentActivityFeedPage, 'events'> | undefined {
  if (!pages?.length) return undefined;
  const eventMap = new Map<string, ActivityRecord>();
  for (const page of pages) {
    for (const event of page.events ?? []) {
      eventMap.set(event.activityId, event);
    }
  }
  return { events: Array.from(eventMap.values()) };
}

export function mergeMessagePages(
  pages: AgentMessageHistoryPage[] | undefined,
): Pick<AgentMessageHistoryPage, 'entries'> | undefined {
  if (!pages?.length) return undefined;
  const messageMap = new Map<string, AgentMessageRecord>();
  for (const page of pages) {
    for (const entry of page.entries ?? []) {
      messageMap.set(entry.messageId, entry);
    }
  }
  return { entries: Array.from(messageMap.values()) };
}

export function buildConversationItems(
  messagesData: Pick<AgentMessageHistoryPage, 'entries'> | undefined,
): ActivityFeedItem[] {
  if (!messagesData) return [];
  return buildMessageFeed(messagesData).filter(
    (item) => isMessageItem(item) || item.kind === 'system-event',
  );
}

export function buildStepItems(
  activitiesData: Pick<AgentActivityFeedPage, 'events'> | undefined,
): Step[] {
  if (!activitiesData) return [];
  const feed = buildActivityFeed(activitiesData, false);
  const failedProviderToolIds = new Set<string>();
  for (const item of feed) {
    if (item.kind === 'step' && item.activity.type === 'tool.call.failed') {
      const pid = item.activity.payload?.['providerToolId'];
      if (typeof pid === 'string' && pid) failedProviderToolIds.add(pid);
    }
  }
  return feed.filter((item): item is Step => {
    if (item.kind !== 'step') return false;
    if (!isNarrativeStep(item.activity)) return false;
    if (item.activity.type === 'tool.call.started' && failedProviderToolIds.size > 0) {
      const pid = item.activity.payload?.['providerToolId'];
      if (typeof pid === 'string' && pid && failedProviderToolIds.has(pid)) return false;
    }
    return true;
  });
}

export function sortConversationItems(conversationItems: ActivityFeedItem[]): ActivityFeedItem[] {
  return [...conversationItems].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function latestMessageKey(conversationItems: ActivityFeedItem[]): string | null {
  if (conversationItems.length === 0) return null;
  let maxTs = conversationItems[0]!.timestamp;
  for (const item of conversationItems) {
    if (item.timestamp > maxTs) maxTs = item.timestamp;
  }
  return `${conversationItems.length}|${maxTs}`;
}

export function isSpecialSystemStep(activity: ActivityRecord): boolean {
  return activity.type === 'runtime.aborted' || activity.type === 'memory_coherence.outcome';
}

export function atomRank(
  kind: 'conv-in' | 'conv-out' | 'lifecycle' | 'fold',
  idle: boolean,
): number {
  if (kind === 'conv-in') return 0;
  if (kind === 'conv-out') return 1;
  if (kind === 'lifecycle') return 2;
  return idle ? 4 : 3;
}

export function buildBlocks(items: ActivityFeedItem[]): DayBlock[] {
  const blocks: DayBlock[] = [];
  for (const item of items) {
    const type: DayBlock['type'] =
      item.kind === 'step' ? 'steps' : item.kind === 'system-event' ? 'system' : 'msgs';
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.items.push(item);
    else blocks.push({ type, items: [item] });
  }
  return blocks;
}

export function buildTimelineByDay(
  conversationItems: ActivityFeedItem[],
  stepItems: Step[],
): [string, TimelineEntry[]][] {
  const atoms: TimelineAtom[] = [];
  for (const item of conversationItems) {
    const ts = Date.parse(item.timestamp);
    if (Number.isFinite(ts)) atoms.push({ ts, timestamp: item.timestamp, kind: 'conv', item });
  }
  for (const step of stepItems) {
    const ts = Date.parse(step.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (isSpecialSystemStep(step.activity)) {
      atoms.push({ ts, timestamp: step.timestamp, kind: 'lifecycle', step });
    } else {
      atoms.push({ ts, timestamp: step.timestamp, kind: 'fold', step });
    }
  }

  const rankOf = (atom: TimelineAtom): number => {
    if (atom.kind === 'conv') {
      return atomRank(atom.item.kind === 'message-in' ? 'conv-in' : 'conv-out', false);
    }
    if (atom.kind === 'lifecycle') return atomRank('lifecycle', false);
    return atomRank('fold', atom.step.activity.type === 'runtime.completed');
  };

  const days = new Map<string, TimelineAtom[]>();
  for (const atom of atoms) {
    const key = dateKey(atom.timestamp);
    const list = days.get(key);
    if (list) list.push(atom);
    else days.set(key, [atom]);
  }

  const result: [string, TimelineEntry[]][] = [];
  for (const [day, list] of days) {
    list.sort((a, b) => a.ts - b.ts || rankOf(a) - rankOf(b));
    const entries: TimelineEntry[] = [];
    let pending: Step[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const first = pending[0]!;
      entries.push({
        type: 'fold',
        ts: Date.parse(first.timestamp),
        timestamp: first.timestamp,
        id: `fold:${first.activity.activityId}`,
        steps: pending,
      });
      pending = [];
    };
    for (const atom of list) {
      if (atom.kind === 'fold') {
        pending.push(atom.step);
        continue;
      }
      flush();
      if (atom.kind === 'conv') {
        entries.push({ type: 'conv', ts: atom.ts, timestamp: atom.timestamp, item: atom.item });
      } else {
        entries.push({ type: 'lifecycle', ts: atom.ts, timestamp: atom.timestamp, step: atom.step });
      }
    }
    flush();
    result.push([day, entries]);
  }
  result.sort(([a], [b]) => a.localeCompare(b));
  return result;
}

export function oldestConversationTimestamp(conversationItems: ActivityFeedItem[]): number | null {
  let min = Infinity;
  for (const item of conversationItems) {
    const timestamp = Date.parse(item.timestamp);
    if (Number.isFinite(timestamp) && timestamp < min) min = timestamp;
  }
  return min === Infinity ? null : min;
}

export function oldestActivityTimestamp(
  activitiesData: Pick<AgentActivityFeedPage, 'events'> | undefined,
): number | null {
  if (!activitiesData?.events.length) return null;
  let min = Infinity;
  for (const event of activitiesData.events) {
    const timestamp = Date.parse(event.createdAt);
    if (Number.isFinite(timestamp) && timestamp < min) min = timestamp;
  }
  return min === Infinity ? null : min;
}

export function activityCoverageDecision(input: {
  oldestMessageTs: number | null;
  oldestActivityTs: number | null;
  interleaving: boolean;
  hasNextActivityPage: boolean;
  isFetchingNextActivityPage: boolean;
}): { activityCoversMessages: boolean; shouldFetchMoreActivity: boolean } {
  const activityCoversMessages =
    input.oldestMessageTs === null ||
    (input.oldestActivityTs !== null && input.oldestActivityTs <= input.oldestMessageTs);
  return {
    activityCoversMessages,
    shouldFetchMoreActivity:
      input.interleaving &&
      !activityCoversMessages &&
      input.hasNextActivityPage &&
      !input.isFetchingNextActivityPage,
  };
}

export function latestCurrentItemActivity(input: {
  currentItemId: string | undefined;
  currentItemStartedAt: string | undefined;
  activitiesData: Pick<AgentActivityFeedPage, 'events'> | undefined;
}): ActivityRecord | undefined {
  if (!input.currentItemId || !input.activitiesData) return undefined;
  const activities = input.activitiesData.events;
  const itemActivities = input.currentItemStartedAt
    ? activities.filter((activity) => activity.createdAt >= input.currentItemStartedAt!)
    : activities;
  if (!itemActivities.length) return undefined;
  return itemActivities.reduce((latest, activity) =>
    activity.createdAt > latest.createdAt ? activity : latest,
  );
}

export function currentTurnHasStep(input: {
  currentItemId: string | undefined;
  currentItemStartedAt: string | undefined;
  stepItems: Step[];
}): boolean {
  if (!input.currentItemId || !input.currentItemStartedAt) return false;
  return input.stepItems.some(
    (item) =>
      item.activity.createdAt >= input.currentItemStartedAt! &&
      !isSpecialSystemStep(item.activity),
  );
}
