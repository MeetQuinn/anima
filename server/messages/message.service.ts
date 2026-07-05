import type { Activity } from '../../shared/activity.js';
import type {
  AgentMessageDirection,
  AgentMessageHistoryPage,
  AgentMessageRecord,
} from '../../shared/messages.js';
import { normalizeHistoryLimit } from '../../shared/messages.js';
import type { InboxItem } from '../../shared/inbox.js';
import { MessageStore } from '../storage/schema/message.store.js';
import { messageFromActivity, messageFromInboxItem } from './message.projection.js';

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
  ) {}

  async recordInboxItem(item: InboxItem): Promise<{ inserted: boolean; record: AgentMessageRecord } | undefined> {
    const message = messageFromInboxItem(item);
    if (!message) return undefined;
    const result = await this.store.appendIfAbsent(message);
    return { inserted: result.inserted, record: message };
  }

  async recordOutboxActivity(activity: Activity): Promise<AgentMessageRecord | undefined> {
    const message = messageFromActivity(activity);
    if (!message) return undefined;
    await this.store.appendIfAbsent(message);
    return message;
  }

  async list(input: MessageListInput = {}): Promise<AgentMessageHistoryPage> {
    const limit = normalizeHistoryLimit(input.limit);
    const entries = await this.store.readLatest({ ...input, limit: limit + 1 });
    const page = entries.slice(0, limit);
    const nextCursor = entries.length > limit ? (page.at(-1)?.timestamp ?? null) : null;
    return { entries: page, nextCursor };
  }

  async listAll(): Promise<AgentMessageRecord[]> {
    return this.store.readAll();
  }

  async latestMessageAt(): Promise<string | undefined> {
    return (await this.store.readLatest({ limit: 1 }))[0]?.timestamp;
  }

  async search(input: MessageSearchInput): Promise<AgentMessageHistoryPage> {
    const keywords = normalizeSearchKeywords(input.keywords);
    if (keywords.length === 0) return { entries: [], nextCursor: null };
    const limit = normalizeHistoryLimit(input.limit);
    const entries = await this.store.readLatest({
      ...input,
      limit: limit + 1,
      matches: (entry) => messageMatchesKeywords(entry, keywords),
    });
    const page = entries.slice(0, limit);
    const nextCursor = entries.length > limit ? (page.at(-1)?.timestamp ?? null) : null;
    return { entries: page, nextCursor };
  }

  hasInboxItem(itemId: string): Promise<boolean> {
    return this.store.hasMessageId(`msg_inbox:${itemId}`);
  }
}

export function messageServiceForAgent(agentId: string): MessageService {
  return new MessageService(agentId);
}

export function normalizeSearchKeywords(keywords: string[]): string[] {
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
