import type {
  FeishuConversationMention,
  FeishuConversationMessage,
} from '../feishu/client.js';
import { renderEnvelope, renderPageFooter } from '../messages/envelope.js';
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
    lines.push(renderPageFooter(page));
  }
  return lines.join('\n');
}

function feishuTranscriptLine(message: FeishuConversationMessage, request: FeishuTranscriptRequest): string {
  const envelope = renderEnvelope([
    { key: 'platform', value: 'feishu' },
    { key: 'chat_id', value: message.chatId ?? request.chatId },
    { key: 'chat_name', value: request.chatName, quoted: true },
    { key: 'thread_id', value: message.threadId },
    { key: 'message_id', value: message.messageId },
    { key: 'time', value: feishuTimestampToIso(message.createTime) },
    { key: 'user_id', value: message.sender?.id },
  ]);
  return `${envelope} ${feishuTranscriptActor(message)}: ${feishuTranscriptText(message)}`;
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
  if (messageType === 'audio') {
    const attachment = feishuTranscriptAttachmentMeta(message, content);
    const durationMs = typeof content?.['duration'] === 'number' ? content['duration'] : undefined;
    const durationSec = durationMs !== undefined ? Math.round(durationMs / 1000) : undefined;
    const summary = `[audio]${durationSec !== undefined ? ` duration=${durationSec}s` : ''}`;
    return attachment
      ? [summary, feishuTranscriptAttachment({ fileId: attachment.fileId })].join('\n')
      : summary;
  }
  if (messageType === 'media') {
    const attachments = feishuMessageAttachmentsFromContent({
      content,
      messageId: message.messageId,
      messageType: message.messageType,
    });
    const videoAttachment = attachments.find((a) => a.resourceType === 'file');
    const durationMs = typeof content?.['video_duration'] === 'number' ? content['video_duration'] : undefined;
    const durationSec = durationMs !== undefined ? Math.round(durationMs / 1000) : undefined;
    const width = typeof content?.['width'] === 'number' ? content['width'] : undefined;
    const height = typeof content?.['height'] === 'number' ? content['height'] : undefined;
    const meta = [
      durationSec !== undefined ? `duration=${durationSec}s` : '',
      width !== undefined && height !== undefined ? `${width}x${height}` : '',
    ].filter(Boolean).join(' ');
    const summary = `[media]${meta ? ` ${meta}` : ''}`;
    return videoAttachment
      ? [summary, feishuTranscriptAttachment({ fileId: videoAttachment.fileId })].join('\n')
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
