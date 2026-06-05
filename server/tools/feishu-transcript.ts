import type {
  FeishuConversationMention,
  FeishuConversationMessage,
} from '../feishu/client.js';

export interface FeishuTranscriptRequest {
  chatId: string;
  limit: number;
}

export function feishuTranscriptOutput(
  messages: FeishuConversationMessage[],
  request: FeishuTranscriptRequest,
  page: { hasMore: boolean; nextCursor: string },
): string {
  const lines = messages.map((message) => feishuTranscriptLine(message, request));
  if (page.hasMore || page.nextCursor) {
    lines.push(`[page has_more=${String(page.hasMore)} next_cursor=${page.nextCursor || '-'}]`);
  }
  return lines.join('\n');
}

function feishuTranscriptLine(message: FeishuConversationMessage, request: FeishuTranscriptRequest): string {
  const chatId = message.chatId ?? request.chatId;
  const actorId = message.sender?.id;
  const fields = [
    'platform=feishu',
    `chat_id=${chatId}`,
    ...(message.threadId ? [`thread_id=${message.threadId}`] : []),
    `message_id=${message.messageId}`,
    `time=${feishuTimestampToIso(message.createTime)}`,
    ...(actorId ? [`user_id=${actorId}`] : []),
  ];
  return `[${fields.join(' ')}] ${feishuTranscriptActor(message)}: ${feishuTranscriptText(message)}`;
}

function feishuTranscriptActor(message: FeishuConversationMessage): string {
  if (message.sender?.senderName) return message.sender.senderName;
  if (message.sender?.id) return message.sender.id;
  if (message.sender?.senderType) return message.sender.senderType;
  return '@unknown';
}

function feishuTranscriptText(message: FeishuConversationMessage): string {
  if (message.deleted) return '[deleted]';
  const messageType = message.messageType ?? 'message';
  const content = parseFeishuContent(message.bodyContent);
  if (messageType === 'text') {
    const text = typeof content?.['text'] === 'string' ? content['text'] : '';
    return replaceFeishuMentionKeys(text, message.mentions ?? []) || '[empty text]';
  }
  if (messageType === 'image' && typeof content?.['image_key'] === 'string') {
    return `[image] image_key=${content['image_key']}`;
  }
  if (messageType === 'file') {
    const name = typeof content?.['file_name'] === 'string' ? ` name=${content['file_name']}` : '';
    const key = typeof content?.['file_key'] === 'string' ? ` file_key=${content['file_key']}` : '';
    return `[file]${name}${key}`.trimEnd();
  }
  return `[${messageType} message]`;
}

function parseFeishuContent(content: string | undefined): Record<string, unknown> | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function replaceFeishuMentionKeys(text: string, mentions: FeishuConversationMention[]): string {
  let result = text;
  for (const mention of mentions) {
    if (!mention.key || !mention.name) continue;
    result = result.replaceAll(mention.key, `@${mention.name}`);
  }
  return result;
}

function feishuTimestampToIso(timestamp: string | undefined): string {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return timestamp || 'unknown';
  const millis = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : timestamp || 'unknown';
}
