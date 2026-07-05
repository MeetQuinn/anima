import { errorMessage } from '../ids.js';
import { createFeishuMessageClient as createDefaultFeishuMessageClient } from '../feishu/client.js';
import { resolveSlackChannelArgument } from './slack-channel-resolver.js';
import {
  slackOutputTarget,
  slackTargetPayload,
  slackTargetSummary,
  type SlackTargetSummary,
} from './slack-target.js';
import {
  loadAgentFromOpts,
  resolveToolAgentId,
  resolveToolItemId,
  slackWebClientForOpts,
  withToolActivity,
} from './tool-context.js';
import { recordOutboundEngagement } from '../inbox/slack-subscription.service.js';
import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import type { FeishuInboxItem, SlackInboxItem } from '../../shared/inbox.js';

type FeishuMessageClientFactory = typeof createDefaultFeishuMessageClient;

interface MessageReactInput {
  agent?: string;
  channel?: string;
  item?: string;
  messageId?: string;
  messageTs?: string;
  name?: string;
  reactionId?: string;
  remove?: boolean;
}

interface MessageReactDeps {
  createFeishuMessageClient?: FeishuMessageClientFactory;
}

export async function runMessageReact(opts: MessageReactInput, deps: MessageReactDeps = {}): Promise<void> {
  const agentId = resolveToolAgentId(opts);
  const action: 'added' | 'removed' = opts.remove ? 'removed' : 'added';
  if (!agentId) throw new Error('message react requires current agent context for audit');
  const channelArg = opts.channel?.trim();
  if (!channelArg) throw new Error('message react requires --channel or --chat-id');
  const targetTs = opts.messageTs?.trim();
  const targetMessageId = opts.messageId?.trim() || targetTs;
  if (!targetMessageId) throw new Error('message react requires --message-ts or --message-id');
  if (isFeishuReactionTarget({ channel: channelArg, targetMessageId })) {
    await runFeishuMessageReact({
      action,
      agentId,
      createFeishuMessageClient: deps.createFeishuMessageClient ?? createDefaultFeishuMessageClient,
      opts,
      channel: channelArg,
      messageId: targetMessageId,
    });
    return;
  }

  if (!targetTs) throw new Error('message react requires --message-ts');
  const rawName = opts.name?.trim();
  if (!rawName) throw new Error('message react requires --name');
  const name = rawName.replace(/^:|:$/g, '');
  const { agent, client } = await slackWebClientForOpts(opts);
  const teamId = agent.slack.teamId || undefined;
  const channel = await resolveSlackChannelArgument({
    channel: channelArg,
    client,
    teamId,
  });

  const target = await slackTargetSummary({ channel, client, teamId });
  const basePayload = {
    ...slackTargetPayload(channel),
    ...target,
    action,
    name,
    targetTs,
    tool: 'anima.message.react',
  };

  await withToolActivity({
    audit: { agentId },
    basePayload,
    effectType: 'slack.reaction',
    op: async () => {
      const reaction = { channel: channel.id, name, timestamp: targetTs };
      const idempotentCode = opts.remove ? 'no_reaction' : 'already_reacted';
      let noop = false;
      try {
        if (opts.remove) {
          await client.reactions.remove(reaction);
        } else {
          await client.reactions.add(reaction);
        }
      } catch (error) {
        if (errorMessage(error).includes(idempotentCode)) {
          noop = true;
        } else {
          throw error;
        }
      }
      await recordOutboundEngagement({
        agentId,
        channelId: channel.id,
        threadTs: await currentSlackThreadTs(agentId, channel.id, opts),
      });
      console.log(slackReactionOutputLine({ action, name, messageTs: targetTs, noop, target }));
      return {
        result: undefined,
        completedPayload: {
          status: action,
          ts: targetTs,
          ...(noop ? { noop: true } : {}),
        },
      };
    },
  });
}

