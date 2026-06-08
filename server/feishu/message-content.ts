import {
  feishuMessageResourceId,
  type FeishuMessageResourceType,
} from './feishu-file.service.js';

export interface FeishuMessageAttachmentMeta {
  fileId: string;
  fileKey: string;
  messageId: string;
  mimetype: string;
  name: string;
  providedName?: string;
  resourceType: FeishuMessageResourceType;
  sizeBytes?: number;
}

export function parseFeishuContent(content: string | undefined): Record<string, unknown> | undefined {
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

export function feishuMessageAttachmentsFromContent(input: {
  content: Record<string, unknown> | undefined;
  messageId: string;
  messageType: string | undefined;
}): FeishuMessageAttachmentMeta[] {
  if (input.messageType === 'image') {
    const imageKey = stringContentField(input.content, 'image_key');
    if (!imageKey) return [];
    return [attachmentMeta({
      fileKey: imageKey,
      messageId: input.messageId,
      mimetype: stringContentField(input.content, 'mime_type')
        ?? stringContentField(input.content, 'mimetype')
        ?? 'image/*',
      name: fallbackFeishuResourceName('image', input.messageId),
      resourceType: 'image',
      sizeBytes: feishuFileSize(input.content),
    })];
  }

  if (input.messageType === 'file') {
    const fileKey = stringContentField(input.content, 'file_key');
    if (!fileKey) return [];
    const providedName = stringContentField(input.content, 'file_name');
    return [attachmentMeta({
      fileKey,
      messageId: input.messageId,
      mimetype: stringContentField(input.content, 'mime_type')
        ?? stringContentField(input.content, 'mimetype')
        ?? 'application/octet-stream',
      name: providedName ?? fallbackFeishuResourceName('file', input.messageId),
      ...(providedName ? { providedName } : {}),
      resourceType: 'file',
      sizeBytes: feishuFileSize(input.content),
    })];
  }

  if (input.messageType === 'sticker') {
    // Some sticker messages expose an image_key that can be fetched as an image resource.
    const imageKey = stringContentField(input.content, 'image_key');
    if (!imageKey) return [];
    return [attachmentMeta({
      fileKey: imageKey,
      messageId: input.messageId,
      mimetype: 'image/*',
      name: fallbackFeishuResourceName('image', input.messageId),
      resourceType: 'image',
    })];
  }

  if (input.messageType === 'audio') {
    const fileKey = stringContentField(input.content, 'file_key');
    if (!fileKey) return [];
    return [attachmentMeta({
      fileKey,
      messageId: input.messageId,
      mimetype: 'audio/opus',
      name: `${fallbackFeishuResourceName('audio', input.messageId)}.opus`,
      resourceType: 'audio',
    })];
  }

  if (input.messageType === 'media') {
    const fileKey = stringContentField(input.content, 'file_key');
    if (!fileKey) return [];
    const results: FeishuMessageAttachmentMeta[] = [attachmentMeta({
      fileKey,
      messageId: input.messageId,
      mimetype: 'video/mp4',
      name: `${fallbackFeishuResourceName('file', input.messageId)}.mp4`,
      resourceType: 'file',
    })];
    const imageKey = stringContentField(input.content, 'image_key');
    if (imageKey) {
      results.push(attachmentMeta({
        fileKey: imageKey,
        messageId: input.messageId,
        mimetype: 'image/*',
        name: fallbackFeishuResourceName('image', input.messageId),
        resourceType: 'image',
      }));
    }
    return results;
  }

  if (input.messageType === 'post') {
    return feishuPostInlineAttachmentsFromContent(input.content, input.messageId);
  }

  return [];
}

export function feishuPostPlainTextFromContent(content: Record<string, unknown> | undefined): string | undefined {
  for (const section of feishuPostSections(content)) {
    const lines = [
      stringContentField(section, 'title'),
      ...feishuPostParagraphs(section['content']),
    ].filter((line): line is string => Boolean(line?.trim()));
    if (lines.length) return lines.join('\n');
  }
  return undefined;
}

function feishuPostInlineAttachmentsFromContent(
  content: Record<string, unknown> | undefined,
  messageId: string,
): FeishuMessageAttachmentMeta[] {
  const results: FeishuMessageAttachmentMeta[] = [];
  for (const section of feishuPostSections(content)) {
    const paragraphs = section['content'];
    if (!Array.isArray(paragraphs)) continue;
    for (const paragraph of paragraphs) {
      const items = Array.isArray(paragraph) ? paragraph : [paragraph];
      for (const item of items) {
        if (!isRecord(item)) continue;
        const tag = stringContentField(item, 'tag');
        if (tag === 'img') {
          const imageKey = stringContentField(item, 'image_key');
          if (imageKey) {
            results.push(attachmentMeta({
              fileKey: imageKey,
              messageId,
              mimetype: 'image/*',
              name: fallbackFeishuResourceName('image', messageId),
              resourceType: 'image',
            }));
          }
        } else if (tag === 'media') {
          const fileKey = stringContentField(item, 'file_key');
          if (fileKey) {
            results.push(attachmentMeta({
              fileKey,
              messageId,
              mimetype: 'video/mp4',
              name: `${fallbackFeishuResourceName('file', messageId)}.mp4`,
              resourceType: 'file',
            }));
          }
        }
      }
    }
  }
  return results;
}

function attachmentMeta(input: {
  fileKey: string;
  messageId: string;
  mimetype: string;
  name: string;
  providedName?: string;
  resourceType: FeishuMessageResourceType;
  sizeBytes?: number;
}): FeishuMessageAttachmentMeta {
  return {
    fileId: feishuMessageResourceId({
      fileKey: input.fileKey,
      messageId: input.messageId,
      resourceType: input.resourceType,
    }),
    fileKey: input.fileKey,
    messageId: input.messageId,
    mimetype: input.mimetype,
    name: input.name,
    ...(input.providedName ? { providedName: input.providedName } : {}),
    resourceType: input.resourceType,
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
  };
}

function stringContentField(content: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = content?.[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function feishuPostSections(content: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!content) return [];
  const sections: Record<string, unknown>[] = [];
  if (Array.isArray(content['content']) || stringContentField(content, 'title')) sections.push(content);

  for (const key of ['zh_cn', 'en_us', 'ja_jp']) {
    const section = content[key];
    if (isRecord(section)) sections.push(section);
  }

  for (const section of Object.values(content)) {
    if (!isRecord(section) || sections.includes(section)) continue;
    if (Array.isArray(section['content']) || stringContentField(section, 'title')) sections.push(section);
  }

  return sections;
}

function feishuPostParagraphs(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((paragraph) => {
      const items = Array.isArray(paragraph) ? paragraph : [paragraph];
      return items.map(feishuPostInlineText).join('').trim();
    })
    .filter((line) => line.length > 0);
}

function feishuPostInlineText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (!isRecord(item)) return '';

  const tag = stringContentField(item, 'tag');
  if (tag === 'a') {
    const text = stringValueField(item, 'text') ?? stringContentField(item, 'href');
    const href = stringContentField(item, 'href');
    if (!text) return '';
    return href && href !== text ? `${text} (${href})` : text;
  }
  if (tag === 'at') {
    const name = stringContentField(item, 'user_name')
      ?? stringContentField(item, 'name')
      ?? stringContentField(item, 'user_id');
    return name ? `@${name.replace(/^@/, '')}` : '@unknown';
  }
  if (tag === 'img') return '[image]';
  if (tag === 'media') return '[media]';
  if (tag === 'emotion') {
    const emoji = stringContentField(item, 'emoji_type') ?? stringValueField(item, 'text');
    return emoji ? `:${emoji}:` : '[emoji]';
  }

  return stringValueField(item, 'text')
    ?? stringValueField(item, 'content')
    ?? stringValueField(item, 'title')
    ?? '';
}

function stringValueField(content: Record<string, unknown>, field: string): string | undefined {
  const value = content[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function feishuFileSize(content: Record<string, unknown> | undefined): number | undefined {
  const candidates = [content?.['file_size'], content?.['size'], content?.['size_bytes']];
  const numeric = candidates.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (numeric !== undefined) return numeric;
  const stringValue = candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  const parsed = stringValue === undefined ? Number.NaN : Number(stringValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fallbackFeishuResourceName(kind: FeishuMessageResourceType, messageId: string): string {
  return `${kind}-${messageId}`;
}
