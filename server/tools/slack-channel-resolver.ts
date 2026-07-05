import type { WebClient } from '@slack/web-api';

import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';

export interface ResolvedSlackChannel {
  dmHandle?: string;
  dmUserId?: string;
  id: string;
  name?: string;
  teamId?: string;
}

const SLACK_CHANNEL_ID = /^[CDG][A-Za-z0-9_-]+$/;

export async function resolveSlackChannelArgument(input: {
  channel: string;
  client?: WebClient;
  teamId?: string;
}): Promise<ResolvedSlackChannel> {
  const channel = normalizedSlackChannelArgument(input.channel);
  if (SLACK_CHANNEL_ID.test(channel)) return { id: channel };
  if (channel.startsWith('@')) {
    return resolveSlackDmHandle({ client: input.client, handle: channel.slice(1), teamId: input.teamId });
  }
  return resolveSlackChannelName({
    client: input.client,
    name: channel.replace(/^#/, '').toLowerCase(),
    teamId: input.teamId,
  });
}

function normalizedSlackChannelArgument(value: string): string {
  const channel = value.trim();
  if (!channel) throw new Error('Slack channel is required');
  return channel;
}

async function resolveSlackDmHandle(input: {
  client?: WebClient;
  handle: string;
  teamId?: string;
}): Promise<ResolvedSlackChannel> {
  if (!input.client) {
    throw new Error(`Slack WebClient is required to resolve DM handle: @${input.handle}`);
  }
  const directory = new SlackWorkspaceDirectoryService({ client: input.client, teamId: input.teamId });
  const user = await directory.getUserByHandle(input.handle);
  if (!user?.id) throw new Error(`Slack user not found: @${input.handle}`);
  const dm = await directory.openDm(user.id);
  if (!dm.id) throw new Error(`Slack conversations.open did not return a channel id for @${input.handle}`);
  return { id: dm.id, dmHandle: input.handle, dmUserId: user.id };
}

async function resolveSlackChannelName(input: {
  client?: WebClient;
  name: string;
  teamId?: string;
}): Promise<ResolvedSlackChannel> {
  if (!input.client) {
    throw new Error(`Slack WebClient is required to resolve Slack channel name: #${input.name}. Pass a channel ID or configure slack.botToken.`);
  }
  const conversation = await new SlackWorkspaceDirectoryService({
    client: input.client,
    teamId: input.teamId,
  }).getConversationByName(input.name);
  if (!conversation.id) throw new Error(`Slack channel not found: #${input.name}`);

  const channelName = conversation.name?.trim();
  return { id: conversation.id, ...(channelName ? { name: channelName } : {}) };
}
