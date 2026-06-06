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

  return [];
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
