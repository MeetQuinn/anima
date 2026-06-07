import type { Command } from 'commander';
import { z } from 'zod';

import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import {
  attentionMapForSubscriptions,
  listSubscriptionsForAgent,
  muteSubscriptionForAgent,
  type SubscriptionRecord,
} from '../inbox/slack-subscription.service.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import { normalizeChatTargetOptions } from './chat-target-options.js';
import { resolveSlackChannelArgument } from './slack-channel-resolver.js';

const GlobalFlags = z.object({
  agent: z.string().optional(),
});

const SubscriptionMuteSchema = GlobalFlags.extend({
  chatId: z.string().optional(),
  channel: z.string().optional(),
  threadTs: z.string().min(1).optional(),
});

const SubscriptionListSchema = GlobalFlags.extend({
  all: z.boolean().default(false),
});

type SubscriptionMuteOptions = Omit<z.infer<typeof SubscriptionMuteSchema>, 'chatId'>;
type SubscriptionListOptions = z.infer<typeof SubscriptionListSchema>;

// Input:   anima subscription list
// Output:  attention map: member channels with following/muted status, active
//          followed threads, muted threads, and a quiet-thread tail count.
// Failure: human-readable error to stderr; exit 1.

// Input:   anima subscription mute --channel <id> [--thread-ts <ts>]
// Input:   anima subscription mute --chat-id <oc_...>
// Output:  muted successfully. channel=<ref> [thread_ts=<ts>].
// Failure: human-readable error to stderr; exit 1.

export function registerSubscriptionCommands(program: Command): void {
  const subscription = program.command('subscription').description('Inspect and mute Slack or Feishu attention.');

  subscription
    .command('list')
    .description('List where this agent is listening.')
    .option('--all', 'include quiet old followed threads')
    .action(async (_, command) => {
      const opts = SubscriptionListSchema.parse(command.optsWithGlobals());
      await subscriptionList(opts);
    });

  subscription
    .command('mute')
    .description('Mute a Slack channel/thread or Feishu chat.')
    .option('--channel <channel>', 'Slack channel ID/name, or Feishu chat_id (oc_...)')
    .option('--chat-id <chatId>', 'Feishu chat_id (oc_...); alias for --channel')
    .option('--thread-ts <ts>', 'mute one Slack thread in the channel')
    .action(async (_, command) => {
      const opts = SubscriptionMuteSchema.parse(command.optsWithGlobals());
      await subscriptionMute(normalizeChatTargetOptions(opts, 'subscription mute'));
    });
}

async function subscriptionList(opts: SubscriptionListOptions): Promise<void> {
  const agentId = resolveAgentIdFrom(opts.agent);
  if (!agentId) throw new Error('Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.');
  const agent = await defaultAgentRegistryService.serviceFor(agentId).getConfig();
  const [subscriptions, memberChannels] = await Promise.all([
    listSubscriptionsForAgent(agentId),
    memberChannelsForAgent(agent),
  ]);
  const map = attentionMapForSubscriptions({
    includeAll: opts.all,
    memberChannels,
    subscriptions,
  });

  if (
    map.channels.length === 0 &&
    map.activeThreads.length === 0 &&
    map.mutedThreads.length === 0 &&
    map.quietThreadCount === 0
  ) {
    console.log('No attention records.');
    return;
  }
  console.log('Channels:');
  if (map.channels.length === 0) {
    console.log('- none');
  } else {
    for (const channel of map.channels) {
      console.log(`- [${channel.status}] ${subscriptionChannelRef(channel)}`);
    }
  }
  console.log('Threads:');
  for (const thread of map.activeThreads) console.log(`- [following] ${threadLine(thread)}`);
  for (const thread of map.mutedThreads) console.log(`- [muted] ${threadLine(thread)}`);
  for (const thread of map.quietThreads) console.log(`- [quiet] ${threadLine(thread)}`);
  if (map.quietThreadCount > map.quietThreads.length) {
    console.log(`+ ${map.quietThreadCount - map.quietThreads.length} quiet threads still followed. Pass --all to show.`);
  }
  if (map.activeThreads.length === 0 && map.mutedThreads.length === 0 && map.quietThreads.length === 0) console.log('- none');
}

async function subscriptionMute(opts: SubscriptionMuteOptions): Promise<void> {
  const agentIdResolved = resolveAgentIdFrom(opts.agent);
  if (!agentIdResolved) throw new Error('Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.');
  if (!opts.channel) throw new Error('subscription mute requires --channel or --chat-id');
  if (isFeishuChatId(opts.channel)) {
    if (opts.threadTs) throw new Error('Feishu subscription mute currently supports chat-level mutes only.');
    await muteSubscriptionForAgent({
      agentId: agentIdResolved,
      channelId: opts.channel,
    });
    console.log(`muted successfully. feishu chat_id=${opts.channel}.`);
    return;
  }
  const agent = await defaultAgentRegistryService.serviceFor(agentIdResolved).getConfig();
  const client = agent.slack?.botToken
    ? await agentSlackServiceForAgent(agent.id).getWebClient()
    : undefined;
  const channel = await resolveSlackChannelArgument({
    channel: opts.channel,
    ...(client ? { client } : {}),
    ...(agent.slack.teamId ? { teamId: agent.slack.teamId } : {}),
  });

  await muteSubscriptionForAgent({
    agentId: agent.id,
    channelId: channel.id,
    ...(channel.name ? { channelName: channel.name } : {}),
    ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
  });

  const channelRef = channel.name ? `#${channel.name}` : channel.id;
  console.log(`muted successfully. channel=${channelRef}${opts.threadTs ? ` thread_ts=${opts.threadTs}` : ''}.`);
}

function isFeishuChatId(channel: string): boolean {
  return channel.startsWith('oc_');
}

function subscriptionChannelRef(channel: { channelId: string; channelName?: string }): string {
  if (isFeishuChatId(channel.channelId) && !channel.channelName) return `feishu chat_id=${channel.channelId}`;
  return `channel=${channel.channelName ? `#${channel.channelName}` : channel.channelId}`;
}

async function memberChannelsForAgent(agent: { id: string; slack?: { botToken?: string; teamId?: string } }): Promise<Array<{ id: string; name?: string }>> {
  if (!agent.slack?.botToken) return [];
  try {
    const client = await agentSlackServiceForAgent(agent.id).getWebClient();
    const channels = await new SlackWorkspaceDirectoryService({
      client,
      teamId: agent.slack.teamId,
    }).getMemberConversations();
    return channels.flatMap((channel) => {
      if (!channel.id) return [];
      const name = channel.name_normalized?.trim() || channel.name?.trim();
      return [{ id: channel.id, ...(name ? { name } : {}) }];
    });
  } catch {
    return [];
  }
}

function threadLine(sub: SubscriptionRecord): string {
  return `channel=${sub.channelId} thread_ts=${sub.kind === 'thread' ? sub.threadTs : ''}`;
}
