import type { WebClient } from '@slack/web-api';

import { createFeishuMessageClient as createDefaultFeishuMessageClient } from '../feishu/client.js';
import {
  ensureThreadSubscriptionForSentMessage,
  recordChannelPost,
} from '../inbox/slack-subscription.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { resolveSlackChannelArgument } from './slack-channel-resolver.js';
import { slackMessageContentForText } from './slack-message-format.js';
import {
  mentionWarningsForTarget,
  slackTextForPostMessage,
  type SlackTextForPostMessage,
} from './slack-message-mentions.js';
import {
  slackOutputTarget,
  slackTargetPayload,
  slackTargetSummary,
  slackThreadSummary,
  type SlackTargetSummary,
  type SlackThreadSummary,
} from './slack-target.js';
import {
  loadAgentFromOpts,
  resolveToolAgentId,
  resolveToolItemId,
  slackWebClientForOpts,
  withToolActivity,
  readStdin,
} from './tool-context.js';
import type { FeishuInboxItem } from '../../shared/inbox.js';

interface MessageGlobalInput {
  agent?: string;
  item?: string;
}

interface MessageSendInput extends MessageGlobalInput {
  channel?: string;
  text?: string;
  threadTs?: string;
}

interface MessageUpdateInput extends MessageGlobalInput {
  channel?: string;
  messageTs?: string;
  text?: string;
}

type SlackPostMessagePayload = Parameters<WebClient['chat']['postMessage']>[0];
type SlackUpdateMessagePayload = Parameters<WebClient['chat']['update']>[0];
type FeishuMessageClientFactory = typeof createDefaultFeishuMessageClient;

interface MessageSendDeps {
  createFeishuMessageClient?: FeishuMessageClientFactory;
}

export async function runMessageSend(opts: MessageSendInput, deps: MessageSendDeps = {}): Promise<void> {
  const text = opts.text ?? await readStdin();
  const agentId = resolveToolAgentId(opts);
  if (!agentId) throw new Error('message send requires current agent context for audit');
  const feishuItem = await currentFeishuItem(agentId, opts);
  const feishuChatId = feishuChatIdFromChannelArg(opts.channel);
  if (feishuChatId) {
    const agent = await loadAgentFromOpts(opts);
    if (agent.feishu.connected) {
      await runFeishuMessageSend({
        agentId,
        chatId: feishuChatId,
        chatDisplayName: feishuItem ? feishuChatDisplayName(feishuItem) : 'Feishu chat',
        chatKind: feishuItem?.chatType,
        createFeishuMessageClient: deps.createFeishuMessageClient ?? createDefaultFeishuMessageClient,
        item: feishuItem,
        opts,
        text,
        threadMessageId: opts.threadTs,
      });
      return;
    }
  }
  if (!opts.channel) throw new Error('message send requires --channel');
  const { agent, client } = await slackWebClientForOpts(opts);
  const teamId = agent.slack.teamId || undefined;
  const channel = await resolveSlackChannelArgument({
    channel: opts.channel,
    client,
    teamId,
  });
  const threadTs = opts.threadTs;
  const target = await slackTargetSummary({ channel, client, teamId });
  const thread = threadTs ? slackThreadSummary(target, threadTs) : undefined;
  const basePayload = {
    ...slackTargetPayload(channel),
    ...target,
    ...(thread ? thread : {}),
    ...(threadTs ? { threadTs } : {}),
    tool: 'anima.message.send',
  };

  await withToolActivity({
    audit: { agentId },
    basePayload,
    effectType: 'slack.message.send',
    op: async () => {
      const slackText = await slackTextForPostMessage({ client, teamId, text });
      const content = slackMessageContentForText(slackText.text);
      const warnings = await mentionWarningsForTarget({
        channelId: channel.id,
        client,
        slackText,
        target,
        teamId,
      });
      const payload = {
        ...(content.blocks ? { blocks: content.blocks } : {}),
        channel: channel.id,
        text: content.text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      } as SlackPostMessagePayload;
      const response = await client.chat.postMessage(payload);
      const channelId = response.channel ?? channel.id;
      const permalink = slackMessageRedirectLink({ channelId, messageTs: response.ts });
      if (!channel.dmUserId && !threadTs) {
        await recordChannelPost({ agentId, channelId });
      }
      const threadSubscription = channel.dmUserId || !response.ts
        ? undefined
        : await ensureThreadSubscriptionForSentMessage({
            agentId,
            channelId,
            messageTs: response.ts,
            ...(threadTs ? { threadTs } : {}),
          });
      console.log(slackOutputLine({
        messageTs: response.ts,
        status: 'sent',
        target,
        ...(thread ? { thread } : {}),
        warnings,
      }));
      return {
        result: undefined,
        completedPayload: {
          payload,
          ...slackTextPayload(slackText, text),
          messageFormat: content.format,
          ...(content.blockCount ? { blockCount: content.blockCount } : {}),
          ...(permalink ? { permalink } : {}),
          ...(warnings.length ? { warnings } : {}),
          ...(threadSubscription ? { threadSubscription: subscriptionPayload(threadSubscription) } : {}),
          status: 'sent',
          text,
          ...(response.ts ? { ts: response.ts } : {}),
        },
      };
    },
  });
}

