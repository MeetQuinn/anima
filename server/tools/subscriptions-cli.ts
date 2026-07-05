import type { Command } from 'commander';
import { z } from 'zod';

import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import {
  muteSubscriptionForAgent,
} from '../inbox/slack-subscription.service.js';
import { runPlaces, type PlacesOptions } from './orientation-cli.js';
import type { OrientationDeps } from './orientation.js';
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

// Input:   anima subscription list
// Output:  compatibility alias for `anima places`; thread subscriptions remain
//          internal wake behavior and are intentionally not rendered.
// Failure: human-readable error to stderr; exit 1.

// Input:   anima subscription mute --channel <id> [--thread-ts <ts>]
// Input:   anima subscription mute --chat-id <oc_...>
// Output:  muted successfully. channel=<ref> [thread_ts=<ts>].
// Failure: human-readable error to stderr; exit 1.

export function registerSubscriptionCommands(program: Command): void {
  const subscription = program.command('subscription').description('Inspect and mute Slack or Feishu attention.');

  subscription
    .command('list')
    .description('Alias for anima places.')
    .option('--all', 'show all places instead of the 50 most recently delivered per section')
    .action(async (_, command) => {
      const opts = SubscriptionListSchema.parse(command.optsWithGlobals());
      await runSubscriptionList(opts);
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

export async function runSubscriptionList(opts: PlacesOptions, deps?: OrientationDeps): Promise<void> {
  await runPlaces(opts, deps);
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
