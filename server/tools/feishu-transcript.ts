import type {
  FeishuConversationMention,
  FeishuConversationMessage,
} from '../feishu/client.js';
import { feishuMessageResourceId } from '../feishu/feishu-file.service.js';

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
    return [
      `[image] image_key=${content['image_key']}`,
      feishuTranscriptAttachment({
        fileKey: content['image_key'],
        messageId: message.messageId,
        resourceType: 'image',
      }),
    ].join('\n');
  }
  if (messageType === 'file') {
    const fileKey = typeof content?.['file_key'] === 'string' ? content['file_key'] : '';
    const name = typeof content?.['file_name'] === 'string' ? content['file_name'] : '';
    const sizeBytes = feishuFileSize(content);
    const summary = `[file]${name ? ` name=${name}` : ''}${fileKey ? ` file_key=${fileKey}` : ''}`.trimEnd();
    return fileKey
      ? [
          summary,
          feishuTranscriptAttachment({
            fileKey,
            messageId: message.messageId,
            name,
            resourceType: 'file',
            sizeBytes,
          }),
        ].join('\n')
      : summary;
  }
  return `[${messageType} message]`;
}

function feishuTranscriptAttachment(input: {
  fileKey: string;
  messageId: string;
  name?: string;
  resourceType: 'file' | 'image';
  sizeBytes?: number;
}): string {
  const id = feishuMessageResourceId({
    fileKey: input.fileKey,
    messageId: input.messageId,
    resourceType: input.resourceType,
  });
  const name = input.name ? ` name=${input.name}` : '';
  const size = input.sizeBytes !== undefined ? ` size_bytes=${input.sizeBytes}` : '';
  return `  attached: id=${id}${name}${size} (use \`anima file fetch ${id}\` to download)`;
}

function feishuFileSize(content: Record<string, unknown> | undefined): number | undefined {
  const candidates = [content?.['file_size'], content?.['size'], content?.['size_bytes']];
  const numeric = candidates.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (numeric !== undefined) return numeric;
  const stringValue = candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  const parsed = stringValue === undefined ? Number.NaN : Number(stringValue);
  return Number.isFinite(parsed) ? parsed : undefined;
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
