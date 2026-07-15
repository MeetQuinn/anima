import { readFile, stat as fsStat } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  FilesCompleteUploadExternalResponse,
  FilesGetUploadURLExternalResponse,
  FilesInfoResponse,
} from '@slack/web-api';

import { errorMessage } from '../ids.js';
import { safeFilename } from '../storage/safe-filename.js';

export type SlackFileInfo = NonNullable<FilesInfoResponse['file']>;

export interface SlackFileClient {
  files: {
    completeUploadExternal(input: {
      channel_id?: string;
      files: Array<{ id: string; title?: string }>;
      initial_comment?: string;
      thread_ts?: string;
    }): Promise<FilesCompleteUploadExternalResponse>;
    getUploadURLExternal(input: { filename: string; length: number }): Promise<FilesGetUploadURLExternalResponse>;
    info(input: { file: string }): Promise<FilesInfoResponse>;
  };
}

export interface UploadedSlackFile {
  fileId: string;
  filename: string;
  localPath: string;
  mimetype: string;
  sizeBytes: number;
}

// Slack's modern upload flow is two-step:
//   1. files.getUploadURLExternal -> { upload_url, file_id }
//   2. POST the bytes to upload_url
//   3. files.completeUploadExternal({ files: [{ id }], channel_id, thread_ts?, initial_comment? })
//
// `uploadSlackFile` covers step 1-2 for one local path. The file-send tool
// batches the resulting file ids into one completeUploadExternal call so N
// files post as a single Slack message.
export async function uploadSlackFile(input: {
  client: SlackFileClient;
  fetchImpl?: typeof fetch;
  localPath: string;
}): Promise<UploadedSlackFile> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let stats: Awaited<ReturnType<typeof fsStat>>;
  try {
    stats = await fsStat(input.localPath);
  } catch (error) {
    throw new Error(`file not found: ${input.localPath} (${errorMessage(error)})`);
  }
  if (!stats.isFile()) throw new Error(`not a regular file: ${input.localPath}`);
  if (stats.size <= 0) throw new Error(`file is empty: ${input.localPath}`);

  const filename = safeFilename(basename(input.localPath));
  const upload = await input.client.files.getUploadURLExternal({
    filename,
    length: stats.size,
  });
  if (!upload.file_id) throw new Error('Slack files.getUploadURLExternal did not return a file_id');
  if (!upload.upload_url) throw new Error('Slack files.getUploadURLExternal did not return an upload_url');

  const bytes = await readFile(input.localPath);
  const response = await fetchImpl(upload.upload_url, {
    body: bytes,
    headers: { 'content-type': 'application/octet-stream' },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Slack file upload POST failed: HTTP ${response.status} ${response.statusText}`);
  }

  return {
    fileId: upload.file_id,
    filename,
    localPath: input.localPath,
    mimetype: mimeFromName(filename),
    sizeBytes: stats.size,
  };
}

export interface CompletedSlackUploadFile {
  fileId: string;
  title?: string;
}

export async function completeSlackFileUpload(input: {
  caption?: string;
  channelId: string;
  client: SlackFileClient;
  files: Array<{ fileId: string; title?: string }>;
  threadTs?: string;
}): Promise<CompletedSlackUploadFile[]> {
  const completion = await input.client.files.completeUploadExternal({
    channel_id: input.channelId,
    files: input.files.map(({ fileId, title }) => ({
      id: fileId,
      ...(title && { title }),
    })),
    ...(input.threadTs && { thread_ts: input.threadTs }),
    ...(input.caption && { initial_comment: input.caption }),
  });
  const titleByFileId = new Map<string, string | undefined>(
    (completion.files ?? []).map((file) => [file.id ?? '', file.title]),
  );
  return input.files.map(({ fileId }) => ({
    fileId,
    ...(titleByFileId.get(fileId) ? { title: titleByFileId.get(fileId) } : {}),
  }));
}

// Best-effort mime guess from extension. Slack also infers this, but the tool
// records our guess in the audit payload before Slack returns enriched file info.
function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  return 'application/octet-stream';
}
