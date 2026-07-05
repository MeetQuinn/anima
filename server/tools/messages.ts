import type { WebClient } from '@slack/web-api';

import { createFeishuMessageClient as createDefaultFeishuMessageClient } from '../feishu/client.js';
import type { FeishuReceiveIdType } from '../feishu/client.js';
import { markdownToFeishuPost } from '../feishu/markdown-to-feishu-post.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { nowIso } from '../ids.js';
import {
  ensureThreadSubscriptionForSentMessage,
  recordOutboundEngagement,
} from '../inbox/slack-subscription.service.js';
import { resolveChatTarget } from './chat-target-resolver.js';
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
import { outcomeLine, type OutcomePart } from './outcome-line.js';
import {
  loadAgentFromOpts,
  currentFeishuItem,
  resolveToolAgentId,
  slackWebClientForOpts,
  withToolActivity,
  readStdin,
} from './tool-context.js';
import type { FeishuInboxItem, FeishuOnboardingInboxItem } from '../../shared/inbox.js';

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

interface FeishuSendTarget {
  displayName: string;
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  surfaceKind?: string;
}

interface MessageSendDeps {
  createFeishuMessageClient?: FeishuMessageClientFactory;
  writeOutput?: (line: string) => void;
}

export async function runMessageSend(opts: MessageSendInput, deps: MessageSendDeps = {}): Promise<void> {
  const text = opts.text ?? await readStdin();
  const agentId = resolveToolAgentId(opts);
  if (!agentId) throw new Error('message send requires current agent context for audit');
  const feishuItem = await currentFeishuItem(agentId, opts);
  const chatTarget = resolveChatTarget(opts.channel, feishuItem);
  if (chatTarget.platform === 'feishu') {
    const agent = await loadAgentFromOpts(opts);
    if (agent.feishu.connected) {
      await runFeishuMessageSend({
        agentId,
        createFeishuMessageClient: deps.createFeishuMessageClient ?? createDefaultFeishuMessageClient,
        item: feishuItem,
        opts,
        target: {
          displayName: chatTarget.displayName ?? 'Feishu chat',
          receiveId: chatTarget.receiveId,
          receiveIdType: chatTarget.receiveIdType,
          ...(chatTarget.surfaceKind ? { surfaceKind: chatTarget.surfaceKind } : {}),
        },
        text,
        threadMessageId: opts.threadTs,
        writeOutput: deps.writeOutput,
      });
      return;
    }
  }
  if (!opts.channel) throw new Error('message send requires --channel or --chat-id');
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
      const slackText = await slackTextForPostMessage({ channelId: channel.id, client, teamId, text });
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
        await recordOutboundEngagement({ agentId, channelId });
      }
      const threadSubscription = channel.dmUserId || !response.ts
        ? undefined
        : await ensureThreadSubscriptionForSentMessage({
            agentId,
            channelId,
            messageTs: response.ts,
            ...(threadTs ? { threadTs } : {}),
          });
      const writeOutput = deps.writeOutput ?? console.log;
      writeOutput(slackOutputLine({
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
  createFeishuMessageClient: FeishuMessageClientFactory;
  item?: FeishuInboxItem | FeishuOnboardingInboxItem;
  opts: MessageSendInput;
  target: FeishuSendTarget;
  text: string;
  threadMessageId?: string;
  writeOutput?: (line: string) => void;
}): Promise<void> {
  const agent = await loadAgentFromOpts(input.opts);
  if (!agent.feishu.connected) throw new Error(`Agent ${input.agentId} has no Feishu connection configured`);
  const client = input.createFeishuMessageClient(agent.feishu);
  const basePayload = {
    ...(input.target.receiveIdType === 'chat_id' ? { channel: input.target.receiveId } : {}),
    channelDisplayName: input.target.displayName,
    ...(input.target.surfaceKind ? { channelKind: input.target.surfaceKind } : {}),
    ...(input.item?.kind === 'feishu' && input.item.messageId ? { sourceMessageId: input.item.messageId } : {}),
    platform: 'feishu',
    receiveId: input.target.receiveId,
    receiveIdType: input.target.receiveIdType,
    ...(input.threadMessageId ? { targetTs: input.threadMessageId, threadTs: input.threadMessageId } : {}),
    tool: 'anima.message.send',
  };

  await withToolActivity({
    audit: { agentId: input.agentId },
    basePayload,
    effectType: 'feishu.message.send',
    op: async () => {
      const postContent = markdownToFeishuPost(input.text);
      const response = input.threadMessageId
        ? await client.replyPost({
            messageId: input.threadMessageId,
            replyInThread: true,
            content: postContent,
          })
        : await client.sendPost({
            receiveId: input.target.receiveId,
            receiveIdType: input.target.receiveIdType,
            content: postContent,
          });
      await recordFeishuOwnerGreetingDelivery({
        agentId: input.agentId,
        item: input.item,
        response,
      });
      const writeOutput = input.writeOutput ?? console.log;
      writeOutput(feishuOutputLine({
        messageId: response.messageId,
        receiveId: input.target.receiveId,
        receiveIdType: input.target.receiveIdType,
        responseChatId: response.chatId,
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

async function recordFeishuOwnerGreetingDelivery(input: {
  agentId: string;
  item?: FeishuInboxItem | FeishuOnboardingInboxItem;
  response: {
    chatId?: string;
    messageId?: string;
  };
}): Promise<void> {
  if (input.item?.kind !== 'feishu_onboarding') return;
  if (!input.response.chatId && !input.response.messageId) return;

  const service = defaultAgentRegistryService.serviceFor(input.agentId);
  const current = await service.getConfig();
  if (current.feishu.ownerOpenId !== input.item.owner.openId) return;
  await service.saveConfig({
    ...current,
    feishu: {
      ...current.feishu,
      ...(input.response.chatId ? { ownerGreetingChatId: input.response.chatId } : {}),
      ownerGreetingDeliveredAt: nowIso(),
      ...(input.response.messageId ? { ownerGreetingMessageId: input.response.messageId } : {}),
    },
  });
}

export async function runMessageUpdate(
  opts: MessageUpdateInput,
  deps: MessageSendDeps = {},
): Promise<void> {
  const text = opts.text ?? await readStdin();
  const agentId = resolveToolAgentId(opts);
  if (!agentId) throw new Error('message update requires current agent context for audit');
  if (!opts.channel) throw new Error('message update requires --channel or --chat-id');
  const targetTs = opts.messageTs;
  if (!targetTs) throw new Error('message update requires --message-ts');
  const chatTarget = resolveChatTarget(opts.channel);
  if (chatTarget.platform === 'feishu' && chatTarget.receiveIdType === 'chat_id') {
    await runFeishuMessageUpdate({
      agentId,
      channel: chatTarget.receiveId,
      createFeishuMessageClient: deps.createFeishuMessageClient ?? createDefaultFeishuMessageClient,
      opts,
      targetMessageId: targetTs,
      text,
      writeOutput: deps.writeOutput,
    });
    return;
  }
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
      const slackText = await slackTextForPostMessage({ channelId: channel.id, client, teamId, text });
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
      const writeOutput = deps.writeOutput ?? console.log;
      writeOutput(slackOutputLine({
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

async function runFeishuMessageUpdate(input: {
  agentId: string;
  channel: string;
  createFeishuMessageClient: FeishuMessageClientFactory;
  opts: MessageUpdateInput;
  targetMessageId: string;
  text: string;
  writeOutput?: (line: string) => void;
}): Promise<void> {
  if (!input.targetMessageId.startsWith('om_')) {
    throw new Error('Feishu message update requires --message-ts to be a Feishu message_id (om_...)');
  }
  const agent = await loadAgentFromOpts(input.opts);
  if (!agent.feishu.connected) throw new Error(`Agent ${input.agentId} has no Feishu connection configured`);
  const client = input.createFeishuMessageClient(agent.feishu);
  if (!client.updatePost) {
    throw new Error('Feishu message client does not support message.update');
  }
  const updatePost = client.updatePost.bind(client);
  const basePayload = {
    channel: input.channel,
    channelDisplayName: 'Feishu chat',
    channelKind: 'chat',
    messageId: input.targetMessageId,
    platform: 'feishu',
    targetTs: input.targetMessageId,
    tool: 'anima.message.update',
  };

  await withToolActivity({
    audit: { agentId: input.agentId },
    basePayload,
    effectType: 'feishu.message.update',
    op: async () => {
      const response = await updatePost({
        content: markdownToFeishuPost(input.text),
        messageId: input.targetMessageId,
      });
      const messageId = response.messageId ?? input.targetMessageId;
      const writeOutput = input.writeOutput ?? console.log;
      writeOutput(feishuUpdateOutputLine({
        channel: input.channel,
        messageId,
      }));
      return {
        result: undefined,
        completedPayload: {
          ...(response.chatId ? { channel: response.chatId } : {}),
          ...(response.threadId ? { threadTs: response.threadId } : {}),
          messageId,
          status: 'updated',
          text: input.text,
          ts: messageId,
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
  const parts: OutcomePart[] = [slackOutputTarget(input.target)];
  if (input.thread) parts.push(['thread_ts', input.thread.threadTs]);
  if (input.messageTs) parts.push(['message_ts', input.messageTs]);
  return outcomeLine(input.status, parts, input.warnings?.length ? { note: input.warnings.join(' ') } : undefined);
}

function feishuOutputLine(input: {
  messageId?: string;
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  responseChatId?: string;
  threadId?: string;
}): string {
  const parts: OutcomePart[] = input.receiveIdType === 'chat_id'
    ? [['feishu chat_id', input.receiveId]]
    : [['feishu receive_id_type', 'open_id'], ['receive_id', input.receiveId]];
  if (input.responseChatId && input.responseChatId !== input.receiveId) parts.push(['chat_id', input.responseChatId]);
  if (input.threadId) parts.push(['thread_id', input.threadId]);
  if (input.messageId) parts.push(['message_id', input.messageId]);
  return outcomeLine('sent', parts);
}

function feishuUpdateOutputLine(input: {
  channel: string;
  messageId: string;
}): string {
  return outcomeLine('updated', [['feishu chat_id', input.channel], ['message_id', input.messageId]]);
}
