import { nowIso } from '../ids.js';
import type { FeishuInboxItem } from '../../shared/inbox.js';

export interface FeishuReceiveMessageEvent {
  app_id?: string;
  create_time?: string;
  event_id?: string;
  message: {
    chat_id: string;
    chat_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      id: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
      };
      key: string;
      mentioned_type?: string;
      name: string;
      tenant_key?: string;
    }>;
    message_id: string;
    message_type: string;
    parent_id?: string;
    root_id?: string;
    thread_id?: string;
  };
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  tenant_key?: string;
  ts?: string;
}

export function feishuReceiveMessageEventFromData(data: unknown): FeishuReceiveMessageEvent | undefined {
  if (isFeishuReceiveMessageEvent(data)) return data;
  if (data && typeof data === 'object') {
    const maybeEvent = (data as { event?: unknown }).event;
    if (isFeishuReceiveMessageEvent(maybeEvent)) return maybeEvent;
  }
  return undefined;
}

export function normalizeFeishuMessage(input: {
  appId?: string;
  botOpenId?: string;
  event: FeishuReceiveMessageEvent;
}): FeishuInboxItem | undefined {
  const text = feishuTextFromMessage(input.event.message);
  if (!text) return undefined;
  if (!shouldWakeFeishuRuntime(input.event, input.botOpenId)) return undefined;

  const tenantKey = input.event.tenant_key ?? input.event.sender.tenant_key;
  const appId = input.event.app_id ?? input.appId;
  const handlingAt = nowIso();
  const result: FeishuInboxItem = {
    actor: feishuActor(input.event),
    appId,
    chatId: input.event.message.chat_id,
    chatType: input.event.message.chat_type,
    handling: { createdAt: handlingAt, queuedAt: handlingAt, status: 'queued', updatedAt: handlingAt },
    id: feishuMessageEventId({
      appId,
      chatId: input.event.message.chat_id,
      messageId: input.event.message.message_id,
      tenantKey,
    }),
    kind: 'feishu',
    messageId: input.event.message.message_id,
    ...(input.event.message.parent_id ? { parentId: input.event.message.parent_id } : {}),
    rawContent: input.event.message.content,
    receivedAt: feishuTimestampToIso(input.event.message.create_time),
    ...(input.event.message.root_id ? { rootId: input.event.message.root_id } : {}),
    ...(tenantKey ? { tenantKey } : {}),
    text,
    ...(input.event.message.thread_id ? { threadId: input.event.message.thread_id } : {}),
  };
  return result;
}

export function shouldWakeFeishuRuntime(event: FeishuReceiveMessageEvent, botOpenId?: string): boolean {
  if (event.message.chat_type === 'p2p') return true;
  const mentions = event.message.mentions ?? [];
  if (botOpenId) return mentions.some((mention) => mention.id.open_id === botOpenId);
  return mentions.length > 0;
}

export function feishuMessageEventId(input: {
  appId?: string;
  chatId: string;
  messageId: string;
  tenantKey?: string;
}): string {
  return `feishu:${input.tenantKey ?? input.appId ?? 'unknown-tenant'}:${input.chatId}:${input.messageId}`;
}

function feishuActor(event: FeishuReceiveMessageEvent): FeishuInboxItem['actor'] {
  const senderId = event.sender.sender_id;
  if (!senderId && !event.sender.sender_type) return undefined;
  return {
    ...(senderId?.open_id ? { openId: senderId.open_id } : {}),
    ...(event.sender.sender_type ? { senderType: event.sender.sender_type } : {}),
    ...(senderId?.union_id ? { unionId: senderId.union_id } : {}),
    ...(senderId?.user_id ? { userId: senderId.user_id } : {}),
  };
}

function feishuTextFromMessage(message: FeishuReceiveMessageEvent['message']): string | undefined {
  if (message.message_type !== 'text') return undefined;
  const parsed = parseFeishuContent(message.content);
  const rawText = typeof parsed?.['text'] === 'string' ? parsed['text'] : undefined;
  if (!rawText?.trim()) return undefined;
  return replaceFeishuMentionKeys(rawText, message.mentions ?? []);
}

function parseFeishuContent(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function replaceFeishuMentionKeys(
  text: string,
  mentions: NonNullable<FeishuReceiveMessageEvent['message']['mentions']>,
): string {
  let result = text;
  for (const mention of mentions) {
    if (!mention.key || !mention.name) continue;
    result = result.replaceAll(mention.key, `@${mention.name}`);
  }
  return result;
}

function isFeishuReceiveMessageEvent(data: unknown): data is FeishuReceiveMessageEvent {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<FeishuReceiveMessageEvent>;
  return Boolean(
    value.message
      && typeof value.message === 'object'
      && typeof value.message.chat_id === 'string'
      && typeof value.message.chat_type === 'string'
      && typeof value.message.content === 'string'
      && typeof value.message.create_time === 'string'
      && typeof value.message.message_id === 'string'
      && typeof value.message.message_type === 'string'
      && value.sender
      && typeof value.sender === 'object',
  );
}

function feishuTimestampToIso(timestamp: string | undefined): string {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return nowIso();
  const millis = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : nowIso();
}
