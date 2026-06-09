import type { ConversationsInfoResponse, UsersInfoResponse } from '@slack/web-api';

export type SlackConversationInfo = NonNullable<ConversationsInfoResponse['channel']>;
export type SlackUserInfo = NonNullable<UsersInfoResponse['user']>;

export interface SlackFile {
  downloadError?: string;
  id: string;
  mimetype: string;
  name: string;
  sizeBytes: number;
}

export interface SlackRawFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export type DownloadableSlackFile = SlackFile & { urlPrivate?: string };

const SLACK_USER_MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|([^>]+))?>/g;
const SLACK_CHANNEL_MENTION_PATTERN = /<#([A-Z0-9]+)(?:\|([^>]+))?>/g;
const READABLE_SLACK_USER_ID_PATTERN = /(^|[^A-Za-z0-9._%+`<@-])@(U[A-Z0-9]+)/g;
const READABLE_SLACK_USER_MENTION_PATTERN = /(^|[^A-Za-z0-9._%+`<@-])@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)/g;
const READABLE_SLACK_CHANNEL_MENTION_PATTERN = /(^|[^A-Za-z0-9._/`<#-])#([A-Za-z][A-Za-z0-9_-]*)/g;

export function extractSlackUserMentionIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(SLACK_USER_MENTION_PATTERN)) {
    const userId = match[1];
    if (userId) ids.add(userId);
  }
  return [...ids];
}

export function replaceSlackUserMentions(text: string, labels: Map<string, string>): string {
  return text.replace(SLACK_USER_MENTION_PATTERN, (_raw, userId: string, fallbackName: string | undefined) => {
    const rawLabel = labels.get(userId);
    if (rawLabel) return atLabel(rawLabel);
    if (fallbackName) return atLabel(fallbackName);
    return atLabel(userId);
  });
}

export function extractSlackChannelMentionIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(SLACK_CHANNEL_MENTION_PATTERN)) {
    const channelId = match[1];
    if (channelId) ids.add(channelId);
  }
  return [...ids];
}

export function replaceSlackChannelMentions(text: string, labels: Map<string, string>): string {
  return text.replace(SLACK_CHANNEL_MENTION_PATTERN, (_raw, channelId: string, fallbackName: string | undefined) => {
    const label = labels.get(channelId);
    if (label) return label;
    if (fallbackName) return channelLabel(fallbackName);
    return channelLabel(channelId);
  });
}

export function extractReadableSlackUserMentions(text: string): string[] {
  return extractReadableMentions(text, READABLE_SLACK_USER_MENTION_PATTERN);
}

export function extractReadableSlackUserIdMentions(text: string): string[] {
  const mentions = new Set<string>();
  forEachNonCodeSegment(text, (segment) => {
    for (const match of segment.matchAll(READABLE_SLACK_USER_ID_PATTERN)) {
      const mention = match[2];
      if (mention) mentions.add(mention);
    }
  });
  return [...mentions];
}

export function replaceReadableSlackUserMentions(text: string, userIds: Map<string, string>): string {
  return replaceOutsideMarkdownCode(text, (segment) => segment.replace(READABLE_SLACK_USER_MENTION_PATTERN, (raw, prefix: string, handle: string | undefined) => {
    if (!handle) return raw;
    const userId = userIds.get(normalizeReadableMention(handle));
    return userId ? `${prefix}<@${userId}>` : raw;
  }));
}

export function replaceReadableSlackUserIdMentions(text: string): string {
  return replaceOutsideMarkdownCode(text, (segment) => segment.replace(READABLE_SLACK_USER_ID_PATTERN, (raw, prefix: string, userId: string | undefined) => (
    userId ? `${prefix}<@${userId}>` : raw
  )));
}

export function extractReadableSlackChannelMentions(text: string): string[] {
  return extractReadableMentions(text, READABLE_SLACK_CHANNEL_MENTION_PATTERN);
}

export function replaceReadableSlackChannelMentions(text: string, channelIds: Map<string, string>): string {
  return replaceOutsideMarkdownCode(text, (segment) => segment.replace(READABLE_SLACK_CHANNEL_MENTION_PATTERN, (raw, prefix: string, name: string | undefined) => {
    if (!name) return raw;
    const channelId = channelIds.get(normalizeReadableMention(name));
    return channelId ? `${prefix}<#${channelId}>` : raw;
  }));
}

export function atLabel(value: string): string {
  return value.startsWith('@') ? value : `@${value}`;
}

export function channelLabel(value: string): string {
  return value.startsWith('#') ? value : `#${value}`;
}