async function runFeishuMessageSend(input: {
  agentId: string;
  chatId: string;
  chatDisplayName: string;
  chatKind?: string;
  createFeishuMessageClient: FeishuMessageClientFactory;
  item?: FeishuInboxItem;
  opts: MessageSendInput;
  text: string;
  threadMessageId?: string;
}): Promise<void> {
  const agent = await loadAgentFromOpts(input.opts);
  if (!agent.feishu.connected) throw new Error(`Agent ${input.agentId} has no Feishu connection configured`);
  const client = input.createFeishuMessageClient(agent.feishu);
  const basePayload = {
    channel: input.chatId,
    channelDisplayName: input.chatDisplayName,
    ...(input.chatKind ? { channelKind: input.chatKind } : {}),
    ...(input.item?.messageId ? { sourceMessageId: input.item.messageId } : {}),
    platform: 'feishu',
    ...(input.threadMessageId ? { targetTs: input.threadMessageId, threadTs: input.threadMessageId } : {}),
    tool: 'anima.message.send',
  };

  await withToolActivity({
    audit: { agentId: input.agentId },
    basePayload,
    effectType: 'feishu.message.send',
    op: async () => {
      const response = input.threadMessageId
        ? await client.replyText({
            messageId: input.threadMessageId,
            replyInThread: true,
            text: input.text,
          })
        : await client.sendText({
            chatId: input.chatId,
            text: input.text,
          });
      console.log(feishuOutputLine({
        chatId: input.chatId,
        messageId: response.messageId,
        threadId: response.threadId ?? input.threadMessageId,
      }));
      return {
        result: undefined,
        completedPayload: {
          ...(response.chatId ? { channel: response.chatId } : {}),
          ...(response.messageId ? { messageId: response.messageId, ts: response.messageId } : {}),
          ...(response.threadId ? { threadTs: response.threadId } : {}),
          status: 'sent',
          text: input.text,
        },
      };
    },
  });
}

async function currentFeishuItem(
  agentId: string,
  opts: MessageGlobalInput,
): Promise<FeishuInboxItem | undefined> {
  const itemId = await resolveToolItemId(opts);
  if (!itemId) return undefined;
  const item = await new WakeQueueService(agentId).find(itemId);
  return item?.kind === 'feishu' ? item : undefined;
}

function feishuChatIdFromChannelArg(channel?: string): string | undefined {
  return channel?.startsWith('oc_') ? channel : undefined;
}

