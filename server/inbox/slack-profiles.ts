import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import {
  SlackWorkspaceDirectoryService,
  type SlackConversationInfo,
  type SlackUserInfo,
} from '../slack/workspace-directory.service.js';
import {
  atLabel,
  channelLabel,
  extractSlackChannelMentionIds,
  extractSlackUserMentionIds,
} from '../slack/slack.helper.js';

export interface SlackConversationProfile {
  name?: string;
}

export interface SlackUserProfile {
  avatarUrl?: string;
  displayName?: string;
  handle?: string;
  realName?: string;
  timezone?: {
    label?: string;
    name: string;
    offsetSeconds?: number;
  };
}

interface SlackChannelMention {
  channelId: string;
  channelName?: string;
}

interface SlackUserMention {
  displayName?: string;
  handle?: string;
  realName?: string;
  userId: string;
}

export class SlackProfileResolver {
  private readonly conversations = new Map<string, SlackConversationProfile | undefined>();
  private readonly users = new Map<string, SlackUserProfile | undefined>();

  async user(input: {
    client: WebClient;
    teamId: string;
    userId: string;
  }): Promise<SlackUserProfile | undefined> {
    const cacheKey = `${input.teamId}:${input.userId}`;
    if (this.users.has(cacheKey)) return this.users.get(cacheKey);
    try {
      const user = await new SlackWorkspaceDirectoryService({
        client: input.client,
        teamId: input.teamId,
      }).getUser(input.userId);
      const profile = normalizeSlackUserProfile(input.teamId, input.userId, user);
      this.users.set(cacheKey, profile);
      return profile;
    } catch (error) {
      console.warn(`Slack users.info failed for ${input.userId}: ${errorMessage(error)}`);
      this.users.set(cacheKey, undefined);
      return undefined;
    }
  }

  async conversation(input: {
    channelId: string;
    client: WebClient;
    teamId: string;
  }): Promise<SlackConversationProfile | undefined> {
    const cacheKey = `${input.teamId}:${input.channelId}`;
    if (this.conversations.has(cacheKey)) return this.conversations.get(cacheKey);
    try {
      const conversation = await new SlackWorkspaceDirectoryService({
        client: input.client,
        teamId: input.teamId,
      }).getConversation(input.channelId);
      const profile = normalizeSlackConversationProfile(conversation);
      this.conversations.set(cacheKey, profile);
      return profile;
    } catch (error) {
      console.warn(`Slack conversations.info failed for ${input.channelId}: ${errorMessage(error)}`);
      this.conversations.set(cacheKey, undefined);
      return undefined;
    }
  }

  async userMentionLabels(input: {
    client: WebClient;
    teamId: string;
    text: string;
  }): Promise<Map<string, string>> {
    const mentions = await this.userMentions(input);
    return new Map(mentions.map((mention) => [mention.userId, slackMentionLabel(mention)]));
  }

  async channelMentionLabels(input: {
    client: WebClient;
    teamId: string;
    text: string;
  }): Promise<Map<string, string>> {
    const mentions = await this.channelMentions(input);
    return new Map(mentions.map((mention) => [mention.channelId, slackChannelMentionLabel(mention)]));
  }

  private async userMentions(input: {
    client: WebClient;
    teamId: string;
    text: string;
  }): Promise<SlackUserMention[]> {
    const userIds = extractSlackUserMentionIds(input.text);
    const profiles = await Promise.all(
      userIds.map(async (userId) => ({
        profile: await this.user({
          client: input.client,
          teamId: input.teamId,
          userId,
        }),
        userId,
      })),
    );
    return profiles.map(({ profile, userId }) => ({
      ...(profile ?? {}),
      userId,
    }));
  }

  private async channelMentions(input: {
    client: WebClient;
    teamId: string;
    text: string;
  }): Promise<SlackChannelMention[]> {
    const channelIds = extractSlackChannelMentionIds(input.text);
    const profiles = await Promise.all(
      channelIds.map(async (channelId) => ({
        profile: await this.conversation({
          channelId,
          client: input.client,
          teamId: input.teamId,
        }),
        channelId,
      })),
    );
    return profiles.map(({ profile, channelId }) => ({
      channelId,
      ...(profile?.name ? { channelName: profile.name } : {}),
    }));
  }
}

function slackMentionLabel(mention: SlackUserMention): string {
  if (mention.handle) return atLabel(mention.handle);
  if (mention.displayName) return atLabel(mention.displayName);
  return atLabel(mention.userId);
}

function slackChannelMentionLabel(mention: SlackChannelMention): string {
  return channelLabel(mention.channelName ?? mention.channelId);
}

function normalizeSlackUserProfile(
  _teamId: string,
  userId: string,
  user: SlackUserInfo | undefined,
): SlackUserProfile {
  const realName = user?.profile?.real_name?.trim() || user?.real_name?.trim() || undefined;
  const handle = user?.name?.trim() || undefined;
  const avatarUrl = user?.profile?.image_72?.trim() || undefined;
  const timezone = slackUserTimezone(user);
  return {
    ...(avatarUrl ? { avatarUrl } : {}),
    displayName: user?.profile?.display_name?.trim() || realName || handle || userId,
    handle,
    realName,
    ...(timezone ? { timezone } : {}),
  };
}

function normalizeSlackConversationProfile(
  conversation: SlackConversationInfo | undefined,
): SlackConversationProfile {
  const name = conversation?.name_normalized?.trim() || conversation?.name?.trim();
  return name ? { name } : {};
}

function slackUserTimezone(
  user: SlackUserInfo | undefined,
): SlackUserProfile['timezone'] | undefined {
  const name = user?.tz?.trim();
  if (!name) return undefined;
  const label = user?.tz_label?.trim();
  return {
    name,
    ...(label ? { label } : {}),
    ...(typeof user?.tz_offset === 'number' ? { offsetSeconds: user.tz_offset } : {}),
  };
}
