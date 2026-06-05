import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  feishuFileCacheDir,
  getFeishuFileCacheMetaStore,
  type FeishuFileCacheMeta,
} from '../storage/schema/cache.js';
import { safeFilename } from '../storage/safe-filename.js';

export type FeishuMessageResourceType = 'file' | 'image';

export interface FeishuMessageResourceRef {
  fileId: string;
  fileKey: string;
  messageId: string;
  resourceType: FeishuMessageResourceType;
}

export interface FeishuDownloadedMessageResource {
  bytes: Buffer;
  contentType?: string;
  filename?: string;
}

export class FeishuFileService {
  async findCachedFile(input: { fileId: string }): Promise<string | undefined> {
    const meta = await getFeishuFileCacheMetaStore(input.fileId).read();
    if (!meta.name) return undefined;
    const path = cachedFeishuFilePath({ fileId: input.fileId, name: meta.name });
    return await fileExists(path) ? path : undefined;
  }

  async writeToCache(input: {
    file: FeishuDownloadedMessageResource;
    ref: FeishuMessageResourceRef;
  }): Promise<string> {
    const name = safeFilename(input.file.filename?.trim() || fallbackFeishuResourceName(input.ref, input.file.contentType));
    const destPath = cachedFeishuFilePath({ fileId: input.ref.fileId, name });
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, input.file.bytes);
    const meta: FeishuFileCacheMeta = {
      fileId: input.ref.fileId,
      fileKey: input.ref.fileKey,
      messageId: input.ref.messageId,
      mimetype: input.file.contentType || 'application/octet-stream',
      name,
      resourceType: input.ref.resourceType,
      sizeBytes: input.file.bytes.length,
    };
    await getFeishuFileCacheMetaStore(input.ref.fileId).write(meta);
    return destPath;
  }

}

export function cachedFeishuFilePath(input: { fileId: string; name: string }): string {
  return join(feishuFileCacheDir(input.fileId), safeFilename(input.name));
}

export function parseFeishuMessageResourceId(fileId: string): FeishuMessageResourceRef | undefined {
  const parts = fileId.split(':');
  if (parts.length !== 5) return undefined;
  const [platform, scope, messageId, resourceType, fileKey] = parts;
  if (platform !== 'feishu' || scope !== 'message') return undefined;
  if (resourceType !== 'file' && resourceType !== 'image') return undefined;
  if (!messageId || !fileKey) return undefined;
  return { fileId, fileKey, messageId, resourceType };
}

export function feishuMessageResourceId(input: {
  fileKey: string;
  messageId: string;
  resourceType: FeishuMessageResourceType;
}): string {
  return `feishu:message:${input.messageId}:${input.resourceType}:${input.fileKey}`;
}

function fallbackFeishuResourceName(ref: FeishuMessageResourceRef, contentType: string | undefined): string {
  const extension = extensionForContentType(contentType);
  return `${ref.resourceType}-${ref.messageId}-${ref.fileKey}${extension}`;
}

function extensionForContentType(contentType: string | undefined): string {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'application/pdf') return '.pdf';
  if (normalized === 'text/plain') return '.txt';
  return '';
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

export const defaultFeishuFileService = new FeishuFileService();
