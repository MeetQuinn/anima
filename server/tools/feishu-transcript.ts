import type {
  FeishuConversationMention,
  FeishuConversationMessage,
} from '../feishu/client.js';
import {
  feishuMessageAttachmentsFromContent,
  feishuPostPlainTextFromContent,
  parseFeishuContent,
  type FeishuMessageAttachmentMeta,
} from '../feishu/message-content.js';

export interface FeishuTranscriptRequest {
  chatId: string;
  chatName?: string;
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
    ...(request.chatName ? [`chat_name=${quoteEnvelopeValue(request.chatName)}`] : []),
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
  if (messageType === 'post') {
    const text = feishuPostPlainTextFromContent(content) ?? '';
    return replaceFeishuMentionKeys(text, message.mentions ?? []) || '[empty rich text]';
  }
  if (messageType === 'image' && typeof content?.['image_key'] === 'string') {
    const attachment = feishuTranscriptAttachmentMeta(message, content);
    return [
      `[image] image_key=${content['image_key']}`,
      attachment ? feishuTranscriptAttachment({ fileId: attachment.fileId }) : '',
    ].filter(Boolean).join('\n');
  }
  if (messageType === 'file') {
    const attachment = feishuTranscriptAttachmentMeta(message, content);
    const fileKey = attachment?.fileKey ?? '';
    const name = attachment?.providedName ?? '';
    const sizeBytes = attachment?.sizeBytes;
    const summary = `[file]${name ? ` name=${name}` : ''}${fileKey ? ` file_key=${fileKey}` : ''}`.trimEnd();
    return attachment
      ? [
          summary,
          feishuTranscriptAttachment({
            fileId: attachment.fileId,
            ...(name ? { name } : {}),
            ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          }),
        ].join('\n')
      : summary;
  }
  return `[${messageType} message]`;
}

function feishuTranscriptAttachmentMeta(
  message: FeishuConversationMessage,
  content: Record<string, unknown> | undefined,
): FeishuMessageAttachmentMeta | undefined {
  return feishuMessageAttachmentsFromContent({
    content,
    messageId: message.messageId,
    messageType: message.messageType,
  })[0];
}

function feishuTranscriptAttachment(input: {
  fileId: string;
  name?: string;
  sizeBytes?: number;
}): string {
  const name = input.name ? ` name=${input.name}` : '';
  const size = input.sizeBytes !== undefined ? ` size_bytes=${input.sizeBytes}` : '';
  return `  attached: id=${input.fileId}${name}${size} (use \`anima file fetch ${input.fileId}\` to download)`;
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

function quoteEnvelopeValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