export async function runMessageUpdate(opts: MessageUpdateInput): Promise<void> {
  const text = await readStdin();
  const agentId = resolveToolAgentId(opts);
  if (!agentId) throw new Error('message update requires current agent context for audit');
  if (!opts.channel) throw new Error('message update requires --channel');
  const targetTs = opts.messageTs;
  if (!targetTs) throw new Error('message update requires --message-ts');
  const { agent, client } = await slackWebClientForOpts(opts);
  const teamId = agent.slack.teamId || undefined;
  const channel = await resolveSlackChannelArgument({
    channel: opts.channel,
    client,
    teamId,
  });

  const target = await slackTargetSummary({ channel, client, teamId });
  const basePayload = {
    ...slackTargetPayload(channel),
    ...target,
    targetTs,
    tool: 'anima.message.update',
  };

  await withToolActivity({
    audit: { agentId },
    basePayload,
    effectType: 'slack.message.update',
    op: async () => {
      const slackText = await slackTextForPostMessage({ client, teamId, text });
      const content = slackMessageContentForText(slackText.text);
      const warnings = await mentionWarningsForTarget({
        channelId: channel.id,
        client,
        slackText,
        target,
        teamId,
      });
      const payload = {
        ...(content.blocks ? { blocks: content.blocks } : {}),
        channel: channel.id,
        text: content.text,
        ts: targetTs,
      } as SlackUpdateMessagePayload;
      const response = await client.chat.update(payload);
      const responseTs = response.ts ?? targetTs;
      const permalink = slackMessageRedirectLink({ channelId: channel.id, messageTs: responseTs });
      console.log(slackOutputLine({
        messageTs: responseTs,
        status: 'updated',
        target,
        warnings,
      }));
      return {
        result: undefined,
        completedPayload: {
          payload,
          ...slackTextPayload(slackText, text),
          messageFormat: content.format,
          ...(content.blockCount ? { blockCount: content.blockCount } : {}),
          ...(permalink ? { permalink } : {}),
          ...(warnings.length ? { warnings } : {}),
          status: 'updated',
          text,
          ts: responseTs,
        },
      };
    },
  });
}

function subscriptionPayload(subscription: { kind: string; mutedAt?: string; subscriptionId: string; threadTs?: string }): Record<string, unknown> {
  return {
    subscriptionId: subscription.subscriptionId,
    kind: subscription.kind,
    ...(subscription.mutedAt ? { mutedAt: subscription.mutedAt } : {}),
    ...(subscription.threadTs ? { threadTs: subscription.threadTs } : {}),
  };
}

function slackTextPayload(slackText: SlackTextForPostMessage, originalText: string): Record<string, unknown> {
  return {
    ...(slackText.resolved.length > 0 ? { resolvedMentions: slackText.resolved } : {}),
    ...(slackText.text !== originalText ? { slackText: slackText.text } : {}),
    ...(slackText.unresolved.length > 0 ? { unresolvedMentions: slackText.unresolved } : {}),
  };
}

function slackMessageRedirectLink(input: {
  channelId: string;
  messageTs?: string;
}): string | undefined {
  if (!input.messageTs) return undefined;
  return `https://slack.com/app_redirect?channel=${encodeURIComponent(input.channelId)}&message_ts=${encodeURIComponent(input.messageTs)}`;
}

function slackOutputLine(input: {
  messageTs?: string;
  status: 'sent' | 'updated';
  target: SlackTargetSummary;
  thread?: SlackThreadSummary;
  warnings?: string[];
}): string {
  const parts = [slackOutputTarget(input.target)];
  if (input.thread) parts.push(`thread_ts=${input.thread.threadTs}`);
  if (input.messageTs) parts.push(`message_ts=${input.messageTs}`);
  const warning = input.warnings?.length ? ` Note: ${input.warnings.join(' ')}` : '';
  return `${input.status} successfully. ${parts.join(', ')}.${warning}`;
}

function feishuOutputLine(input: {
  chatId: string;
  messageId?: string;
  threadId?: string;
}): string {
  const parts = [`feishu chat_id=${input.chatId}`];
  if (input.threadId) parts.push(`thread_id=${input.threadId}`);
  if (input.messageId) parts.push(`message_id=${input.messageId}`);
  return `sent successfully. ${parts.join(', ')}.`;
}

function feishuChatDisplayName(item: FeishuInboxItem): string {
  return item.chatType === 'p2p' ? 'Feishu DM' : `Feishu ${item.chatType}`;
}
