import { readFile, stat as fsStat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { basename } from 'node:path';
import type {
  FilesCompleteUploadExternalResponse,
  FilesGetUploadURLExternalResponse,
  FilesInfoResponse,
} from '@slack/web-api';

import { errorMessage } from '../ids.js';
import { messageTsFromSlackFileInfo } from '../runtime/send-hold.js';
import { safeFilename } from '../storage/safe-filename.js';
import type { SlackMessageBlock } from './slack-message-format.js';

export type SlackFileInfo = NonNullable<FilesInfoResponse['file']>;

export interface SlackFileClient {
  files: {
    completeUploadExternal(input: {
      // Wide enough for WebClient's Block | KnownBlock union to satisfy it.
      blocks?: Array<{ type: string }>;
      channel_id?: string;
      files: Array<{ id: string; title?: string }>;
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
//   3. files.completeUploadExternal({ files: [{ id }], channel_id, thread_ts?, blocks? })
//
// The caption goes in `blocks`, never `initial_comment`: Slack ignores
// `blocks` whenever `initial_comment` is set, and `initial_comment` is plain
// mrkdwn, which cannot render GFM.
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
  /** Ts of the message the upload posted, when Slack already reports it here. */
  messageTs?: string;
  title?: string;
}

export async function completeSlackFileUpload(input: {
  captionBlocks?: SlackMessageBlock[];
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
    ...(input.captionBlocks && { blocks: input.captionBlocks }),
  });
  const completedById = new Map((completion.files ?? []).map((file) => [file.id ?? '', file]));
  return input.files.map(({ fileId }) => {
    const completed = completedById.get(fileId);
    const messageTs = messageTsFromSlackFileInfo(completed, input.channelId);
    return {
      fileId,
      ...(messageTs ? { messageTs } : {}),
      ...(completed?.title ? { title: completed.title } : {}),
    };
  });
}

// Slack posts the file message only once it has processed the upload. For
// images, PDFs and video, the message ts often appears in files.info a second
// or more after completeUploadExternal returns (measured: up to ~3.5 s for a
// 1.4 MB PNG; text files are immediate). Thread follow, the own-post journal
// and the printed message ts all need it, so poll for it, under one deadline.
export const SLACK_FILE_SHARE_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 1500, 2000, 3000];
export const SLACK_FILE_METADATA_DEADLINE_MS = 10_000;
// One files.info read right after an upload has taken 4.5 s on real Slack.
export const SLACK_FILE_METADATA_REQUEST_TIMEOUT_MS = 5_000;

export interface SlackFileInfoClient {
  files: Pick<SlackFileClient['files'], 'info'>;
}

export interface SlackFileMetadata {
  infoByFileId: Map<string, SlackFileInfo>;
  /** Ts of the message the upload posted in the channel, if Slack reported it in time. */
  messageTs?: string;
}

/**
 * After an upload has posted: read files.info for each file, then poll for
 * the message ts of their share in `channelId` unless it is already known.
 * Every read shares one deadline. At the deadline, in-flight reads are
 * cancelled through the client's signal and whatever is known is returned.
 * Never throws: the upload has already posted, and nothing here may make the
 * caller report a failure or retry it.
 */
export async function readSlackFileMetadataAfterUpload(input: {
  channelId: string;
  /** Must cancel its requests when `signal` aborts, with no retries or 429 waits of its own. */
  createClient: (signal: AbortSignal) => SlackFileInfoClient;
  deadlineMs?: number;
  fileIds: readonly string[];
  knownMessageTs?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<SlackFileMetadata> {
  const controller = new AbortController();
  const { signal } = controller;
  let client: SlackFileInfoClient;
  try {
    client = input.createClient(signal);
  } catch {
    return { infoByFileId: new Map(), ...(input.knownMessageTs ? { messageTs: input.knownMessageTs } : {}) };
  }
  const sleep = input.sleep ?? sleepUnlessAborted;
  const infoByFileId = new Map<string, SlackFileInfo>();
  let messageTs = input.knownMessageTs;
  const read = async (fileId: string): Promise<void> => {
    try {
      const info = (await client.files.info({ file: fileId })).file;
      // A read that lands after the deadline changes nothing already returned.
      if (signal.aborted || !info) return;
      infoByFileId.set(fileId, info);
      messageTs ??= messageTsFromSlackFileInfo(info, input.channelId);
    } catch {
      // Best effort: a failed read never changes what was posted.
    }
  };
  const readAll = async (): Promise<void> => {
    await Promise.all(input.fileIds.map(read));
    const [firstFileId] = input.fileIds;
    if (!firstFileId) return;
    // One upload posts every file as one message: any file's share ts is it.
    for (const delayMs of SLACK_FILE_SHARE_RETRY_DELAYS_MS) {
      if (messageTs || signal.aborted) return;
      await sleep(delayMs, signal);
      if (signal.aborted) return;
      await read(firstFileId);
    }
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // The race also bounds a client that ignores its signal.
    await Promise.race([
      readAll(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, input.deadlineMs ?? SLACK_FILE_METADATA_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  return { infoByFileId: new Map(infoByFileId), ...(messageTs ? { messageTs } : {}) };
}

async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  // Aborting ends the wait at once, so no timer keeps the CLI alive.
  await delay(ms, undefined, { signal }).catch(() => undefined);
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