export function findSlackConversationByName(
  channels: SlackConversationInfo[],
  name: string,
): SlackConversationInfo | undefined {
  return channels.find((channel) => normalizeSlackConversationName(channel.name_normalized ?? channel.name ?? '') === name);
}

export function getUniqueSlackUserByHandle(users: SlackUserInfo[], handle: string): SlackUserInfo {
  const matches = users.filter((user) => slackUserHandleCandidates(user).includes(handle));
  const match = matches[0];
  if (matches.length === 1 && match) return match;
  if (matches.length > 1) throw new Error(`Slack handle @${handle} matched multiple users`);
  throw new Error(`Slack user not found: @${handle}`);
}

export function isFreshSlackCacheEntry(iso: string | undefined, ttlMs: number): boolean {
  if (!iso) return false;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && Date.now() - timestamp < ttlMs;
}

export function normalizeSlackConversationName(value: string): string {
  return value.trim().replace(/^#/, '').toLowerCase();
}

export function normalizeSlackEventFiles(rawFiles: SlackRawFile[] | undefined): SlackFile[] | undefined {
  if (!rawFiles?.length) return undefined;
  const files: SlackFile[] = [];
  for (const raw of rawFiles) {
    const file = slackFileFromRaw(raw);
    if (file) {
      const { urlPrivate: _, ...meta } = file;
      files.push(meta);
    }
  }
  return files;
}

export function normalizeSlackHandle(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function slackFileFromRaw(raw: SlackRawFile): DownloadableSlackFile | undefined {
  if (!raw.id) return undefined;
  return {
    id: raw.id,
    name: raw.name ?? raw.title ?? raw.id,
    mimetype: raw.mimetype ?? 'application/octet-stream',
    sizeBytes: typeof raw.size === 'number' ? raw.size : 0,
    ...(raw.url_private_download || raw.url_private
      ? { urlPrivate: raw.url_private_download ?? raw.url_private }
      : {}),
  };
}

export function slackUserHandleCandidates(user: SlackUserInfo): string[] {
  return [
    user.name,
    user.profile?.display_name,
    user.profile?.real_name,
    user.real_name,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeSlackHandle);
}

export function upsertSlackConversation<T extends { channels: SlackConversationInfo[] }>(
  cache: T,
  channel: SlackConversationInfo,
): T {
  if (!channel.id) return cache;
  return {
    ...cache,
    channels: upsertById(cache.channels, channel),
  };
}

export function upsertSlackUser<T extends { users: SlackUserInfo[] }>(
  cache: T,
  user: SlackUserInfo,
): T {
  if (!user.id) return cache;
  return {
    ...cache,
    users: upsertById(cache.users, user),
  };
}

function extractReadableMentions(text: string, pattern: RegExp): string[] {
  const mentions = new Set<string>();
  forEachNonCodeSegment(text, (segment) => {
    for (const match of segment.matchAll(pattern)) {
      const mention = match[2];
      if (mention) mentions.add(normalizeReadableMention(mention));
    }
  });
  return [...mentions];
}

function normalizeReadableMention(value: string): string {
  return value.trim().replace(/^[@#]/, '').toLowerCase();
}

function replaceOutsideMarkdownCode(text: string, replace: (segment: string) => string): string {
  let output = '';
  forEachSegment(text, (segment, isCode) => {
    output += isCode ? segment : replace(segment);
  });
  return output;
}

function forEachNonCodeSegment(text: string, visit: (segment: string) => void): void {
  forEachSegment(text, (segment, isCode) => {
    if (!isCode) visit(segment);
  });
}

function forEachSegment(text: string, visit: (segment: string, isCode: boolean) => void): void {
  let cursor = 0;
  while (cursor < text.length) {
    const tickStart = text.indexOf('`', cursor);
    if (tickStart === -1) {
      visit(text.slice(cursor), false);
      return;
    }
    if (tickStart > cursor) {
      visit(text.slice(cursor, tickStart), false);
    }
    const tickEnd = endOfBacktickSpan(text, tickStart);
    if (tickEnd === -1) {
      visit(text.slice(tickStart), false);
      return;
    }
    visit(text.slice(tickStart, tickEnd), true);
    cursor = tickEnd;
  }
}

function endOfBacktickSpan(text: string, start: number): number {
  let count = 0;
  while (text[start + count] === '`') count += 1;
  const fence = '`'.repeat(count);
  const end = text.indexOf(fence, start + count);
  return end === -1 ? -1 : end + count;
}

function upsertById<T extends { id?: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => itemIndex === index ? next : item);
}
