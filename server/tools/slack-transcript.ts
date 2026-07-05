import { existsSync } from 'node:fs';
import type { FilesInfoResponse, WebClient } from '@slack/web-api';

import {
  formatUserLocalTime,
  renderEnvelope,
  renderPageFooter,
} from '../messages/envelope.js';
import {
  SlackWorkspaceDirectoryService,
  type SlackConversationInfo,
  type SlackUserInfo,
} from '../slack/workspace-directory.service.js';
import { cachedSlackFilePath } from '../slack/slack-file.service.js';
import {
  atLabel,
  channelLabel,
  extractSlackChannelMentionIds,
  extractSlackUserMentionIds,
  replaceSlackChannelMentions,
  replaceSlackUserMentions,
  slackDisplayLabel,
  slackMentionLabel,
  slackTsToIso,
} from '../slack/slack.helper.js';
import { slackMessagePreviewsFromAttachments } from '../slack/message-previews.js';

export interface SlackTranscriptRequest {
  channel: string;
  channelName?: string;
  limit: number;
  threadTs?: string;
}

export interface SlackFileCacheContext {
  teamId?: string;
}

export interface SlackConversationMessage {
  attachments?: unknown[];
  bot_id?: string;
  files?: SlackFileInfo[];
  reply_count?: number;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts: string;
  type?: string;
  user?: string;
  username?: string;
}

type SlackFileInfo = NonNullable<FilesInfoResponse['file']>;

export function slackTranscriptOutput(
  messages: SlackConversationMessage[],
  request: SlackTranscriptRequest,
  userLabels: SlackTranscriptUserLabels,
  page: { hasMore: boolean; nextCursor: string },
  cacheContext: SlackFileCacheContext = {},
): string {
  const lines = messages.map((message) => slackTranscriptLine(message, request, userLabels, cacheContext));
  if (page.hasMore || page.nextCursor) {
    lines.push(renderPageFooter(page));
  }
  return lines.join('\n');
}

interface UserTimezone {
  name: string;
  offsetSeconds: number;
}

export interface SlackTranscriptUserLabels {
  actors: Map<string, string>;
  channelMentions: Map<string, string>;
  timezones: Map<string, UserTimezone>;
  userMentions: Map<string, string>;
}

export async function slackTranscriptUserLabels(
  messages: SlackConversationMessage[],
  client: WebClient,
  teamId?: string,
): Promise<SlackTranscriptUserLabels> {
  const directory = new SlackWorkspaceDirectoryService({ client, teamId });
  const userIds = [
    ...new Set([
      ...messages.map((message) => message.user).filter((value): value is string => Boolean(value)),
      ...messages.flatMap((message) => extractSlackUserMentionIds(message.text ?? '')),
    ]),
  ];
  const channelIds = [...new Set(messages.flatMap((message) => extractSlackChannelMentionIds(message.text ?? '')))];
  const actors = new Map<string, string>();
  const channelMentions = new Map<string, string>();
  const timezones = new Map<string, UserTimezone>();
  const userMentions = new Map<string, string>();
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const user = await directory.getUser(userId);
        const parts = {
          displayName: slackUserDisplayName(user),
          handle: user?.name,
          userId,
        };
        actors.set(userId, slackDisplayLabel(parts));
        userMentions.set(userId, slackMentionLabel(parts));
        if (user?.timezone?.name && typeof user.timezone.offsetSeconds === 'number') {
          timezones.set(userId, { name: user.timezone.name, offsetSeconds: user.timezone.offsetSeconds });
        }
      } catch {
        actors.set(userId, atLabel(userId));
        userMentions.set(userId, atLabel(userId));
      }
    }),
  );
  await Promise.all(
    channelIds.map(async (channelId) => {
      try {
        const channel = await directory.getConversation(channelId);
        channelMentions.set(channelId, slackChannelLabel(channel, channelId));
      } catch {
        channelMentions.set(channelId, channelLabel(channelId));
      }
    }),
  );
  return { actors, channelMentions, timezones, userMentions };
}

interface SlackTranscriptFileSummary {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  cached: boolean;
  localPath?: string;
}

function slackTranscriptFileSummaries(
  files: SlackFileInfo[] | undefined,
  cacheContext: SlackFileCacheContext,
): SlackTranscriptFileSummary[] {
  if (!files?.length) return [];
  return files
    .filter((file): file is SlackFileInfo & { id: string } => Boolean(file.id))
    .map((file) => {
      const cachePath = cachedFilePath(cacheContext, file);
      const cached = Boolean(cachePath && existsSync(cachePath));
      return {
        id: file.id,
        mimetype: file.mimetype ?? 'application/octet-stream',
        name: file.name ?? file.title ?? file.id,
        sizeBytes: typeof file.size === 'number' ? file.size : 0,
        cached,
        ...(cached && cachePath ? { localPath: cachePath } : {}),
      };
    });
}

