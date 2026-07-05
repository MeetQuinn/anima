import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { errorMessage } from '../ids.js';
import { triggerSlackFileCacheEviction } from '../storage/file-cache-eviction.js';
import { getSlackFileCacheMetaStore, slackFileCacheDir, type SlackFileCacheMeta } from '../storage/schema/cache.js';
import { safeFilename } from '../storage/safe-filename.js';
import type { InboxFileMeta } from '../../shared/inbox.js';
import type { DownloadableSlackFile } from './slack.helper.js';

// Received Slack files are metadata-only at ingest. Agents fetch bytes on demand
// via `anima file fetch <fileId>`, which stores them in the shared cache.
export const MANUAL_FETCH_BYTES = 500 * 1024 * 1024;

interface DownloadSlackFileInput {
  token: string;
  urlPrivate: string;
  destPath: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}

export async function downloadSlackFile(input: DownloadSlackFileInput): Promise<{ sizeBytes: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.urlPrivate, {
    headers: { Authorization: `Bearer ${input.token}` },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Slack file download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > input.maxBytes) {
    throw new Error(`Slack file too large: ${contentLength} > ${input.maxBytes} bytes`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > input.maxBytes) {
    throw new Error(`Slack file too large: ${buffer.length} > ${input.maxBytes} bytes`);
  }
  await mkdir(dirname(input.destPath), { recursive: true });
  await writeFile(input.destPath, buffer);
  return { sizeBytes: buffer.length };
}

export type CachedSlackFile = InboxFileMeta & { localPath: string };

export interface SlackCachedFileRead {
  bytes: Buffer;
  contentType: string;
  filename: string;
  sizeBytes: number;
}

export class SlackFileService {
  async findCachedFile(input: { teamId: string; fileId: string }): Promise<string | undefined> {
    const meta = await getSlackFileCacheMetaStore(input.teamId, input.fileId).read();
    if (!meta.name) return undefined;
    const path = cachedSlackFilePath({
      fileId: input.fileId,
      name: meta.name,
      teamId: input.teamId,
    });
    return await fileExists(path) ? path : undefined;
  }

  async readCachedFile(input: { teamId: string; fileId: string }): Promise<SlackCachedFileRead | undefined> {
    const meta = await getSlackFileCacheMetaStore(input.teamId, input.fileId).read();
    if (!meta.name) return undefined;
    const filePath = cachedSlackFilePath({
      fileId: input.fileId,
      name: meta.name,
      teamId: input.teamId,
    });
    let sizeBytes: number;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return undefined;
      sizeBytes = fileStat.size;
    } catch {
      return undefined;
    }
    return {
      bytes: await readFile(filePath),
      contentType: meta.mimetype || 'application/octet-stream',
      filename: meta.name,
      sizeBytes,
    };
  }

  async downloadToCache(input: {
    file: DownloadableSlackFile;
    teamId: string;
    token: string;
  }): Promise<CachedSlackFile | (InboxFileMeta & { downloadError: string })> {
    const { file } = input;
    if (!file.urlPrivate) {
      return { ...file, downloadError: 'missing url_private' };
    }
    const destPath = cachedSlackFilePath({
      fileId: file.id,
      name: file.name,
      teamId: input.teamId,
    });
    try {
      const { sizeBytes } = await downloadSlackFile({
        destPath,
        maxBytes: MANUAL_FETCH_BYTES,
        token: input.token,
        urlPrivate: file.urlPrivate,
      });
      const meta: SlackFileCacheMeta = {
        id: file.id,
        mimetype: file.mimetype,
        name: file.name,
        sizeBytes,
        teamId: input.teamId,
      };
      await getSlackFileCacheMetaStore(input.teamId, file.id).write(meta);
      triggerSlackFileCacheEviction();
      return {
        id: file.id,
        localPath: destPath,
        mimetype: file.mimetype,
        name: file.name,
        sizeBytes,
      };
    } catch (error) {
      console.warn(`Slack file download failed for ${file.id} (${file.name}): ${errorMessage(error)}`);
      return {
        id: file.id,
        mimetype: file.mimetype,
        name: file.name,
        sizeBytes: file.sizeBytes,
        downloadError: errorMessage(error),
      };
    }
  }
}

export function cachedSlackFilePath(input: { teamId: string; fileId: string; name: string }): string {
  return join(slackFileCacheDir(input.teamId, input.fileId), safeFilename(input.name));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

export const defaultSlackFileService = new SlackFileService();
