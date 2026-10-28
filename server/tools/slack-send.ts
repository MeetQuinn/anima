import type { WebClient } from '@slack/web-api';

import type { AgentConfig } from '../../shared/agent-config.js';
import { createAgentSlackDeadlineWebClient } from '../agents/agent-slack.service.js';
import { errorMessage } from '../ids.js';
import { assertSlackContactAllowed } from '../messages/contact-policy.service.js';
import {
  finalizeSentSlackMessage,
  postedSlackThreadTs,
  sentThreadSubscriptionPayload,
} from '../messages/sent-message.service.js';
import { evaluateSendHold, observeOwnOutboundPost } from '../runtime/send-hold.js';
import { resolveSlackChannelArgument } from './slack-channel-resolver.js';
import {
  completeSlackFileUpload,
  readSlackFileMetadataAfterUpload,
  SLACK_FILE_METADATA_REQUEST_TIMEOUT_MS,
  uploadSlackFile,
} from './slack-file-upload.js';
import { SLACK_NO_UNFURL, slackCaptionBlocks, slackMessageContentForText } from './slack-message-format.js';
import {
  mentionWarningsForTarget,
  slackTextForPostMessage,
  type SlackTextForPostMessage,
} from './slack-message-mentions.js';
import {
  slackOutputTarget,
  slackTargetPayload,
  slackTargetSummary,
  slackThreadSummary,
  type SlackTargetSummary,
  type SlackThreadSummary,
} from './slack-target.js';
import { outcomeLine, type OutcomePart } from './outcome-line.js';
import { slackWebClientForOpts, withToolActivity } from './tool-context.js';

type SlackPostMessagePayload = Parameters<WebClient['chat']['postMessage']>[0];

export interface LocalFileToSend {
  filename: string;
  mimetype: string;
  path: string;
  sizeBytes: number;
}