async function runFeishuMessageReact(input: {
  action: 'added' | 'removed';
  agentId: string;
  channel: string;
  createFeishuMessageClient: FeishuMessageClientFactory;
  messageId: string;
  opts: MessageReactInput;
}): Promise<void> {
  if (!input.channel.startsWith('oc_')) {
    throw new Error('Feishu message react requires --chat-id or --channel with an oc_ chat_id');
  }
  if (!input.messageId.startsWith('om_')) {
    throw new Error('Feishu message react requires --message-id or --message-ts with an om_ message id');
  }
  const rawName = input.opts.name?.trim();
  const name = rawName?.replace(/^:|:$/g, '');
  const reactionId = input.opts.reactionId?.trim();
  if (input.action === 'removed' && !reactionId) throw new Error('Feishu message react remove requires --reaction-id');
  if (!name) throw new Error('Feishu message react requires --name');

  const agent = await loadAgentFromOpts(input.opts);
  if (!agent.feishu.connected) throw new Error(`Agent ${input.agentId} has no Feishu connection configured`);
  const feishuItem = await currentFeishuItem(input.agentId, input.opts);
  const channelKind = feishuItem?.chatId === input.channel ? feishuItem.chatType : 'chat';
  const channelDisplayName = channelKind === 'p2p' ? 'Feishu DM' : `Feishu ${channelKind}`;
  const client = input.createFeishuMessageClient(agent.feishu);
  const basePayload = {
    action: input.action,
    channel: input.channel,
    channelDisplayName,
    channelKind,
    messageId: input.messageId,
    platform: 'feishu',
    targetTs: input.messageId,
    tool: 'anima.message.react',
    ...(name ? { name } : {}),
    ...(reactionId ? { reactionId } : {}),
  };

  await withToolActivity({
    audit: { agentId: input.agentId },
    basePayload,
    effectType: 'feishu.reaction',
    op: async () => {
      let completedReactionId = reactionId;
      if (input.action === 'removed') {
        if (!reactionId) throw new Error('Feishu message react remove requires --reaction-id');
        await client.removeReaction({ messageId: input.messageId, reactionId });
      } else {
        const response = await client.addReaction({ emojiType: name, messageId: input.messageId });
        completedReactionId = response.reactionId;
      }
      await recordOutboundEngagement({ agentId: input.agentId, channelId: input.channel });
      console.log(feishuReactionOutputLine({
        action: input.action,
        channel: input.channel,
        messageId: input.messageId,
        name,
        reactionId: completedReactionId,
      }));
      return {
        result: undefined,
        completedPayload: {
          status: input.action,
          ts: input.messageId,
          ...(name ? { name } : {}),
          ...(completedReactionId ? { reactionId: completedReactionId } : {}),
        },
      };
    },
  });
}

async function currentSlackThreadTs(
  agentId: string,
  channelId: string,
  opts: MessageReactInput,
): Promise<string | undefined> {
  const item = await currentSlackItem(agentId, opts);
  if (item?.channelId !== channelId) return undefined;
  return item.threadTs;
}

async function currentSlackItem(agentId: string, opts: MessageReactInput): Promise<SlackInboxItem | undefined> {
  const itemId = await resolveToolItemId(opts);
  if (!itemId) return undefined;
  const item = await wakeQueueServiceForAgent(agentId).find(itemId);
  return item?.kind === 'slack' ? item : undefined;
}

async function currentFeishuItem(agentId: string, opts: MessageReactInput): Promise<FeishuInboxItem | undefined> {
  const itemId = await resolveToolItemId(opts);
  if (!itemId) return undefined;
  const item = await wakeQueueServiceForAgent(agentId).find(itemId);
  return item?.kind === 'feishu' ? item : undefined;
}

function isFeishuReactionTarget(input: { channel: string; targetMessageId: string }): boolean {
  return input.channel.startsWith('oc_') || input.targetMessageId.startsWith('om_');
}

function feishuReactionOutputLine(input: {
  action: 'added' | 'removed';
  channel: string;
  messageId: string;
  name?: string;
  reactionId?: string;
}): string {
  const parts = [
    `feishu chat_id=${input.channel}`,
    `message_id=${input.messageId}`,
    ...(input.name ? [`reaction=${input.name}`] : []),
    ...(input.reactionId ? [`reaction_id=${input.reactionId}`] : []),
  ];
  return `reaction ${input.action} successfully. ${parts.join(', ')}.`;
}

function slackReactionOutputLine(input: {
  action: 'added' | 'removed';
  messageTs: string;
  name: string;
  noop?: boolean;
  target: SlackTargetSummary;
}): string {
  const parts = [slackOutputTarget(input.target), `message_ts=${input.messageTs}`, `reaction=:${input.name}:`];
  const lead = input.noop
    ? `reaction already ${input.action === 'added' ? 'present' : 'absent'} (noop).`
    : `reaction ${input.action} successfully.`;
  return `${lead} ${parts.join(', ')}.`;
}
