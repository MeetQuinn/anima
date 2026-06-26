import type { WebClient } from '@slack/web-api';

import { nowIso } from '../ids.js';
import {
  getSlackWorkspaceDirectoryStore,
  type SlackWorkspaceDirectoryFile,
} from '../storage/schema/cache.js';
import type { SlackUserCandidate } from '../../shared/agent-config.js';
import {
  findSlackConversationByName,
  getUniqueSlackUserByHandle,
  isFreshSlackCacheEntry,
  normalizeSlackConversationName,
  normalizeSlackHandle,
  slackUserHandleCandidates,
  type SlackConversationInfo,
  type SlackUserInfo,
  upsertSlackConversation,
  upsertSlackUser,
} from './slack.helper.js';

export type { SlackConversationInfo, SlackUserInfo } from './slack.helper.js';

export interface SlackWorkspaceDirectoryEvent {
  channel?: SlackConversationInfo | string;
  channel_id?: string;
  team?: string;
  type?: string;
  user?: SlackUserInfo;
}

const SLACK_WORKSPACE_DIRECTORY_TTL_MS = 10 * 60 * 1000;

export class SlackWorkspaceDirectoryService {
  constructor(private readonly input: {
    client: WebClient;
    teamId?: string;
  }) {}

  async getUser(userId: string): Promise<SlackUserInfo | undefined> {
    const cached = await this.readCache((cache) => cache.users.find((user) => user.id === userId));
    if (cached) return cached;

    const user = (await this.input.client.users.info({ user: userId })).user;
    if (user?.id) await this.updateCache((cache) => upsertSlackUser(cache, user));
    return user;
  }

  async getUserByHandle(handleInput: string): Promise<SlackUserInfo> {
    const handle = normalizeSlackHandle(handleInput);
    const cached = await this.cachedUserByHandle(handle);
    if (cached) return cached;

    const users = await this.refreshUsers();
    return getUniqueSlackUserByHandle(users, handle);
  }

  async getUserByHandleForTarget(handleInput: string, target: { channelId?: string }): Promise<SlackUserInfo> {
    const handle = normalizeSlackHandle(handleInput);
    const cached = await this.cachedUsersByHandle(handle);
    const matches = cached?.length
      ? cached
      : (await this.refreshUsers()).filter((user) => slackUserHandleCandidates(user).includes(handle));
    return this.preferredUniqueUserByHandle(handle, matches, target);
  }

  async getUsers(): Promise<SlackUserInfo[]> {
    const cached = await this.readFreshCache('usersSyncedAt', (cache) => cache.users);
    if (cached?.length) return cached;
    return this.refreshUsers();
  }