function cachedFilePath(
  cacheContext: SlackFileCacheContext,
  file: SlackFileInfo & { id: string },
): string | undefined {
  const name = file.name ?? file.title;
  if (!name) return undefined;
  if (cacheContext.teamId) {
    return cachedSlackFilePath({ fileId: file.id, name, teamId: cacheContext.teamId });
  }
  return undefined;
}

function slackUserDisplayName(user: SlackUserInfo | undefined): string | undefined {
  return user?.displayName?.trim() || user?.realName?.trim() || undefined;
}

function slackChannelLabel(channel: SlackConversationInfo | undefined, fallbackChannelId: string): string {
  return channelLabel(channel?.name?.trim() || fallbackChannelId);
}

function slackTranscriptLine(
  message: SlackConversationMessage,
  request: SlackTranscriptRequest,
  userLabels: SlackTranscriptUserLabels,
  cacheContext: SlackFileCacheContext,
): string {
  const displayRef = slackReadChannelRef(request);
  const timezone = message.user ? userLabels.timezones.get(message.user) : undefined;
  const isoTs = slackTsToIso(message.ts) ?? message.ts;
  const threadRef = slackReadThreadRef(message, request);
  const envelope = renderEnvelope([
    { key: 'channel', value: displayRef },
    { key: 'channel_id', value: displayRef === request.channel ? undefined : request.channel },
    { key: 'thread_ts', value: threadRef },
    { key: 'message_ts', value: message.ts },
    { key: 'time', value: isoTs },
    { key: 'user_id', value: message.user },
    { key: 'user_local_time', value: timezone ? formatUserLocalTime(isoTs, timezone) : undefined },
    { key: 'user_tz', value: timezone?.name },
  ]);
  const text = replaceSlackChannelMentions(
    replaceSlackUserMentions(message.text ?? '', userLabels.userMentions),
    userLabels.channelMentions,
  );
  const fileAnnotations = slackTranscriptFileAnnotations(message.files, cacheContext);
  const previewAnnotations = slackTranscriptPreviewAnnotations(message.attachments);
  const annotations = [fileAnnotations, previewAnnotations].filter(Boolean).join('\n');
  const trailer = annotations ? `\n${annotations}` : '';
  return `${envelope} ${slackTranscriptActor(message, userLabels.actors)}: ${text}${trailer}`;
}

function slackTranscriptFileAnnotations(
  files: SlackFileInfo[] | undefined,
  cacheContext: SlackFileCacheContext,
): string {
  const summaries = slackTranscriptFileSummaries(files, cacheContext);
  if (summaries.length === 0) return '';
  return summaries
    .map((file) => {
      const cached = file.cached && file.localPath
        ? ` path=${file.localPath}`
        : ` (use \`anima file fetch ${file.id}\` to download)`;
      return `  attached: id=${file.id} name=${file.name} mimetype=${file.mimetype} size_bytes=${file.sizeBytes}${cached}`;
    })
    .join('\n');
}

function slackTranscriptPreviewAnnotations(attachments: unknown[] | undefined): string {
  const previews = slackMessagePreviewsFromAttachments(attachments);
  if (previews.length === 0) return '';
  return previews
    .map((preview) => {
      const attrs = [
        'slack_preview',
        preview.isPrivate ? 'private=true' : '',
        preview.authorName ? `author=${quoteValue(preview.authorName)}` : '',
        preview.authorId ? `author_id=${preview.authorId}` : '',
        preview.channelId ? `channel_id=${preview.channelId}` : '',
        preview.messageTs ? `message_ts=${preview.messageTs}` : '',
        preview.fromUrl ? `url=${preview.fromUrl}` : '',
      ].filter(Boolean).join(' ');
      const body = preview.text
        .split(/\r?\n/)
        .map((line) => `  > ${line}`)
        .join('\n');
      return `  preview: ${attrs}\n${body}`;
    })
    .join('\n');
}

function slackReadChannelRef(request: SlackTranscriptRequest): string {
  if (request.channelName) return `#${request.channelName}`;
  return request.channel;
}

function quoteValue(value: string): string {
  return JSON.stringify(value);
}

function slackReadThreadRef(message: SlackConversationMessage, request: SlackTranscriptRequest): string {
  return request.threadTs ?? (message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : '');
}

function slackTranscriptActor(message: SlackConversationMessage, userLabels: Map<string, string>): string {
  if (message.username) return atLabel(message.username);
  const label = message.user ? userLabels.get(message.user) : undefined;
  if (label) return label;
  if (message.user) return atLabel(message.user);
  if (message.bot_id) return `bot:${message.bot_id}`;
  return '@unknown';
}