export interface UploadedFilePayload {
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

/**
 * The one Slack send pipeline, for a text message or a file post (files plus
 * an optional caption). Both take the same steps in the same order, so a post
 * behaves the same however it was made:
 *
 *   1. resolve the target and readable mentions (preparation, reversible);
 *   2. contact policy and send hold, immediately before the first Slack write;
 *   3. the post itself, audited as one external effect;
 *   4. local bookkeeping that must never fail the send: own-post journal,
 *      engagement, thread follow;
 *   5. one output line, after the audit, with the message ts and any warnings.
 *
 * Tool names, effect types, output verbs and audit fields stay per kind so
 * existing readers of the activity log see what they saw before.
 */
export async function runSlackSend(input: {
  agentId: string;
  /** Present and non-empty for a file post; `text` is then its caption and may be blank. */
  files?: LocalFileToSend[];
  opts: { agent?: string; channel: string; threadTs?: string };
  text: string;
  writeOutput?: (line: string) => void;
}): Promise<void> {
  const { agentId } = input;
  const files = input.files?.length ? input.files : undefined;
  const tool = files ? 'anima.file.send' : 'anima.message.send';
  const { agent, client } = await slackWebClientForOpts(input.opts);
  const teamId = agent.slack.teamId || undefined;
  const channel = await resolveSlackChannelArgument({ channel: input.opts.channel, client, teamId });
  const threadTs = input.opts.threadTs;
  const target = await slackTargetSummary({ channel, client, teamId });
  const thread = threadTs ? slackThreadSummary(target, threadTs) : undefined;
  if (!teamId) throw new Error(`Agent ${agent.id} has no Slack team id configured`);

  // Preparation, before any hold or Slack write. A caption resolves readable
  // mentions exactly like a message; a blank caption has nothing to resolve.
  const hasText = !files || input.text.trim().length > 0;
  const slackText = hasText
    ? await slackTextForPostMessage({ channelId: channel.id, client, teamId, text: input.text })
    : { resolved: [], text: input.text, unresolved: [] };
  const warnings = hasText
    ? await mentionWarningsForTarget({ channelId: channel.id, client, slackText, target, teamId })
    : [];
  const post = files
    ? prepareFilePost({ caption: input.text, files, slackText })
    : prepareMessagePost({ channelId: channel.id, slackText, text: input.text, threadTs });

  const basePayload: Record<string, unknown> = {
    ...slackTargetPayload(channel),
    ...target,
    ...(thread ? thread : {}),
    ...(threadTs ? { threadTs } : {}),
    ...post.basePayload,
    tool,
  };

  // Pre-commit checks: after preparation, immediately before the first write.
  await assertSlackContactAllowed({
    agentId, teamId, channelId: channel.id, dmUserId: target.dmUserId,
    client, content: post.contactContent, tool,
  });
  const hold = await evaluateSendHold({
    agentId,
    teamId,
    channelKind: target.channelKind,
    channelId: channel.id,
    ...(threadTs ? { threadTs } : {}),
    tool,
    botUserId: agent.slack.botUserId,
    writeOutput: input.writeOutput,
  });
  if (hold.kind === 'held') return;

  const posted = await withToolActivity({
    audit: { agentId },
    basePayload,
    effectType: files ? 'slack.file.send' : 'slack.message.send',
    // The post has happened by the time the completed audit is written, so a
    // failed write is a warning, never a reported failure that invites a resend.
    onCompletedAuditError: (stage, error) => {
      if (stage === 'activity') {
        console.warn(`Sent ${files ? 'file' : 'message'} completion audit write failed for ${agentId}: ${errorMessage(error)}`);
      }
      const record = stage === 'activity' ? 'completion audit and outbox record' : 'outbox record';
      warnings.push(files
        ? `Files were sent, but their local ${record} could not be saved. Do not resend them.`
        : `Message was sent, but its local ${record} could not be saved. Do not resend it.`);
    },
    op: async () => {
      const sent = files
        ? await postFiles({ agent, channelId: channel.id, client, files, captionBlocks: post.captionBlocks, threadTs })
        : await postMessage({ client, payload: post.payload! });
      const channelId = sent.channelId ?? channel.id;
      // Own observation immediately after the irreversible post, before
      // bookkeeping that can fail.
      if (sent.messageTs) {
        await observeOwnOutboundPost({
          agentId,
          teamId,
          channelId,
          messageTs: sent.messageTs,
          ...(threadTs ? { threadTs } : {}),
          text: files ? (input.text || files.map((file) => file.filename).join(', ')) : input.text,
          botUserId: agent.slack.botUserId,
        });
      }
      // A reply follows its thread even without its own ts; a top-level post
      // needs its ts to follow its own thread.
      const isDm = target.channelKind === 'dm';
      const finalization = await finalizeSentSlackMessage({
        agentId,
        channelId,
        isDm,
        messageTs: sent.messageTs ?? sent.threadTs,
        ...(sent.threadTs ? { threadTs: sent.threadTs } : {}),
      });
      warnings.push(...finalization.warnings);
      if (files && !sent.messageTs && !sent.threadTs && !isDm) {
        warnings.push('Slack did not report the file message ts in time, so replies in its thread reach you only if they mention you.');
      }
      const permalink = files ? undefined : slackMessageRedirectLink({ channelId, messageTs: sent.messageTs });
      return {
        result: sent,
        completedPayload: {
          ...post.completedPayload,
          ...sent.completedPayload,
          ...(permalink ? { permalink } : {}),
          ...(warnings.length ? { warnings: [...warnings] } : {}),
          ...(finalization.threadSubscription
            ? { threadSubscription: sentThreadSubscriptionPayload(finalization.threadSubscription) }
            : {}),
          status: 'sent',
          ...(sent.messageTs ? { ts: sent.messageTs } : {}),
        },
      };
    },
  });

  (input.writeOutput ?? console.log)(slackOutputLine({
    ...(files ? { fileCount: files.length } : {}),
    messageTs: posted.messageTs,
    status: files ? 'uploaded' : 'sent',
    target,
    ...(thread ? { thread } : {}),
    warnings,
  }));
}

interface PreparedPost {
  basePayload: Record<string, unknown>;
  captionBlocks?: ReturnType<typeof slackCaptionBlocks>;
  completedPayload: Record<string, unknown>;
  contactContent: Parameters<typeof assertSlackContactAllowed>[0]['content'];
  payload?: SlackPostMessagePayload;
}

function prepareMessagePost(input: {
  channelId: string;
  slackText: SlackTextForPostMessage;
  text: string;
  threadTs?: string;
}): PreparedPost {
  const content = slackMessageContentForText(input.slackText.text);
  const payload = {
    ...(content.blocks ? { blocks: content.blocks } : {}),
    ...SLACK_NO_UNFURL,
    channel: input.channelId,
    text: content.text,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  } as SlackPostMessagePayload;
  return {
    basePayload: {},
    completedPayload: {
      payload,
      ...slackTextPayload(input.slackText, input.text),
      messageFormat: content.format,
      ...(content.blockCount ? { blockCount: content.blockCount } : {}),
      text: input.text,
    },
    contactContent: content,
    payload,
  };
}

function prepareFilePost(input: {
  caption: string;
  files: LocalFileToSend[];
  slackText: SlackTextForPostMessage;
}): PreparedPost {
  // A too-long caption fails here, before any upload.
  const captionBlocks = slackCaptionBlocks(input.slackText.text);
  const captionText = captionBlocks?.[0]?.text ?? '';
  const hasCaption = input.caption.length > 0;
  return {
    basePayload: {
      fileCount: input.files.length,
      files: input.files.map((file) => ({ filename: file.filename, sizeBytes: file.sizeBytes })),
      ...(hasCaption ? { caption: input.caption } : {}),
    },
    ...(captionBlocks ? { captionBlocks } : {}),
    completedPayload: {
      ...(input.slackText.resolved.length > 0 ? { resolvedMentions: input.slackText.resolved } : {}),
      ...(input.slackText.unresolved.length > 0 ? { unresolvedMentions: input.slackText.unresolved } : {}),
      ...(hasCaption && captionText !== input.caption ? { slackCaption: captionText } : {}),
    },
    contactContent: { text: captionText },
  };
}

interface SentPost {
  channelId?: string;
  completedPayload: Record<string, unknown>;
  messageTs?: string;
  /** The thread the post landed in, when it is a reply. */
  threadTs?: string;
}

async function postMessage(input: { client: WebClient; payload: SlackPostMessagePayload }): Promise<SentPost> {
  const response = await input.client.chat.postMessage(input.payload);
  const threadTs = postedSlackThreadTs(response, input.payload.thread_ts);
  return {
    ...(response.channel ? { channelId: response.channel } : {}),
    completedPayload: {},
    ...(response.ts ? { messageTs: response.ts } : {}),
    ...(threadTs ? { threadTs } : {}),
  };
}

async function postFiles(input: {
  agent: AgentConfig;
  captionBlocks?: ReturnType<typeof slackCaptionBlocks>;
  channelId: string;
  client: WebClient;
  files: LocalFileToSend[];
  threadTs?: string;
}): Promise<SentPost> {
  // Per-file upload URL + bytes, then one completeUploadExternal posts all
  // files as one message.
  const uploaded = await Promise.all(
    input.files.map((file) => uploadSlackFile({ client: input.client, localPath: file.path })),
  );
  const completed = await completeSlackFileUpload({
    channelId: input.channelId,
    client: input.client,
    files: uploaded.map((file) => ({ fileId: file.fileId })),
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    ...(input.captionBlocks ? { captionBlocks: input.captionBlocks } : {}),
  });

  // The files have posted, so these reads must neither fail the send nor
  // hang it: per-file permalink/thumbs for the audit and the message ts
  // share one deadline, on a client with no retries or 429 waits.
  const metadata = await readSlackFileMetadataAfterUpload({
    channelId: input.channelId,
    createClient: (signal) => createAgentSlackDeadlineWebClient(input.agent, signal, SLACK_FILE_METADATA_REQUEST_TIMEOUT_MS),
    fileIds: uploaded.map((file) => file.fileId),
    // One upload posts every file as one message: any file's share ts is it.
    knownMessageTs: completed.find((file) => file.messageTs)?.messageTs,
  });
  const { messageTs } = metadata;
  const titleByFileId = new Map(completed.map((file) => [file.fileId, file.title]));
  const uploads = uploaded.map((file): UploadedFilePayload => {
    const info = metadata.infoByFileId.get(file.fileId);
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
      ...(messageTs ? { messageId: messageTs } : {}),
    };
  });
  return {
    completedPayload: { uploads },
    ...(messageTs ? { messageTs } : {}),
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
  };
}

