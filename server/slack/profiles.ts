import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import {
  SlackWorkspaceDirectoryService,
} from './workspace-directory.service.js';
import {
  channelLabel,
  extractSlackChannelMentionIds,
  extractSlackUserMentionIds,
  isBotSlackUser,
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
  /** True for bot and Slack-app senders. Absent means human, or not yet resolved. */
  isBot?: boolean;
  realName?: string;
  timezone?: {
    label?: string;
    name: string;
    offsetSeconds?: number;
  };
}

export class SlackProfileResolver {
  async user(input: {
    client: WebClient;
    teamId: string;
    userId: string;
  }): Promise<SlackUserProfile | undefined> {
    try {
      const user = await new SlackWorkspaceDirectoryService({
        client: input.client,
        teamId: input.teamId,
      }).getUser(input.userId);
      if (!user) return undefined;
      return {
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        displayName: user.displayName ?? user.realName ?? user.name ?? input.userId,
        ...(user.name ? { handle: user.name } : {}),
        ...(isBotSlackUser(user) ? { isBot: true } : {}),
        ...(user.realName ? { realName: user.realName } : {}),
        ...(user.timezone ? { timezone: user.timezone } : {}),
      };
    } catch (error) {
      console.warn(`Slack users.info failed for ${input.userId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async conversation(input: {
    channelId: string;
    client: WebClient;
    teamId: string;
  }): Promise<SlackConversationProfile | undefined> {
    try {
      const conversation = await new SlackWorkspaceDirectoryService({
        client: input.client,
        teamId: input.teamId,
      }).getConversation(input.channelId);
      return conversation?.name ? { name: conversation.name } : {};
    } catch (error) {
      console.warn(`Slack conversations.info failed for ${input.channelId}: ${errorMessage(error)}`);
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
