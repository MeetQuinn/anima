import type { WebClient } from '@slack/web-api';

import { nowIso } from '../ids.js';
import {
  getSlackWorkspaceDirectoryStore,
  type SlackDirectoryConversation,
  type SlackDirectoryUser,
  type SlackWorkspaceDirectoryFile,
} from '../storage/schema/cache.js';
import type { SlackUserCandidate } from '../../shared/agent-config.js';
import {
  findSlackConversationByName,
  isFreshSlackCacheEntry,
  normalizeSlackConversationName,
  normalizeSlackHandle,
  slackUserHandleCandidates,
  type SlackConversationInfo as SlackApiConversationInfo,
  type SlackUserInfo as SlackApiUserInfo,
} from './slack.helper.js';

export type SlackConversationInfo = SlackDirectoryConversation;
export type SlackUserInfo = SlackDirectoryUser;

export interface SlackWorkspaceDirectoryEvent {
  channel?: SlackApiConversationInfo | string;
  channel_id?: string;
  team?: string;
  type?: string;
  user?: SlackApiUserInfo;
}

const SLACK_WORKSPACE_DIRECTORY_TTL_MS = 10 * 60 * 1000;
const SLACK_WORKSPACE_DIRECTORY_NEGATIVE_TTL_MS = 60 * 1000;
const DEFAULT_CONVERSATION_TYPES = 'public_channel,private_channel';
const MEMBER_CONVERSATION_TYPES = 'public_channel,private_channel,mpim';

const inFlightEntryRefresh = new Map<string, Promise<unknown>>();
const inFlightCollectionRefresh = new Map<string, Promise<unknown>>();
const negativeLookups = new Map<string, number>();

type DirectoryEntryKind = 'channel' | 'user' | 'workspace';
type DirectoryCollectionKind = 'channels' | 'users';

function filterMemberConversations(channels: SlackConversationInfo[]): SlackConversationInfo[] {
  return channels.filter((channel) => channel.isMember || channel.isMpim || channel.isGroup);
}

function parseConversationTypes(types: string): Set<string> {
  return new Set(types.split(',').map((type) => type.trim()).filter(Boolean));
}

function cacheCoversTypes(syncedTypes: string | undefined, requested: string): boolean {
  if (!syncedTypes) return false;
  const have = parseConversationTypes(syncedTypes);
  for (const type of parseConversationTypes(requested)) {
    if (!have.has(type)) return false;
  }
  return true;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const next = items.filter((entry) => entry.id !== item.id);
  next.push(item);
  return next;
}

