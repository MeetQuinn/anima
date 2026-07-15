import { existsSync } from 'node:fs';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { basename } from 'node:path';

import { resolveSlackChannelArgument } from './slack-channel-resolver.js';
import { createFeishuMessageClient as createDefaultFeishuMessageClient } from '../feishu/client.js';
import type {
  FeishuMessageClient,
  FeishuReceiveIdType,
} from '../feishu/client.js';
import { safeFilename } from '../storage/safe-filename.js';
import {
  completeSlackFileUpload,
  type SlackFileClient,
  type SlackFileInfo,
  uploadSlackFile,
} from './slack-file-upload.js';
import {
  slackOutputTarget,
  slackTargetPayload,
  slackTargetSummary,
  type SlackTargetSummary,
} from './slack-target.js';
import {
  mentionWarningsForTarget,
  slackTextAuditPayload,
  slackTextForPostMessage,
} from './slack-message-mentions.js';
import { slackMrkdwnForMarkdown } from './slack-mrkdwn.js';
import { outcomeLine, type OutcomePart } from './outcome-line.js';
import {
  feishuMessageClientForOpts,
  resolveToolAgentId,
  slackWebClientForOpts,
  withToolActivity,
  readStdin,
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

interface UploadedFilePayload {
  fileId: string;
  filename: string;
  kind?: string;
  mimetype: string;
  messageId?: string;
  permalink?: string;
  sizeBytes: number;
  thumb360?: string;
  thumb720?: string;
  title?: string;
}

interface ValidatedLocalFile {
  filename: string;
  mimetype: string;
  path: string;
  sizeBytes: number;
}

interface FeishuFileTarget {
  displayName: string;
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  surfaceKind: string;
}

type FeishuMessageClientFactory = typeof createDefaultFeishuMessageClient;

interface FileSendDeps {
  createFeishuMessageClient?: FeishuMessageClientFactory;
}

export async function runFileSend(opts: FileSendInputData, deps: FileSendDeps = {}): Promise<void> {
  const agentId = resolveToolAgentId(opts);
  if (!agentId) throw new Error('file send requires current agent context for audit');
  if (!opts.channel) throw new Error('file send requires --channel or --chat-id');
  if (!opts.paths.length) throw new Error('file send requires at least one path');

  // Validate every path up front so we fail closed before any Slack call.
  // Mirrors text-send: bad input never reaches Slack.
  const validated = await Promise.all(opts.paths.map(async (path) => {
    if (!existsSync(path)) throw new Error(`file not found: ${path}`);
    const stats = await fsStat(path);
    if (!stats.isFile()) throw new Error(`not a regular file: ${path}`);
    if (stats.size <= 0) throw new Error(`file is empty: ${path}`);
    const filename = safeFilename(basename(path));
    return { path, filename, mimetype: mimeFromName(filename), sizeBytes: stats.size };
  }));

  const caption = await captionFromOpts(opts);
  const chatTarget = resolveChatTarget(opts.channel);
  if (chatTarget.platform === 'feishu') {
    const { client } = await feishuMessageClientForOpts(
      opts,
      deps.createFeishuMessageClient ?? createDefaultFeishuMessageClient,
    );
    await runFeishuFileSend({
      agentId,
      caption,
      client,
      files: validated,
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

  const { agent, client } = await slackWebClientForOpts(opts);
  const teamId = agent.slack.teamId || undefined;

  const channel = await resolveSlackChannelArgument({
    channel: opts.channel,
    client,
    teamId,
  });
  const threadTs = opts.threadTs;
  const target = await slackTargetSummary({ channel, client, teamId });

  const basePayload: Record<string, unknown> = {
    ...slackTargetPayload(channel),
    ...target,
    ...(threadTs ? { threadTs } : {}),
    fileCount: validated.length,
    files: validated.map((entry) => ({ filename: entry.filename, sizeBytes: entry.sizeBytes })),
    ...(caption ? { caption } : {}),
    tool: 'anima.file.send',
  };

  await withToolActivity({
    audit: { agentId },
    basePayload,
    effectType: 'slack.file.send',
    op: async () => {
      const mrkdwnCaption = caption ? slackMrkdwnForMarkdown(caption) : undefined;
      if (caption && !mrkdwnCaption) {
        throw new Error('caption has no displayable text after Markdown conversion');
      }
      const slackCaption = mrkdwnCaption
        ? await slackTextForPostMessage({ channelId: channel.id, client, teamId, text: mrkdwnCaption })
        : undefined;
      const warnings = slackCaption
        ? await mentionWarningsForTarget({
            channelId: channel.id,
            client,
            slackText: slackCaption,
            target,
            teamId,
          })
        : [];

      // Step 1+2: per-file upload URL + POST bytes. Each path's pair is
      // independent — Slack docs don't require serialization, so we run them
      // in parallel for batches (N files = 1×RTT instead of N×RTT).
      const uploaded = await Promise.all(
        validated.map((entry) => uploadSlackFile({ client, localPath: entry.path })),
      );

      // Step 3: single completeUploadExternal posts all N files as one message.
      const completed = await completeSlackFileUpload({
        ...(slackCaption ? { caption: slackCaption.text } : {}),
        channelId: channel.id,
        client,
        files: uploaded.map((file) => ({ fileId: file.fileId })),
        ...(threadTs ? { threadTs } : {}),
      });

      // Per-file enrichment: permalink + thumbs (image only) for the audit
      // payload + UI render. Best-effort — a single failed files.info should
      // not abort the whole upload. Each file carries its own permalink;
      // there's no top-level "message permalink" because Slack groups
      // multi-file uploads into one message but only emits per-file URLs.
      const titleByFileId = new Map(completed.map((file) => [file.fileId, file.title]));
      const enriched: UploadedFilePayload[] = await Promise.all(uploaded.map(async (file) => {
        const info = await safeFetchSlackFileInfo({ client, fileId: file.fileId });
        const title = titleByFileId.get(file.fileId);
        return {
          fileId: file.fileId,
          filename: file.filename,
          mimetype: info?.mimetype ?? file.mimetype,
          sizeBytes: info?.size ?? file.sizeBytes,
          ...(info?.permalink ? { permalink: info.permalink } : {}),
          ...(info?.thumb_360 ? { thumb360: info.thumb_360 } : {}),
          ...(info?.thumb_720 ? { thumb720: info.thumb_720 } : {}),
          ...(title ? { title } : {}),
        };
      }));

      console.log(slackFileOutputLine({
        fileCount: enriched.length,
        target,
        threadTs,
        warnings,
      }));

      return {
        result: undefined,
        completedPayload: {
          ...(slackCaption && caption ? slackTextAuditPayload(slackCaption, caption) : {}),
          ...(slackCaption ? { messageFormat: 'mrkdwn' } : {}),
          status: 'sent',
          uploads: enriched,
          ...(warnings.length ? { warnings } : {}),
        },
      };
    },
  });
}

async function runFeishuFileSend(input: {
  agentId: string;
  caption?: string;
  client: FeishuMessageClient;
  files: ValidatedLocalFile[];
  opts: FileSendInputData;
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

async function safeFetchSlackFileInfo(input: {
  client: SlackFileClient;
  fileId: string;
}): Promise<SlackFileInfo | undefined> {
  try {
    return (await input.client.files.info({ file: input.fileId })).file;
  } catch {
    return undefined;
  }
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

function slackFileOutputLine(input: {
  fileCount: number;
  target: SlackTargetSummary;
  threadTs?: string;
  warnings?: string[];
}): string {
  const parts: OutcomePart[] = [slackOutputTarget(input.target)];
  if (input.threadTs) parts.push(['thread_ts', input.threadTs]);
  parts.push(['files', input.fileCount]);
  return outcomeLine('uploaded', parts, input.warnings?.length ? { note: input.warnings.join(' ') } : undefined);
}

function assertFeishuFileSize(file: ValidatedLocalFile): void {
  const limit = isFeishuImageCandidate(file) ? 10 * 1024 * 1024 : 30 * 1024 * 1024;
  if (file.sizeBytes > limit) {
    const limitMb = Math.floor(limit / 1024 / 1024);
    throw new Error(`Feishu file upload limit is ${limitMb} MiB: ${file.filename}`);
  }
}

function isFeishuImageCandidate(file: Pick<ValidatedLocalFile, 'filename' | 'mimetype'>): boolean {
  return file.mimetype.toLowerCase().startsWith('image/') || /\.(bmp|gif|ico|jpe?g|png|tiff?|webp)$/i.test(file.filename);
}

// Caption resolution: --caption wins; if absent, read stdin so a heredoc body
// works (same convention as `anima message send --text`). Returns undefined
// for the empty case so `completeUploadExternal` omits `initial_comment`.
async function captionFromOpts(opts: { caption?: string }): Promise<string | undefined> {
  if (opts.caption !== undefined) {
    return opts.caption.length > 0 ? opts.caption : undefined;
  }
  const text = await readStdin();
  return text.length > 0 ? text : undefined;
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