  async getUserCandidates(): Promise<SlackUserCandidate[]> {
    const users = await this.getUsers();
    return users
      .filter((user) => Boolean(user.id) && !user.deleted && !user.is_bot && !user.is_app_user && user.id !== 'USLACKBOT')
      .map((user) => {
        const displayName = this.getUserDisplayName(user, user.id as string);
        const handle = user.name?.trim() || undefined;
        const avatarUrl = user.profile?.image_72?.trim() || undefined;
        return {
          slackUserId: user.id as string,
          displayName,
          ...(handle ? { handle } : {}),
          ...(avatarUrl ? { avatarUrl } : {}),
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  getUserDisplayName(user: SlackUserInfo | undefined, fallback: string): string {
    return user?.profile?.display_name?.trim()
      || user?.profile?.real_name?.trim()
      || user?.real_name?.trim()
      || user?.name?.trim()
      || fallback;
  }

  async openDm(userId: string): Promise<SlackConversationInfo> {
    const body = await this.input.client.conversations.open({ users: userId });
    if (!body.channel?.id) throw new Error(`Slack conversations.open did not return a DM channel for ${userId}`);
    await this.updateCache((cache) => upsertSlackConversation(cache, body.channel as SlackConversationInfo));
    return body.channel;
  }

  async getConversation(channel: string): Promise<SlackConversationInfo | undefined> {
    const cached = await this.readCache((cache) => cache.channels.find((entry) => entry.id === channel));
    if (cached) return cached;

    const conversation = (await this.input.client.conversations.info({ channel })).channel;
    if (conversation?.id) await this.updateCache((cache) => upsertSlackConversation(cache, conversation));
    return conversation;
  }

  async getConversationByName(nameInput: string, types?: string): Promise<SlackConversationInfo> {
    const name = normalizeSlackConversationName(nameInput);
    const cached = await this.readFreshCache('channelsSyncedAt', (cache) => findSlackConversationByName(cache.channels, name));
    if (cached) return cached;

    const channels = await this.refreshConversations(types);
    const match = findSlackConversationByName(channels, name);
    if (match?.id) return match;
    throw new Error(`Slack channel not found: #${name}`);
  }

  async getMemberConversations(types = 'public_channel,private_channel,mpim'): Promise<SlackConversationInfo[]> {
    const channels = await this.refreshConversations(types);
    return channels.filter((channel) => channel.is_member || channel.is_mpim || channel.is_group);
  }

  async getWorkspaceIconUrl(teamId = this.input.teamId): Promise<string> {
    const cached = teamId && await this.readFreshCache('workspace', (cache) => cache.workspace?.iconUrl ?? '');
    if (cached) return cached;

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
      await this.updateCache((cache) => ({
        ...upsertSlackUser(cache, event.user as SlackUserInfo),
        usersSyncedAt: nowIso(),
      }), teamId);
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
      await this.updateCache((cache) => ({
        ...upsertSlackConversation(cache, event.channel as SlackConversationInfo),
        channelsSyncedAt: nowIso(),
      }), teamId);
      return;
    }
    if (event.type === 'channel_deleted') {
      const channelId = typeof event.channel === 'string' ? event.channel : event.channel_id;
      if (channelId) {
        await this.updateCache((cache) => ({
          ...cache,
          channels: cache.channels.filter((channel) => channel.id !== channelId),
          channelsSyncedAt: nowIso(),
        }), teamId);
      }
    }
  }

  private async cachedUserByHandle(handle: string): Promise<SlackUserInfo | undefined> {
    const cached = await this.readFreshCache('usersSyncedAt', (cache) => {
      const matches = cache.users.filter((user) => slackUserHandleCandidates(user).includes(handle));
      const match = matches[0];
      if (matches.length === 1 && match) return match;
      if (matches.length > 1) throw new Error(`Slack handle @${handle} matched multiple users`);
      return undefined;
    });
    return cached;
  }

  private async cachedUsersByHandle(handle: string): Promise<SlackUserInfo[] | undefined> {
    return this.readFreshCache('usersSyncedAt', (cache) => (
      cache.users.filter((user) => slackUserHandleCandidates(user).includes(handle))
    ));
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
        const memberMatches = candidates.filter((user) => user.id && memberIds.has(user.id));
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
      ? users.filter((user) => !user.is_stranger && (!user.team_id || user.team_id === this.input.teamId))
      : [];
    if (sameWorkspace.length === 1 && sameWorkspace[0]) return sameWorkspace[0];

    const nonStrangers = users.filter((user) => !user.is_stranger);
    if (nonStrangers.length === 1 && nonStrangers[0]) return nonStrangers[0];

    throw new Error(`Slack handle @${handle} matched multiple users`);
  }

  private async refreshUsers(): Promise<SlackUserInfo[]> {
    const users: SlackUserInfo[] = [];
    let cursor = '';
    for (;;) {
      const body = await this.input.client.users.list({
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      users.push(...(body.members ?? []).filter((user): user is SlackUserInfo => Boolean(user.id)));
      cursor = body.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    await this.updateCache((cache) => ({
      ...cache,
      users,
      usersSyncedAt: nowIso(),
    }));
    return users;
  }

  private async refreshConversations(types?: string): Promise<SlackConversationInfo[]> {
    const channels: SlackConversationInfo[] = [];
    let cursor = '';
    for (;;) {
      const body = await this.input.client.conversations.list({
        ...(cursor ? { cursor } : {}),
        exclude_archived: true,
        limit: 200,
        types: types ?? 'public_channel,private_channel',
      });
      channels.push(...(body.channels ?? []).filter((channel): channel is SlackConversationInfo => Boolean(channel.id)));
      cursor = body.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    await this.updateCache((cache) => ({
      ...cache,
      channels,
      channelsSyncedAt: nowIso(),
    }));
    return channels;
  }

  private async readFreshCache<T>(
    timestampKey: 'channelsSyncedAt' | 'usersSyncedAt' | 'workspace',
    select: (cache: SlackWorkspaceDirectoryFile) => T | undefined,
  ): Promise<T | undefined> {
    const teamId = this.input.teamId;
    if (!teamId) return undefined;
    return this.readCache((cache) => {
      const timestamp = timestampKey === 'workspace' ? cache.workspace?.syncedAt : cache[timestampKey];
      if (!isFreshSlackCacheEntry(timestamp, SLACK_WORKSPACE_DIRECTORY_TTL_MS)) return undefined;
      return select(cache);
    }, teamId);
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
