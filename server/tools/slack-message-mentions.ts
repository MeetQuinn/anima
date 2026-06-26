import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import {
  extractReadableSlackChannelMentions,
  extractReadableSlackUserIdMentions,
  extractReadableSlackUserMentions,
  extractSlackUserMentionIds,
  replaceReadableSlackChannelMentions,
  replaceReadableSlackUserIdMentions,
  replaceReadableSlackUserMentions,
} from '../slack/slack.helper.js';
import { resolveSlackChannelArgument } from './slack-channel-resolver.js';
import type { SlackTargetSummary } from './slack-target.js';

export interface SlackTextForPostMessage {
  resolved: SlackMentionResolution[];
  text: string;
  unresolved: SlackMentionResolutionFailure[];
}

export type SlackMentionResolution = {
  id: string;
  label: string;
  type: 'channel' | 'user';
};

export type SlackMentionResolutionFailure = {
  error: string;
  label: string;
  type: 'channel' | 'user';
};

const BROADCAST_MENTION_HANDLES = new Set(['channel', 'everyone', 'here']);
const LITERAL_READABLE_MENTION_HANDLES = new Set(['mention', 'mentions']);
const SLACK_USER_ID_HANDLE = /^u[A-Z0-9]+$/i;

export async function slackTextForPostMessage(input: {
  channelId?: string;
  client: WebClient;
  teamId?: string;
  text: string;
}): Promise<SlackTextForPostMessage> {
  const userIds = new Map<string, string>();
  const channelIds = new Map<string, string>();
  const resolved: SlackMentionResolution[] = [];
  const unresolved: SlackMentionResolutionFailure[] = [];
  const directory = new SlackWorkspaceDirectoryService({
    client: input.client,
    teamId: input.teamId,
  });

  for (const userId of extractReadableSlackUserIdMentions(input.text)) {
    const id = userId.toUpperCase();
    resolved.push({ id, label: `@${id}`, type: 'user' });
  }
  await Promise.all(
    extractReadableSlackUserMentions(input.text).map(async (handle) => {
      if (
        BROADCAST_MENTION_HANDLES.has(handle)
        || LITERAL_READABLE_MENTION_HANDLES.has(handle)
        || SLACK_USER_ID_HANDLE.test(handle)
      ) {
        return;
      }
      try {
        const user = input.channelId
          ? await directory.getUserByHandleForTarget(handle, { channelId: input.channelId })
          : await directory.getUserByHandle(handle);
        if (!user.id) return;
        userIds.set(handle, user.id);
        resolved.push({ id: user.id, label: `@${handle}`, type: 'user' });
      } catch (error) {
        unresolved.push({ error: errorMessage(error), label: `@${handle}`, type: 'user' });
      }
    }),
  );
  await Promise.all(
    extractReadableSlackChannelMentions(input.text).map(async (name) => {
      try {
        const channel = await resolveSlackChannelArgument({
          channel: `#${name}`,
          client: input.client,
          teamId: input.teamId,
        });
        channelIds.set(name, channel.id);
        resolved.push({ id: channel.id, label: `#${name}`, type: 'channel' });
      } catch (error) {
        unresolved.push({ error: errorMessage(error), label: `#${name}`, type: 'channel' });
      }
    }),
  );

  const text = replaceReadableSlackChannelMentions(
    replaceReadableSlackUserMentions(replaceReadableSlackUserIdMentions(input.text), userIds),
    channelIds,
  );
  return { resolved, text, unresolved };
}

export async function mentionWarningsForTarget(input: {
  channelId: string;
  client: WebClient;
  slackText: SlackTextForPostMessage;
  target: SlackTargetSummary;
  teamId?: string;
}): Promise<string[]> {
  const warnings = input.slackText.unresolved
    .filter((mention) => mention.type === 'user')
    .map((mention) => `${mention.label} was sent as plain text because it did not match a Slack user.`);
  if (input.target.channelKind !== 'channel') return warnings;
  const mentionedUsers = mentionedUserLabels(input.slackText);
  if (!mentionedUsers.size) return warnings;

  let memberIds: Set<string>;
  try {
    memberIds = new Set(await new SlackWorkspaceDirectoryService({
      client: input.client,
      teamId: input.teamId,
    }).getConversationMemberIds(input.channelId));
  } catch {
    return warnings;
  }

  const missing = [...mentionedUsers.entries()]
    .filter(([userId]) => !memberIds.has(userId))
    .map(([, label]) => label);
  if (missing.length) {
    warnings.push(`${missing.join(', ')} may not be in ${input.target.channelDisplayName}.`);
  }
  return warnings;
}

function mentionedUserLabels(slackText: SlackTextForPostMessage): Map<string, string> {
  const labels = new Map<string, string>();
  for (const mention of slackText.resolved) {
    if (mention.type === 'user') labels.set(mention.id, mention.label);
  }
  for (const userId of extractSlackUserMentionIds(slackText.text)) {
    if (!labels.has(userId)) labels.set(userId, `<@${userId}>`);
  }
  return labels;
}
