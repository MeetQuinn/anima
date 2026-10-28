import { existsSync } from 'node:fs';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { basename } from 'node:path';

import { createFeishuMessageClient as createDefaultFeishuMessageClient } from '../feishu/client.js';
import type {
  FeishuMessageClient,
  FeishuReceiveIdType,
} from '../feishu/client.js';
import { safeFilename } from '../storage/safe-filename.js';
import { outcomeLine, type OutcomePart } from './outcome-line.js';
import { runSlackSend, type LocalFileToSend, type UploadedFilePayload } from './slack-send.js';
import {
  currentFeishuItem,
  feishuMessageClientForOpts,
  resolveToolAgentId,
  withToolActivity,
  readOptionalStdin,
} from './tool-context.js';
import { resolveChatTarget } from './chat-target-resolver.js';

export interface FileSendInputData {
  agent?: string;
  caption?: string;
  channel?: string;
  paths: string[];
  threadTs?: string;
  item?: string;
}

interface FeishuFileTarget {
  displayName: string;
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  surfaceKind: string;
}

type FeishuMessageClientFactory = typeof createDefaultFeishuMessageClient;

export interface FileSendDeps {
  createFeishuMessageClient?: FeishuMessageClientFactory;
  writeOutput?: (line: string) => void;
}

// `anima file send` is `anima message send --file` with its own flags: the
// same validation, the same Feishu path and the same Slack send pipeline.
export async function runFileSend(opts: FileSendInputData, deps: FileSendDeps = {}): Promise<void> {
  const agentId = resolveToolAgentId(opts);
  if (!agentId) throw new Error('file send requires current agent context for audit');
  if (!opts.channel) throw new Error('file send requires --channel or --chat-id');
  if (!opts.paths.length) throw new Error('file send requires at least one path');
  const files = await validateLocalFiles(opts.paths);
  const caption = await captionFromOpts(opts);
  await sendLocalFiles({ agentId, caption: caption ?? '', deps, files, opts: { ...opts, channel: opts.channel } });
}

// Validate every path up front so a send fails closed before any platform
// call: bad input never reaches Slack or Feishu.
export async function validateLocalFiles(paths: readonly string[]): Promise<LocalFileToSend[]> {
  return Promise.all(paths.map(async (path) => {
    if (!existsSync(path)) throw new Error(`file not found: ${path}`);
    const stats = await fsStat(path);
    if (!stats.isFile()) throw new Error(`not a regular file: ${path}`);
    if (stats.size <= 0) throw new Error(`file is empty: ${path}`);
    const filename = safeFilename(basename(path));
    return { path, filename, mimetype: mimeFromName(filename), sizeBytes: stats.size };
  }));
}

/** Post validated local files as one message, with `caption` ('' for none). */
export async function sendLocalFiles(input: {
  agentId: string;
  caption: string;
  deps?: FileSendDeps;
  files: LocalFileToSend[];
  opts: { agent?: string; channel: string; item?: string; threadTs?: string };
}): Promise<void> {
  const { agentId, caption, files, opts } = input;
  const chatTarget = resolveChatTarget(opts.channel, await currentFeishuItem(agentId, opts));
  if (chatTarget.platform === 'feishu') {
    const { client } = await feishuMessageClientForOpts(
      opts,
      input.deps?.createFeishuMessageClient ?? createDefaultFeishuMessageClient,
    );
    await runFeishuFileSend({
      agentId,
      ...(caption ? { caption } : {}),
      client,
      files,
      opts,
      target: {
        displayName: chatTarget.displayName ?? 'Feishu chat',
        receiveId: chatTarget.receiveId,
        receiveIdType: chatTarget.receiveIdType,
        surfaceKind: chatTarget.surfaceKind ?? 'chat',
      },
    });
    return;
  }
  await runSlackSend({
    agentId,
    files,
    opts,
    text: caption,
    ...(input.deps?.writeOutput ? { writeOutput: input.deps.writeOutput } : {}),
  });
}