export function slackTextPayload(slackText: SlackTextForPostMessage, originalText: string): Record<string, unknown> {
  return {
    ...(slackText.resolved.length > 0 ? { resolvedMentions: slackText.resolved } : {}),
    ...(slackText.text !== originalText ? { slackText: slackText.text } : {}),
    ...(slackText.unresolved.length > 0 ? { unresolvedMentions: slackText.unresolved } : {}),
  };
}

export function slackMessageRedirectLink(input: {
  channelId: string;
  messageTs?: string;
}): string | undefined {
  if (!input.messageTs) return undefined;
  return `https://slack.com/app_redirect?channel=${encodeURIComponent(input.channelId)}&message_ts=${encodeURIComponent(input.messageTs)}`;
}

export function slackOutputLine(input: {
  fileCount?: number;
  messageTs?: string;
  status: 'sent' | 'updated' | 'uploaded';
  target: SlackTargetSummary;
  thread?: SlackThreadSummary;
  warnings?: string[];
}): string {
  const parts: OutcomePart[] = [slackOutputTarget(input.target)];
  if (input.thread) parts.push(['thread_ts', input.thread.threadTs]);
  if (input.messageTs) parts.push(['message_ts', input.messageTs]);
  if (input.fileCount !== undefined) parts.push(['files', input.fileCount]);
  return outcomeLine(input.status, parts, input.warnings?.length ? { note: input.warnings.join(' ') } : undefined);
}
