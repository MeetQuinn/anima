// Disk schema for reconstructable caches under ANIMA_HOME/cache.
//
// Current layout:
//   cache/feishu/files/<safe resource id>/meta.json
//   cache/feishu/files/<safe resource id>/<safe filename>
//   cache/feishu/tenants/<tenant or app id>/directory.json
//   cache/slack/files/<teamId>/<fileId>/meta.json
//   cache/slack/files/<teamId>/<fileId>/<safe original filename>
//   cache/slack/teams/<teamId>/directory.json
//
// The inbox keeps Slack file metadata for the product surface. The cache only
// records downloaded bytes so duplicate files shared across agents are stored
// once per Slack workspace.

import { join } from 'node:path';

import { z } from 'zod';

import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';
import type { SlackConversationInfo, SlackUserInfo } from '../../slack/slack.helper.js';

export const FeishuFileCacheMeta = z.object({
  fileId: z.string(),
  fileKey: z.string(),
  messageId: z.string(),
  mimetype: z.string(),
  name: z.string(),
  resourceType: z.enum(['audio', 'file', 'image']),
  sizeBytes: z.number(),
});

export type FeishuFileCacheMeta = z.infer<typeof FeishuFileCacheMeta>;

export const SlackFileCacheMeta = z.object({
  id: z.string(),
  mimetype: z.string(),
  name: z.string(),
  sizeBytes: z.number(),
  teamId: z.string(),
});

export type SlackFileCacheMeta = z.infer<typeof SlackFileCacheMeta>;

export interface SlackWorkspaceDirectoryFile {
  channels: SlackConversationInfo[];
  channelsSyncedAt?: string;
  // The conversation `types` set that populated `channels` on the last refresh
  // (e.g. "public_channel,private_channel,mpim"). A cache hit is only honored
  // when this coverage is a superset of what the caller asked for, so a narrow
  // refresh (no mpim) can never masquerade as a complete membership list.
  channelsSyncedTypes?: string;
  teamId: string;
  users: SlackUserInfo[];
  usersSyncedAt?: string;
  workspace?: {
    iconUrl?: string;
    syncedAt: string;
  };
}

export interface FeishuDirectoryChatInfo {
  avatarUrl?: string;
  chatId: string;
  chatName?: string;
  chatType?: string;
  updatedAt: string;
}

export interface FeishuDirectoryUserInfo {
  displayName?: string;
  i18nName?: Record<string, string>;
  openId: string;
  unionId?: string;
  updatedAt: string;
  userId?: string;
}

export interface FeishuDirectoryFile {
  chats: FeishuDirectoryChatInfo[];
  directoryId: string;
  users: FeishuDirectoryUserInfo[];
}

export const SlackWorkspaceDirectoryFileSchema = z.object({
  channels: z.array(z.object({ id: z.string() }).passthrough()).default([]),
  channelsSyncedAt: z.string().optional(),
  channelsSyncedTypes: z.string().optional(),
  teamId: z.string(),
  users: z.array(z.object({ id: z.string() }).passthrough()).default([]),
  usersSyncedAt: z.string().optional(),
  workspace: z.object({
    iconUrl: z.string().optional(),
    syncedAt: z.string(),
  }).optional(),
});

export const FeishuDirectoryFileSchema = z.object({
  chats: z.array(z.object({
    avatarUrl: z.string().optional(),
    chatId: z.string(),
    chatName: z.string().optional(),
    chatType: z.string().optional(),
    updatedAt: z.string(),
  })).default([]),
  directoryId: z.string(),
  users: z.array(z.object({
    displayName: z.string().optional(),
    i18nName: z.record(z.string(), z.string()).optional(),
    openId: z.string(),
    unionId: z.string().optional(),
    updatedAt: z.string(),
    userId: z.string().optional(),
  })).default([]),
});

export const getSlackFileCacheMetaStore = (teamId: string, fileId: string): JsonStore<Partial<SlackFileCacheMeta>> =>
  new JsonStore<Partial<SlackFileCacheMeta>>({
    empty: () => ({}),
    parse: SlackFileCacheMeta.partial().parse,
    path: () => join(slackFileCacheDir(teamId, fileId), 'meta.json'),
  });

export const getFeishuFileCacheMetaStore = (fileId: string): JsonStore<Partial<FeishuFileCacheMeta>> =>
  new JsonStore<Partial<FeishuFileCacheMeta>>({
    empty: () => ({}),
    parse: FeishuFileCacheMeta.partial().parse,
    path: () => join(feishuFileCacheDir(fileId), 'meta.json'),
  });

export function feishuFileCacheDir(fileId: string): string {
  return join(resolveAnimaHome(), 'cache', 'feishu', 'files', safeFeishuCacheSegment(fileId));
}

export function slackFileCacheDir(teamId: string, fileId: string): string {
  return join(resolveAnimaHome(), 'cache', 'slack', 'files', teamId, fileId);
}

export const getSlackWorkspaceDirectoryStore = (teamId: string): JsonStore<SlackWorkspaceDirectoryFile> =>
  new JsonStore<SlackWorkspaceDirectoryFile>({
    empty: () => ({ channels: [], teamId, users: [] }),
    parse: (value) => SlackWorkspaceDirectoryFileSchema.parse(value) as SlackWorkspaceDirectoryFile,
    path: () => join(resolveAnimaHome(), 'cache', 'slack', 'teams', teamId, 'directory.json'),
  });

export const getFeishuDirectoryStore = (directoryId: string): JsonStore<FeishuDirectoryFile> =>
  new JsonStore<FeishuDirectoryFile>({
    empty: () => ({ chats: [], directoryId, users: [] }),
    parse: (value) => FeishuDirectoryFileSchema.parse(value) as FeishuDirectoryFile,
    path: () => join(resolveAnimaHome(), 'cache', 'feishu', 'tenants', safeFeishuCacheSegment(directoryId), 'directory.json'),
  });

function safeFeishuCacheSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'resource';
}