async function runFeishuFileSend(input: {
  agentId: string;
  caption?: string;
  client: FeishuMessageClient;
  files: LocalFileToSend[];
  opts: { agent?: string; item?: string; threadTs?: string };
  target: FeishuFileTarget;
}): Promise<void> {
  for (const file of input.files) {
    assertFeishuFileSize(file);
  }

  const threadMessageId = input.opts.threadTs;
  const basePayload: Record<string, unknown> = {
    ...(input.target.receiveIdType === 'chat_id' ? { channel: input.target.receiveId } : {}),
    channelDisplayName: input.target.displayName,
    channelKind: input.target.surfaceKind,
    ...(threadMessageId ? { targetTs: threadMessageId, threadTs: threadMessageId } : {}),
    fileCount: input.files.length,
    files: input.files.map((entry) => ({
      filename: entry.filename,
      mimetype: entry.mimetype,
      sizeBytes: entry.sizeBytes,
    })),
    ...(input.caption ? { caption: input.caption } : {}),
    platform: 'feishu',
    receiveId: input.target.receiveId,
    receiveIdType: input.target.receiveIdType,
    tool: 'anima.file.send',
  };

  await withToolActivity({
    audit: { agentId: input.agentId },
    basePayload,
    effectType: 'feishu.file.send',
    op: async () => {
      const uploaded = await Promise.all(input.files.map(async (entry) => ({
        entry,
        resource: await input.client.uploadFile({
          bytes: await readFile(entry.path),
          filename: entry.filename,
          mimetype: entry.mimetype,
        }),
      })));

      const sent = await Promise.all(uploaded.map(async ({ entry, resource }) => {
        const response = await input.client.sendUploadedFile({
          file: resource,
          receiveId: input.target.receiveId,
          receiveIdType: input.target.receiveIdType,
          ...(threadMessageId ? { threadMessageId } : {}),
        });
        return {
          entry,
          resource,
          response,
        };
      }));

      const captionResponse = input.caption
        ? await sendFeishuCaption({
            caption: input.caption,
            client: input.client,
            target: input.target,
            threadMessageId,
          })
        : undefined;

      const uploads: UploadedFilePayload[] = sent.map(({ entry, resource, response }) => ({
        fileId: resource.fileKey,
        filename: entry.filename,
        kind: resource.kind,
        mimetype: entry.mimetype,
        ...(response.messageId ? { messageId: response.messageId } : {}),
        sizeBytes: entry.sizeBytes,
      }));

      console.log(feishuFileOutputLine({
        fileCount: uploads.length,
        receiveId: input.target.receiveId,
        receiveIdType: input.target.receiveIdType,
        threadMessageId,
      }));

      return {
        result: undefined,
        completedPayload: {
          ...(captionResponse?.messageId ? { captionMessageId: captionResponse.messageId } : {}),
          ...(captionResponse?.threadId ? { captionThreadId: captionResponse.threadId } : {}),
          status: 'sent',
          uploads,
        },
      };
    },
  });
}

async function sendFeishuCaption(input: {
  caption: string;
  client: FeishuMessageClient;
  target: FeishuFileTarget;
  threadMessageId?: string;
}) {
  if (input.threadMessageId) {
    return input.client.replyText({
      messageId: input.threadMessageId,
      replyInThread: true,
      text: input.caption,
    });
  }
  return input.client.sendText({
    receiveId: input.target.receiveId,
    receiveIdType: input.target.receiveIdType,
    text: input.caption,
  });
}

function feishuFileOutputLine(input: {
  fileCount: number;
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  threadMessageId?: string;
}): string {
  const parts: OutcomePart[] = input.receiveIdType === 'chat_id'
    ? [['feishu chat_id', input.receiveId]]
    : [['feishu receive_id_type', 'open_id'], ['receive_id', input.receiveId]];
  if (input.threadMessageId) parts.push(['thread_id', input.threadMessageId]);
  parts.push(['files', input.fileCount]);
  return outcomeLine('uploaded', parts);
}

function assertFeishuFileSize(file: LocalFileToSend): void {
  const limit = isFeishuImageCandidate(file) ? 10 * 1024 * 1024 : 30 * 1024 * 1024;
  if (file.sizeBytes > limit) {
    const limitMb = Math.floor(limit / 1024 / 1024);
    throw new Error(`Feishu file upload limit is ${limitMb} MiB: ${file.filename}`);
  }
}

function isFeishuImageCandidate(file: Pick<LocalFileToSend, 'filename' | 'mimetype'>): boolean {
  return file.mimetype.toLowerCase().startsWith('image/') || /\.(bmp|gif|ico|jpe?g|png|tiff?|webp)$/i.test(file.filename);
}

// Caption resolution: --caption wins; if absent, read stdin so a heredoc body
// works (same convention as `anima message send --text`). Returns undefined
// for the empty case so `completeUploadExternal` gets no caption blocks.
async function captionFromOpts(opts: { caption?: string }): Promise<string | undefined> {
  if (opts.caption !== undefined) {
    return opts.caption.length > 0 ? opts.caption : undefined;
  }
  const text = await readOptionalStdin();
  return text && text.length > 0 ? text : undefined;
}

// Best-effort mime guess from extension. Slack and Feishu infer more precisely
// server-side, but the audit payload needs a stable local value before upload.
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
