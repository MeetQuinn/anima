import type { FeishuInboxItem } from '../../shared/inbox.js';
import { nowIso } from '../ids.js';
import {
  getFeishuDirectoryStore,
  type FeishuDirectoryChatInfo,
  type FeishuDirectoryFile,
  type FeishuDirectoryUserInfo,
} from '../storage/schema/cache.js';
import type {
  FeishuChatInfo,
  FeishuConversationMention,
  FeishuConversationMessage,
  FeishuMessageClient,
  FeishuUserBasicInfo,
} from './client.js';
import type { FeishuReceiveMessageEvent } from './events.js';

export const FEISHU_DIRECTORY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class FeishuDirectoryService {
  constructor(private readonly input: {
    directoryId: string;
    now?: () => string;
    ttlMs?: number;
  }) {}

  async enrichInboxItem(input: {
    client?: FeishuMessageClient;
    item: FeishuInboxItem;
    receiveEvent?: FeishuReceiveMessageEvent;
  }): Promise<FeishuInboxItem> {
    if (input.receiveEvent) await this.applyReceiveEvent(input.receiveEvent);

    let item = await this.enrichFromCache(input.item);
    const needsActor = Boolean(item.actor?.openId && !item.actor.displayName);
    const needsChat = Boolean(item.chatId && !item.chatName);

    if (needsActor && input.client?.getMessage) {
      const message = await bestEffort(async () => input.client?.getMessage?.({ messageId: item.messageId }));
      if (message) {
        await this.applyConversationMessages([message]);
        item = await this.enrichFromCache(item);
      }
    }

    if (item.actor?.openId && !item.actor.displayName && input.client?.getUserBasics) {
      const openId = item.actor.openId;
      const users = await bestEffort(async () => input.client?.getUserBasics?.({ openIds: [openId] }));
      if (users?.length) {
        await this.applyUserBasics(users);
        item = await this.enrichFromCache(item);
      }
    }

    if (needsChat && input.client?.getChat) {
      const chat = await bestEffort(async () => input.client?.getChat?.({ chatId: item.chatId }));
      if (chat) {
        await this.applyChat(chat);
        item = await this.enrichFromCache(item);
      }
    }

    return item;
  }

  async enrichFromCache(item: FeishuInboxItem): Promise<FeishuInboxItem> {
    const [user, chat] = await Promise.all([
      item.actor?.openId ? this.getCachedUser(item.actor.openId) : undefined,
      item.chatId ? this.getCachedChat(item.chatId) : undefined,
    ]);
    return {
      ...item,
      ...(chat?.chatName && !item.chatName ? { chatName: chat.chatName } : {}),
      ...(chat?.chatType && item.chatType === 'unknown' ? { chatType: chat.chatType } : {}),
      ...(user?.displayName && item.actor && !item.actor.displayName ? {
        actor: {
          ...item.actor,
          displayName: user.displayName,
          ...(user.unionId && !item.actor.unionId ? { unionId: user.unionId } : {}),
          ...(user.userId && !item.actor.userId ? { userId: user.userId } : {}),
        },
      } : {}),
    };
  }

  async getCachedChat(chatId: string): Promise<FeishuDirectoryChatInfo | undefined> {
    return this.readCache((cache) => cache.chats.find((chat) => chat.chatId === chatId));
  }

  async getCachedUser(openId: string): Promise<FeishuDirectoryUserInfo | undefined> {
    return this.readCache((cache) => cache.users.find((user) => user.openId === openId));
  }

  async getChat(input: {
    chatId: string;
    client?: FeishuMessageClient;
  }): Promise<FeishuDirectoryChatInfo | undefined> {
    const cached = await this.getCachedChat(input.chatId);
    if (cached && this.isFresh(cached.updatedAt)) return cached;
    if (!input.client?.getChat) return cached;
    const chat = await bestEffort(async () => input.client?.getChat?.({ chatId: input.chatId }));
    if (!chat) return cached;
    return this.applyChat(chat);
  }

  async applyReceiveEvent(event: FeishuReceiveMessageEvent): Promise<void> {
    const users = (event.message.mentions ?? []).flatMap((mention) => {
      const openId = mention.id.open_id?.trim();
      const displayName = mention.name?.trim();
      if (!openId || !displayName) return [];
      return [{
        displayName,
        openId,
        ...(mention.id.union_id ? { unionId: mention.id.union_id } : {}),
        ...(mention.id.user_id ? { userId: mention.id.user_id } : {}),
      }];
    });
    if (users.length) await this.applyUsers(users);
  }

  async applyConversationMessages(messages: FeishuConversationMessage[]): Promise<void> {
    const users: Array<{
      displayName?: string;
      openId: string;
      unionId?: string;
      userId?: string;
    }> = [];
    for (const message of messages) {
      const senderOpenId = message.sender?.id?.trim();
      if (senderOpenId) {
        users.push({
          ...(message.sender?.senderName ? { displayName: message.sender.senderName } : {}),
          openId: senderOpenId,
        });
      }
      for (const mention of message.mentions ?? []) {
        const mentionUser = userFromMention(mention);
        if (mentionUser) users.push(mentionUser);
      }
    }
    if (users.length) await this.applyUsers(users);
  }

  async applyUserBasics(users: FeishuUserBasicInfo[]): Promise<void> {
    await this.applyUsers(users.map((user) => ({
      openId: user.openId,
      ...(preferredUserDisplayName(user) ? { displayName: preferredUserDisplayName(user) } : {}),
      ...(user.i18nName ? { i18nName: user.i18nName } : {}),
      ...(user.unionId ? { unionId: user.unionId } : {}),
      ...(user.userId ? { userId: user.userId } : {}),
    })));
  }

  async applyChat(chat: FeishuChatInfo): Promise<FeishuDirectoryChatInfo | undefined> {
    if (!chat.chatId) return undefined;
    const updatedAt = this.now();
    const next: FeishuDirectoryChatInfo = {
      ...(chat.avatarUrl ? { avatarUrl: chat.avatarUrl } : {}),
      chatId: chat.chatId,
      ...(chat.chatName ? { chatName: chat.chatName } : {}),
      ...(chat.chatType ? { chatType: chat.chatType } : {}),
      updatedAt,
    };
    await this.updateCache((cache) => ({
      ...cache,
      chats: upsertBy(cache.chats, next, (entry) => entry.chatId),
    }));
    return next;
  }

  private async applyUsers(users: Array<{
    displayName?: string;
    i18nName?: Record<string, string>;
    openId: string;
    unionId?: string;
    userId?: string;
  }>): Promise<void> {
    const updatedAt = this.now();
    const nextUsers = users.flatMap((user): FeishuDirectoryUserInfo[] => {
      const openId = user.openId.trim();
      if (!openId) return [];
      return [{
        ...(user.displayName ? { displayName: user.displayName } : {}),
        ...(user.i18nName ? { i18nName: user.i18nName } : {}),
        openId,
        ...(user.unionId ? { unionId: user.unionId } : {}),
        updatedAt,
        ...(user.userId ? { userId: user.userId } : {}),
      }];
    });
    if (!nextUsers.length) return;
    await this.updateCache((cache) => ({
      ...cache,
      users: nextUsers.reduce(
        (users, user) => upsertBy(users, user, (entry) => entry.openId),
        cache.users,
      ),
    }));
  }

  private isFresh(timestamp: string | undefined): boolean {
    if (!timestamp) return false;
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) return false;
    const now = new Date(this.now()).getTime();
    return Number.isFinite(now) && now - time < (this.input.ttlMs ?? FEISHU_DIRECTORY_CACHE_TTL_MS);
  }

  private now(): string {
    return this.input.now?.() ?? nowIso();
  }

  private async readCache<T>(select: (cache: FeishuDirectoryFile) => T): Promise<T> {
    return select(await getFeishuDirectoryStore(this.input.directoryId).read());
  }

  private async updateCache(update: (cache: FeishuDirectoryFile) => FeishuDirectoryFile): Promise<void> {
    await getFeishuDirectoryStore(this.input.directoryId).update(update);
  }
}

export function feishuDirectoryId(input: {
  appId?: string;
  tenantKey?: string;
}): string | undefined {
  return input.tenantKey?.trim() || input.appId?.trim() || undefined;
}

function userFromMention(mention: FeishuConversationMention): {
  displayName?: string;
  openId: string;
} | undefined {
  const openId = mention.id?.trim();
  if (!openId) return undefined;
  return {
    ...(mention.name ? { displayName: mention.name } : {}),
    openId,
  };
}

function preferredUserDisplayName(user: FeishuUserBasicInfo): string | undefined {
  return user.name?.trim()
    || user.i18nName?.zh_cn?.trim()
    || user.i18nName?.en_us?.trim()
    || Object.values(user.i18nName ?? {}).find((value) => value.trim())?.trim()
    || undefined;
}

function upsertBy<T>(entries: T[], next: T, key: (entry: T) => string): T[] {
  const nextKey = key(next);
  const index = entries.findIndex((entry) => key(entry) === nextKey);
  if (index < 0) return [...entries, next];
  return entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...next } : entry);
}

async function bestEffort<T>(op: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await op();
  } catch {
    return undefined;
  }
}
