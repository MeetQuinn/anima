import { nowIso } from '../ids.js';
import {
  feishuMessageAttachmentsFromContent,
  feishuPostPlainTextFromContent,
  parseFeishuContent,
  type FeishuMessageAttachmentMeta,
} from './message-content.js';
import type { FeishuInboxItem, InboxFileMeta } from '../../shared/inbox.js';

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
  const parsedContent = parseFeishuContent(input.event.message.content);
  const files = feishuFilesFromMessage(input.event.message, parsedContent);
  const text = feishuTextFromMessage(input.event.message, parsedContent) ?? feishuAttachmentText(files);
  if (!text && !files.length) return undefined;

  const tenantKey = input.event.tenant_key ?? input.event.sender.tenant_key;
  const appId = input.event.app_id ?? input.appId;
  const handlingAt = nowIso();
  const result: FeishuInboxItem = {
    actor: feishuActor(input.event),
    appId,
    chatId: input.event.message.chat_id,
    chatType: input.event.message.chat_type,
    ...(files.length ? { files } : {}),
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
    text: text ?? '',
    ...(input.event.message.thread_id ? { threadId: input.event.message.thread_id } : {}),
  };
  return result;
}

export function isFeishuEvent(event: unknown): event is FeishuInboxItem {
  return Boolean(event && typeof event === 'object' && (event as { kind?: unknown }).kind === 'feishu');
}

export function shouldWakeFeishuRuntime(event: FeishuReceiveMessageEvent, botOpenId?: string): boolean {
  if (event.message.chat_type === 'p2p') return true;
  return feishuMessageMentionsBot(event, botOpenId);
}

export function feishuMessageMentionsBot(event: FeishuReceiveMessageEvent, botOpenId?: string): boolean {
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

function feishuTextFromMessage(
  message: FeishuReceiveMessageEvent['message'],
  parsed: Record<string, unknown> | undefined,
): string | undefined {
  const rawText = message.message_type === 'text'
    ? (typeof parsed?.['text'] === 'string' ? parsed['text'] : undefined)
    : message.message_type === 'post'
      ? feishuPostPlainTextFromContent(parsed)
      : undefined;
  if (!rawText?.trim()) return undefined;
  return replaceFeishuMentionKeys(rawText, message.mentions ?? []);
}

function feishuFilesFromMessage(
  message: FeishuReceiveMessageEvent['message'],
  parsed: Record<string, unknown> | undefined,
): InboxFileMeta[] {
  return feishuMessageAttachmentsFromContent({
    content: parsed,
    messageId: message.message_id,
    messageType: message.message_type,
  }).map(inboxFileMeta);
}

function inboxFileMeta(file: FeishuMessageAttachmentMeta): InboxFileMeta {
  return {
    id: file.fileId,
    mimetype: file.mimetype,
    name: file.name,
    sizeBytes: file.sizeBytes ?? 0,
  };
}

function feishuAttachmentText(files: InboxFileMeta[]): string | undefined {
  if (!files.length) return undefined;
  if (files.length > 1) return `[${files.length} attachments]`;
  const file = files[0];
  if (!file) return undefined;
  if (file.mimetype.startsWith('audio/')) return `[audio] ${file.name}`;
  if (file.mimetype.startsWith('video/')) return `[video] ${file.name}`;
  if (file.id.includes(':image:')) return `[image] ${file.name}`;
  return `[file] ${file.name}`;
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
