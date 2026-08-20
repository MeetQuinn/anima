import type { Command } from 'commander';
import { z } from 'zod';

import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import {
  muteSubscriptionForAgent,
  unmuteSubscriptionForAgent,
} from '../inbox/subscription.service.js';
import { runPlaces, type PlacesOptions } from './orientation-cli.js';
import type { OrientationDeps } from './orientation.js';
import { normalizeChatTargetOptions } from './chat-target-options.js';
import { resolveChatTarget } from './chat-target-resolver.js';
import { resolveSlackChannelArgument } from './slack-channel-resolver.js';
import { outcomeLine, type OutcomePart } from './outcome-line.js';

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
// Output:  muted successfully. channel=<ref>[, thread_ts=<ts>].
// Failure: human-readable error to stderr; exit 1.

// Input:   anima subscription unmute --channel <id> [--thread-ts <ts>]
// Input:   anima subscription unmute --chat-id <oc_...>
// Output:  unmuted successfully. channel=<ref>[, thread_ts=<ts>].
// Failure: human-readable error to stderr; exit 1 (including no subscription).

export function registerSubscriptionCommands(program: Command): void {
  const subscription = program
    .command('subscription')
    .description('Inspect, mute, or unmute Slack or Feishu attention.');

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

  subscription
    .command('unmute')
    .description('Unmute a Slack channel/thread or Feishu chat.')
    .option('--channel <channel>', 'Slack channel ID/name, or Feishu chat_id (oc_...)')
    .option('--chat-id <chatId>', 'Feishu chat_id (oc_...); alias for --channel')
    .option('--thread-ts <ts>', 'unmute one Slack thread in the channel')
    .action(async (_, command) => {
      const opts = SubscriptionMuteSchema.parse(command.optsWithGlobals());
      await subscriptionUnmute(normalizeChatTargetOptions(opts, 'subscription unmute'));
    });
}

export async function runSubscriptionList(opts: PlacesOptions, deps?: OrientationDeps): Promise<void> {
  await runPlaces(opts, deps);
}

async function subscriptionMute(opts: SubscriptionMuteOptions): Promise<void> {
  const resolved = await resolveSubscriptionTarget(opts, 'subscription mute');
  await muteSubscriptionForAgent(resolved.muteInput);
  console.log(outcomeLine('muted', resolved.parts));
}

async function subscriptionUnmute(opts: SubscriptionMuteOptions): Promise<void> {
  const resolved = await resolveSubscriptionTarget(opts, 'subscription unmute');
  await unmuteSubscriptionForAgent(resolved.muteInput);
  console.log(outcomeLine('unmuted', resolved.parts));
}

async function resolveSubscriptionTarget(
  opts: SubscriptionMuteOptions,
  label: string,
): Promise<{
  muteInput: {
    agentId: string;
    channelId: string;
    channelName?: string;
    platform: 'slack' | 'feishu';
    threadTs?: string;
  };
  parts: OutcomePart[];
}> {
  const agentIdResolved = resolveAgentIdFrom(opts.agent);
  if (!agentIdResolved) throw new Error('Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.');
  if (!opts.channel) throw new Error(`${label} requires --channel or --chat-id`);
  const target = resolveChatTarget(opts.channel);
  if (target.platform === 'feishu' && target.receiveIdType === 'chat_id') {
    if (opts.threadTs) throw new Error(`Feishu ${label} currently supports chat-level mutes only.`);
    return {
      muteInput: {
        agentId: agentIdResolved,
        channelId: target.receiveId,
        platform: 'feishu',
      },
      parts: [['feishu chat_id', target.receiveId]],
    };
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
  const channelRef = channel.name ? `#${channel.name}` : channel.id;
  const parts: OutcomePart[] = [['channel', channelRef]];
  if (opts.threadTs) parts.push(['thread_ts', opts.threadTs]);
  return {
    muteInput: {
      agentId: agent.id,
      channelId: channel.id,
      ...(channel.name ? { channelName: channel.name } : {}),
      platform: 'slack',
      ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
    },
    parts,
  };
}
