import type { WebClient } from '@slack/web-api';

import {
  type SlackConversationInfo,
  SlackWorkspaceDirectoryService,
} from '../slack/workspace-directory.service.js';
import type { ResolvedSlackChannel } from './slack-channel-resolver.js';

export type SlackChannelKind = 'channel' | 'dm' | 'mpim';

export interface SlackTargetSummary {
  channelDisplayName: string;
  channelKind: SlackChannelKind;
  dmHandle?: string;
  dmUserId?: string;
}

export interface SlackThreadSummary {
  threadDisplayName: string;
  threadTs: string;
}

export function slackTargetPayload(channel: ResolvedSlackChannel): Record<string, unknown> {
  return {
    channel: channel.id,
    ...(channel.name && { channelName: channel.name }),
    ...(channel.dmHandle && { dmHandle: channel.dmHandle }),
    ...(channel.dmUserId && { dmUserId: channel.dmUserId }),
  };
}

export async function slackTargetSummary(input: {
  channel: ResolvedSlackChannel;
  client: WebClient;
  teamId?: string;
}): Promise<SlackTargetSummary> {
  const directory = new SlackWorkspaceDirectoryService({ client: input.client, teamId: input.teamId });
  if (input.channel.dmUserId) {
    const user = input.channel.dmHandle
      ? undefined
      : await directory.getUser(input.channel.dmUserId).catch(() => undefined);
    const dmHandle = input.channel.dmHandle ?? user?.name?.trim();
    const handle = dmHandle ? `@${dmHandle}` : input.channel.dmUserId;
    return {
      channelDisplayName: `DM with ${handle}`,
      channelKind: 'dm',
      ...(dmHandle ? { dmHandle } : {}),
      dmUserId: input.channel.dmUserId,
    };
  }
  const info = await slackConversationInfoForTarget(input.channel, directory);
  const kind = slackChannelKind(info, input.channel.id);
  if (kind === 'dm') {
    const userId = slackConversationUserId(info);
    const user = userId ? await directory.getUser(userId).catch(() => undefined) : undefined;
    const handle = user?.name?.trim();
    return {
      channelDisplayName: handle ? `DM with @${handle}` : slackChannelDisplayName(input.channel, info),
      channelKind: 'dm',
      ...(handle ? { dmHandle: handle } : {}),
      ...(userId ? { dmUserId: userId } : {}),
    };
  }
  return {
    channelDisplayName: slackChannelDisplayName(input.channel, info),
    channelKind: kind,
  };
}

export function slackThreadSummary(target: SlackTargetSummary, threadTs: string): SlackThreadSummary {
  return {
    threadDisplayName: `Thread ${threadTs} in ${target.channelDisplayName}`,
    threadTs,
  };
}

export function slackOutputTarget(target: SlackTargetSummary): string {
  if (target.channelKind === 'dm') return `dm=${quoteIfNeeded(target.channelDisplayName.replace(/^DM with /, ''))}`;
  return `channel=${target.channelDisplayName}`;
}

async function slackConversationInfoForTarget(
  channel: ResolvedSlackChannel,
  directory: SlackWorkspaceDirectoryService,
): Promise<SlackConversationInfo | undefined> {
  if (channel.name) return { id: channel.id, name: channel.name };
  try {
    return await directory.getConversation(channel.id);
  } catch {
    return undefined;
  }
}

function slackConversationUserId(info: SlackConversationInfo | undefined): string | undefined {
  const userId = (info as Record<string, unknown> | undefined)?.['user'];
  return typeof userId === 'string' ? userId : undefined;
}

function slackChannelKind(info: SlackConversationInfo | undefined, channelId: string): SlackChannelKind {
  if (info) {
    if (info.is_im) return 'dm';
    if (info.is_mpim) return 'mpim';
    return 'channel';
  }
  if (channelId.startsWith('D')) return 'dm';
  if (channelId.startsWith('G')) return 'mpim';
  return 'channel';
}

function slackChannelDisplayName(channel: ResolvedSlackChannel, info: SlackConversationInfo | undefined): string {
  const name = channel.name?.trim() || info?.name_normalized?.trim() || info?.name?.trim();
  if (name) return `#${name}`;
  if (info?.is_im || channel.id.startsWith('D')) {
    const handle = channel.dmHandle ? `@${channel.dmHandle}` : channel.dmUserId;
    return handle ? `DM with ${handle}` : channel.id;
  }
  return channel.id;
}

export function quoteIfNeeded(value: string): string {
  return /^[^\s"]+$/.test(value) ? value : JSON.stringify(value);
}