function trim(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function normalizeSlackUserInfo(user: SlackApiUserInfo, syncedAt = nowIso()): SlackUserInfo | undefined {
  if (!user.id) return undefined;
  const name = trim(user.name);
  const realName = trim(user.profile?.real_name) ?? trim(user.real_name);
  const displayName = trim(user.profile?.display_name) ?? realName ?? name;
  const avatarUrl = trim(user.profile?.image_72);
  const timezoneName = trim(user.tz);
  const timezoneLabel = trim(user.tz_label);
  const normalized: SlackUserInfo = {
    id: user.id,
    syncedAt,
  };
  if (avatarUrl) normalized.avatarUrl = avatarUrl;
  if (typeof user.deleted === 'boolean') normalized.deleted = user.deleted;
  if (displayName) normalized.displayName = displayName;
  if (typeof user.is_app_user === 'boolean') normalized.isAppUser = user.is_app_user;
  if (typeof user.is_bot === 'boolean') normalized.isBot = user.is_bot;
  if (typeof user.is_stranger === 'boolean') normalized.isStranger = user.is_stranger;
  if (name) normalized.name = name;
  if (realName) normalized.realName = realName;
  if (trim(user.team_id)) normalized.teamId = trim(user.team_id);
  if (timezoneName) {
    normalized.timezone = {
      name: timezoneName,
      ...(timezoneLabel ? { label: timezoneLabel } : {}),
      ...(typeof user.tz_offset === 'number' ? { offsetSeconds: user.tz_offset } : {}),
    };
  }
  return normalized;
}

export function normalizeSlackConversationInfo(
  channel: SlackApiConversationInfo,
  syncedAt = nowIso(),
): SlackConversationInfo | undefined {
  if (!channel.id) return undefined;
  const name = trim(channel.name_normalized) ?? trim(channel.name);
  const topic = trim(channel.topic?.value);
  const userId = trim((channel as Record<string, unknown>)['user']);
  const normalized: SlackConversationInfo = {
    id: channel.id,
    syncedAt,
  };
  if (typeof channel.is_group === 'boolean') normalized.isGroup = channel.is_group;
  if (typeof channel.is_im === 'boolean') normalized.isIm = channel.is_im;
  if (typeof channel.is_member === 'boolean') normalized.isMember = channel.is_member;
  if (typeof channel.is_mpim === 'boolean') normalized.isMpim = channel.is_mpim;
  if (typeof channel.num_members === 'number') normalized.memberCount = channel.num_members;
  if (name) normalized.name = name;
  if (topic) normalized.topic = topic;
  if (userId) normalized.userId = userId;
  return normalized;
}

export class SlackWorkspaceDirectoryService {
  constructor(private readonly input: {
    client: WebClient;
    teamId?: string;
  }) {}

  async getUser(userId: string): Promise<SlackUserInfo | undefined> {
    return this.readEntry({
      fetch: () => this.fetchUser(userId),
      id: userId,
      kind: 'user',
      select: (cache) => {
        const user = cache.users.find((entry) => entry.id === userId);
        return user ? { syncedAt: user.syncedAt, value: user } : undefined;
      },
    });
  }

  async getUserByHandle(handleInput: string): Promise<SlackUserInfo> {
    const handle = normalizeSlackHandle(handleInput);
    const users = await this.getUsers();
    return uniqueSlackUserByHandle(users, handle);
  }

  async getUserByHandleForTarget(handleInput: string, target: { channelId?: string }): Promise<SlackUserInfo> {
    const handle = normalizeSlackHandle(handleInput);
    const matches = (await this.getUsers()).filter((user) => slackUserHandleCandidates(user).includes(handle));
    return this.preferredUniqueUserByHandle(handle, matches, target);
  }

  async getUsers(): Promise<SlackUserInfo[]> {
    return this.readCollection({
      fetch: () => this.refreshUsers(),
      kind: 'users',
      select: (cache) => cache.usersFullSyncAt
        ? { items: cache.users, syncedAt: cache.usersFullSyncAt }
        : undefined,
    });
  }

  async getUserCandidates(): Promise<SlackUserCandidate[]> {
    const users = await this.getUsers();
    return users
      .filter((user) => !user.deleted && !user.isBot && !user.isAppUser && user.id !== 'USLACKBOT')
      .map((user) => {
        const displayName = this.getUserDisplayName(user, user.id);
        const handle = user.name?.trim() || undefined;
        const avatarUrl = user.avatarUrl?.trim() || undefined;
        return {
          slackUserId: user.id,
          displayName,
          ...(handle ? { handle } : {}),
          ...(avatarUrl ? { avatarUrl } : {}),
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  getUserDisplayName(user: SlackUserInfo | SlackApiUserInfo | undefined, fallback: string): string {
    if (!user) return fallback;
    if ('profile' in user) {
      return trim(user.profile?.display_name)
        ?? trim(user.profile?.real_name)
        ?? trim(user.real_name)
        ?? trim(user.name)
        ?? fallback;
    }
    const normalized = user as SlackUserInfo;
    return normalized.displayName?.trim() || normalized.realName?.trim() || normalized.name?.trim() || fallback;
  }

  async openDm(userId: string): Promise<SlackConversationInfo> {
    const body = await this.input.client.conversations.open({ users: userId });
    if (!body.channel?.id) throw new Error(`Slack conversations.open did not return a DM channel for ${userId}`);
    const conversation = normalizeSlackConversationInfo(body.channel as SlackApiConversationInfo);
    if (conversation) await this.upsertConversation(conversation);
    return conversation ?? { id: body.channel.id, syncedAt: nowIso() };
  }

  async getConversation(channel: string): Promise<SlackConversationInfo | undefined> {
    return this.readEntry({
      fetch: () => this.fetchConversation(channel),
      id: channel,
      kind: 'channel',
      select: (cache) => {
        const conversation = cache.channels.find((entry) => entry.id === channel);
        return conversation ? { syncedAt: conversation.syncedAt, value: conversation } : undefined;
      },
    });
  }

  async getConversationByName(nameInput: string, types?: string): Promise<SlackConversationInfo> {
    const name = normalizeSlackConversationName(nameInput);
    const channels = await this.readCollection({
      fetch: () => this.refreshConversations(types),
      kind: 'channels',
      select: (cache) => cache.channelsFullSyncAt && cacheCoversTypes(cache.channelsFullSyncTypes, types ?? DEFAULT_CONVERSATION_TYPES)
        ? { items: cache.channels, syncedAt: cache.channelsFullSyncAt }
        : undefined,
    });
    const match = findSlackConversationByName(channels, name);
    if (match?.id) return match;
    throw new Error(`Slack channel not found: #${name}`);
  }

  async getMemberConversations(types = MEMBER_CONVERSATION_TYPES): Promise<SlackConversationInfo[]> {
    const channels = await this.readCollection({
      fetch: () => this.refreshConversations(types),
      kind: 'channels',
      select: (cache) => cache.channelsFullSyncAt && cacheCoversTypes(cache.channelsFullSyncTypes, types)
        ? { items: cache.channels, syncedAt: cache.channelsFullSyncAt }
        : undefined,
    });
    return filterMemberConversations(channels);
  }

  async getWorkspaceIconUrl(teamId = this.input.teamId): Promise<string> {
    if (!teamId) return this.fetchWorkspaceIconUrl(teamId);
    const iconUrl = await this.readEntry({
      fetch: () => this.fetchWorkspaceIconUrl(teamId),
      id: 'icon',
      kind: 'workspace',
      select: (cache) => cache.workspace ? {
        syncedAt: cache.workspace.syncedAt,
        value: cache.workspace.iconUrl ?? '',
      } : undefined,
      teamId,
    });
    return iconUrl ?? '';
  }

  async getConversationMemberIds(channel: string): Promise<string[]> {
    const members = new Set<string>();
    if (!this.input.client.conversations.members) throw new Error('Slack conversations.members client unavailable');
    let cursor = '';
    for (;;) {
      const body = await this.input.client.conversations.members({
        channel,
        ...(cursor ? { cursor } : {}),
        limit: 1000,
      });
      for (const member of body.members ?? []) {
        members.add(member);
      }
      cursor = body.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    return [...members];
  }

  async applyEvent(event: SlackWorkspaceDirectoryEvent): Promise<void> {
    const teamId = this.input.teamId ?? event.team;
    if (!teamId) return;
    if ((event.type === 'team_join' || event.type === 'user_change') && event.user?.id) {
      const user = normalizeSlackUserInfo(event.user);
      if (user) await this.upsertUser(user, teamId);
      return;
    }
    if (
      (event.type === 'channel_created'
        || event.type === 'channel_rename'
        || event.type === 'channel_archive'
        || event.type === 'channel_unarchive')
      && typeof event.channel === 'object'
      && event.channel.id
    ) {
      const conversation = normalizeSlackConversationInfo(event.channel);
      if (conversation) await this.upsertConversation(conversation, teamId);
      return;
    }
    if (event.type === 'channel_deleted') {
      const channelId = typeof event.channel === 'string' ? event.channel : event.channel_id;
      if (channelId) {
        await this.updateCache((cache) => ({
          ...cache,
          channels: cache.channels.filter((channel) => channel.id !== channelId),
        }), teamId);
      }
    }
  }

  private async preferredUniqueUserByHandle(
    handle: string,
    matches: SlackUserInfo[],
    target: { channelId?: string },
  ): Promise<SlackUserInfo> {
    const liveMatches = matches.filter((user) => !user.deleted);
    const candidates = liveMatches.length ? liveMatches : matches;
    if (!candidates.length) throw new Error(`Slack user not found: @${handle}`);

    if (target.channelId && candidates.length > 1) {
      try {
        const memberIds = new Set(await this.getConversationMemberIds(target.channelId));
        const memberMatches = candidates.filter((user) => memberIds.has(user.id));
        if (memberMatches.length) return this.preferredUniqueWorkspaceUser(handle, memberMatches);
      } catch {
        // Membership is a preference signal. If Slack cannot provide it, fall back to workspace priority.
      }
    }

    return this.preferredUniqueWorkspaceUser(handle, candidates);
  }

  private preferredUniqueWorkspaceUser(handle: string, users: SlackUserInfo[]): SlackUserInfo {
    const match = users[0];
    if (users.length === 1 && match) return match;

    const sameWorkspace = this.input.teamId
      ? users.filter((user) => !user.isStranger && (!user.teamId || user.teamId === this.input.teamId))
      : [];
    if (sameWorkspace.length === 1 && sameWorkspace[0]) return sameWorkspace[0];

    const nonStrangers = users.filter((user) => !user.isStranger);
    if (nonStrangers.length === 1 && nonStrangers[0]) return nonStrangers[0];

    throw new Error(`Slack handle @${handle} matched multiple users`);
  }

  private async fetchUser(userId: string): Promise<SlackUserInfo | undefined> {
    const user = (await this.input.client.users.info({ user: userId })).user;
    const normalized = user?.id ? normalizeSlackUserInfo(user as SlackApiUserInfo) : undefined;
    if (normalized) await this.upsertUser(normalized);
    return normalized;
  }

  private async fetchConversation(channel: string): Promise<SlackConversationInfo | undefined> {
    const conversation = (await this.input.client.conversations.info({ channel })).channel;
    const normalized = conversation?.id ? normalizeSlackConversationInfo(conversation as SlackApiConversationInfo) : undefined;
    if (normalized) await this.upsertConversation(normalized);
    return normalized;
  }

  private async refreshUsers(): Promise<SlackUserInfo[]> {
    const syncedAt = nowIso();
    const users: SlackUserInfo[] = [];
    let cursor = '';
    for (;;) {
      const body = await this.input.client.users.list({
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      for (const user of body.members ?? []) {
        const normalized = normalizeSlackUserInfo(user as SlackApiUserInfo, syncedAt);
        if (normalized) users.push(normalized);
      }
      cursor = body.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    await this.updateCache((cache) => ({
      ...cache,
      users,
      usersFullSyncAt: syncedAt,
    }));
    return users;
  }

  private async refreshConversations(types?: string): Promise<SlackConversationInfo[]> {
    const resolvedTypes = types ?? DEFAULT_CONVERSATION_TYPES;
    const syncedAt = nowIso();
    const channels: SlackConversationInfo[] = [];
    let cursor = '';
    for (;;) {
      const body = await this.input.client.conversations.list({
        ...(cursor ? { cursor } : {}),
        exclude_archived: true,
        limit: 200,
        types: resolvedTypes,
      });
      for (const channel of body.channels ?? []) {
        const normalized = normalizeSlackConversationInfo(channel as SlackApiConversationInfo, syncedAt);
        if (normalized) channels.push(normalized);
      }
      cursor = body.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    await this.updateCache((cache) => ({
      ...cache,
      channels,
      channelsFullSyncAt: syncedAt,
      channelsFullSyncTypes: resolvedTypes,
    }));
    return channels;
  }

  private async fetchWorkspaceIconUrl(teamId: string | undefined): Promise<string> {
    const response = await this.input.client.team.info({ ...(teamId ? { team: teamId } : {}) });
    const icon = response.team?.icon;
    const iconUrl = (
      icon?.image_230
      ?? icon?.image_132
      ?? icon?.image_102
      ?? icon?.image_88
      ?? icon?.image_68
      ?? icon?.image_44
      ?? icon?.image_34
      ?? ''
    );
    if (teamId) {
      await this.updateCache((cache) => ({
        ...cache,
        workspace: { iconUrl, syncedAt: nowIso() },
      }), teamId);
    }
    return iconUrl;
  }

  private async readEntry<T>(input: {
    fetch: () => Promise<T | undefined>;
    id: string;
    kind: DirectoryEntryKind;
    select: (cache: SlackWorkspaceDirectoryFile) => { syncedAt: string; value: T } | undefined;
    teamId?: string;
  }): Promise<T | undefined> {
    const teamId = input.teamId ?? this.input.teamId;
    if (!teamId) return input.fetch();
    const cached = await this.readCache((cache) => input.select(cache), teamId);
    const value = cached?.value;
    const syncedAt = cached?.syncedAt;
    if (value !== undefined && isFreshSlackCacheEntry(syncedAt, SLACK_WORKSPACE_DIRECTORY_TTL_MS)) return value;
    if (value !== undefined) {
      this.triggerEntryRefresh(teamId, input.kind, input.id, input.fetch);
      return value;
    }

    const negativeKey = `${teamId}:${input.kind}:${input.id}`;
    if (negativeLookups.get(negativeKey) && isFreshSlackNegative(negativeLookups.get(negativeKey)!)) return undefined;
    try {
      const fetched = await this.singleFlightEntryFetch(teamId, input.kind, input.id, input.fetch);
      if (fetched === undefined) negativeLookups.set(negativeKey, Date.now());
      return fetched;
    } catch (error) {
      negativeLookups.set(negativeKey, Date.now());
      throw error;
    }
  }

  private async readCollection<T>(input: {
    fetch: () => Promise<T[]>;
    kind: DirectoryCollectionKind;
    select: (cache: SlackWorkspaceDirectoryFile) => { items: T[]; syncedAt: string } | undefined;
  }): Promise<T[]> {
    const teamId = this.input.teamId;
    if (!teamId) return input.fetch();
    const cached = await this.readCache((cache) => input.select(cache), teamId);
    if (cached && isFreshSlackCacheEntry(cached.syncedAt, SLACK_WORKSPACE_DIRECTORY_TTL_MS)) return cached.items;
    if (cached) {
      this.triggerCollectionRefresh(teamId, input.kind, input.fetch);
      return cached.items;
    }
    return this.singleFlightCollectionFetch(teamId, input.kind, input.fetch);
  }

  private triggerEntryRefresh<T>(
    teamId: string,
    kind: DirectoryEntryKind,
    id: string,
    fetch: () => Promise<T | undefined>,
  ): void {
    void this.singleFlightEntryFetch(teamId, kind, id, fetch).catch(() => undefined);
  }

  private triggerCollectionRefresh<T>(
    teamId: string,
    kind: DirectoryCollectionKind,
    fetch: () => Promise<T[]>,
  ): void {
    void this.singleFlightCollectionFetch(teamId, kind, fetch).catch(() => undefined);
  }

  private async singleFlightEntryFetch<T>(
    teamId: string,
    kind: DirectoryEntryKind,
    id: string,
    fetch: () => Promise<T | undefined>,
  ): Promise<T | undefined> {
    const key = `${teamId}:${kind}:${id}`;
    const existing = inFlightEntryRefresh.get(key) as Promise<T | undefined> | undefined;
    if (existing) return existing;
    const promise = fetch().finally(() => {
      inFlightEntryRefresh.delete(key);
    });
    inFlightEntryRefresh.set(key, promise);
    return promise;
  }

  private async singleFlightCollectionFetch<T>(
    teamId: string,
    kind: DirectoryCollectionKind,
    fetch: () => Promise<T[]>,
  ): Promise<T[]> {
    const key = `${teamId}:${kind}`;
    const existing = inFlightCollectionRefresh.get(key) as Promise<T[]> | undefined;
    if (existing) return existing;
    const promise = fetch().finally(() => {
      inFlightCollectionRefresh.delete(key);
    });
    inFlightCollectionRefresh.set(key, promise);
    return promise;
  }

  private async upsertUser(user: SlackUserInfo, teamId = this.input.teamId): Promise<void> {
    await this.updateCache((cache) => ({
      ...cache,
      users: upsertById(cache.users, user),
    }), teamId);
  }

  private async upsertConversation(conversation: SlackConversationInfo, teamId = this.input.teamId): Promise<void> {
    await this.updateCache((cache) => ({
      ...cache,
      channels: upsertById(cache.channels, conversation),
    }), teamId);
  }

  private async readCache<T>(
    select: (cache: SlackWorkspaceDirectoryFile) => T | undefined,
    teamId = this.input.teamId,
  ): Promise<T | undefined> {
    if (!teamId) return undefined;
    return select(await getSlackWorkspaceDirectoryStore(teamId).read());
  }

  private async updateCache(
    update: (cache: SlackWorkspaceDirectoryFile) => SlackWorkspaceDirectoryFile,
    teamId = this.input.teamId,
  ): Promise<void> {
    if (!teamId) return;
    await getSlackWorkspaceDirectoryStore(teamId).update(update);
  }
}

function uniqueSlackUserByHandle(users: SlackUserInfo[], handle: string): SlackUserInfo {
  const matches = users.filter((user) => slackUserHandleCandidates(user).includes(handle));
  const match = matches[0];
  if (matches.length === 1 && match) return match;
  if (matches.length > 1) throw new Error(`Slack handle @${handle} matched multiple users`);
  throw new Error(`Slack user not found: @${handle}`);
}

function isFreshSlackNegative(timestamp: number): boolean {
  return Date.now() - timestamp < SLACK_WORKSPACE_DIRECTORY_NEGATIVE_TTL_MS;
}
