import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import {
  SlackWorkspaceDirectoryService,
  type SlackConversationInfo,
  type SlackUserInfo,
} from './workspace-directory.service.js';
import {
  channelLabel,
  extractSlackChannelMentionIds,
  extractSlackUserMentionIds,
  replaceSlackChannelMentions,
  replaceSlackUserMentions,
  slackMentionLabel,
} from './slack.helper.js';

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

// Per-process cache over the workspace directory, normalizing Slack user and
// conversation records into the profile shape ingest and read surfaces consume.
// Lookup failures cache as `undefined` so one bad id never retries per message.
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
      const profile = normalizeSlackUserProfile(input.userId, user);
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

  // Resolves <@U…> and <#C…> markup in an inbound message into readable
  // @name / #channel labels. Unresolvable ids keep their Slack-provided
  // fallback name or the raw id.
  async displayText(input: {
    client: WebClient;
    teamId: string;
    text: string;
  }): Promise<string> {
    const userLabels = new Map<string, string>();
    await Promise.all(extractSlackUserMentionIds(input.text).map(async (userId) => {
      const profile = await this.user({ client: input.client, teamId: input.teamId, userId });
      userLabels.set(userId, slackMentionLabel({ ...profile, userId }));
    }));
    const channelLabels = new Map<string, string>();
    await Promise.all(extractSlackChannelMentionIds(input.text).map(async (channelId) => {
      const profile = await this.conversation({ channelId, client: input.client, teamId: input.teamId });
      channelLabels.set(channelId, channelLabel(profile?.name ?? channelId));
    }));
    return replaceSlackChannelMentions(replaceSlackUserMentions(input.text, userLabels), channelLabels);
  }
}

function normalizeSlackUserProfile(
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
