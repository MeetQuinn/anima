import type { Activity } from '../../shared/activity.js';
import type {
  AgentMessageDirection,
  AgentMessageHistoryPage,
  AgentMessageRecord,
} from '../../shared/messages.js';
import type { InboxItem } from '../../shared/inbox.js';
import { ActivityStore } from '../storage/schema/activity.store.js';
import { WakeQueueStore } from '../storage/schema/wake-queue.store.js';
import { MessageStore } from '../storage/schema/message.store.js';
import { messageFromActivity, messageFromInboxItem } from './message.projection.js';
import { messageMatchesChannel } from './channel-match.js';

export interface MessageListInput {
  before?: string;
  channel?: string;
  direction?: AgentMessageDirection;
  limit?: number;
  since?: string;
}

export interface MessageSearchInput {
  before?: string;
  channel?: string;
  keywords: string[];
  limit?: number;
  since?: string;
}

export class MessageService {
  constructor(
    agentId: string,
    private readonly store: MessageStore = new MessageStore(agentId),
    private readonly wakeQueueStore: WakeQueueStore = new WakeQueueStore(agentId),
    private readonly activityStore: ActivityStore = new ActivityStore(agentId),
  ) {}

  async recordInboxItem(item: InboxItem): Promise<AgentMessageRecord | undefined> {
    const message = messageFromInboxItem(item);
    if (!message) return undefined;
    await this.store.appendIfAbsent(message);
    return message;
  }

  async recordOutboxActivity(activity: Activity): Promise<AgentMessageRecord | undefined> {
    const message = messageFromActivity(activity);
    if (!message) return undefined;
    await this.store.appendIfAbsent(message);
    return message;
  }

  async list(input: MessageListInput = {}): Promise<AgentMessageHistoryPage> {
    await this.backfillLegacyMessages();
    const limit = normalizeMessageLimit(input.limit);
    const entries = await this.store.readLatest({ ...input, limit: limit + 1 });
    const page = entries.slice(0, limit);
    const nextCursor = entries.length > limit ? (page.at(-1)?.timestamp ?? null) : null;
    return { entries: page, nextCursor };
  }

  async search(input: MessageSearchInput): Promise<AgentMessageHistoryPage> {
    await this.backfillLegacyMessages();
    const keywords = normalizeSearchKeywords(input.keywords);
    if (keywords.length === 0) return { entries: [], nextCursor: null };
    const limit = normalizeMessageLimit(input.limit);
    const entries = (await this.store.readAll())
      .filter((entry) =>
        (!input.before || entry.timestamp < input.before) &&
        (!input.since || entry.timestamp >= input.since) &&
        (!input.channel || messageMatchesChannel(entry, input.channel)) &&
        messageMatchesKeywords(entry, keywords)
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const page = entries.slice(0, limit);
    const nextCursor = entries.length > limit ? (page.at(-1)?.timestamp ?? null) : null;
    return { entries: page, nextCursor };
  }

  legacyBackfilled(): Promise<boolean> {
    return this.store.legacyBackfilled();
  }

  private async backfillLegacyMessages(): Promise<void> {
    if (await this.store.legacyBackfilled()) return;
    const [inboxItems, activities] = await Promise.all([
      this.wakeQueueStore.list(),
      this.activityStore.readAll(),
    ]);
    const messages: AgentMessageRecord[] = [];
    for (const item of inboxItems) {
      const message = messageFromInboxItem(item);
      if (message) messages.push(message);
    }
    for (const activity of activities) {
      const message = messageFromActivity(activity);
      if (message) messages.push(message);
    }
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    await this.store.appendManyIfAbsent(messages);
    await this.store.markLegacyBackfilled();
  }
}

export function messageServiceForAgent(agentId: string): MessageService {
  return new MessageService(agentId);
}

function normalizeMessageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(1, Math.trunc(limit as number)), 500);
}

function normalizeSearchKeywords(keywords: string[]): string[] {
  return keywords
    .flatMap((keyword) => keyword.split(/\s+/g))
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
}

function messageMatchesKeywords(entry: AgentMessageRecord, keywords: string[]): boolean {
  const haystack = [
    entry.actor,
    entry.actorDisplayName,
    entry.actorHandle,
    entry.channelDisplayName,
    entry.channelId,
    entry.channelKind,
    entry.channelName,
    entry.dmHandle,
    entry.dmUserId,
    entry.messageTs,
    entry.platform,
    entry.reminderId,
    entry.reminderTitle,
    entry.text,
    entry.threadTs,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase();
  return keywords.every((keyword) => haystack.includes(keyword));
}
