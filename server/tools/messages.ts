import type { WebClient } from '@slack/web-api';

import { createFeishuMessageClient as createDefaultFeishuMessageClient } from '../feishu/client.js';
import type { FeishuReceiveIdType } from '../feishu/client.js';
import { markdownToFeishuPost } from '../feishu/markdown-to-feishu-post.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { nowIso } from '../ids.js';
import { assertSlackContactAllowed } from '../messages/contact-policy.service.js';
import { resolveChatTarget } from './chat-target-resolver.js';
import { resolveSlackChannelArgument } from './slack-channel-resolver.js';
import { SLACK_NO_UNFURL, slackMessageContentForText } from './slack-message-format.js';
import {
  mentionWarningsForTarget,
  slackTextForPostMessage,
} from './slack-message-mentions.js';
import { slackTargetPayload, slackTargetSummary } from './slack-target.js';
import { outcomeLine, type OutcomePart } from './outcome-line.js';
import { sendLocalFiles, validateLocalFiles } from './file-send.js';
import { runSlackSend, slackMessageRedirectLink, slackOutputLine, slackTextPayload } from './slack-send.js';
import {
  loadAgentFromOpts,
  currentFeishuItem,
  feishuMessageClientForOpts,
  resolveToolAgentId,
  slackWebClientForOpts,
  withToolActivity,
  readOptionalStdin,
  readStdin,
} from './tool-context.js';
import type { FeishuInboxItem, FeishuOnboardingInboxItem } from '../../shared/inbox.js';

interface MessageGlobalInput {
  agent?: string;
  item?: string;
}

interface MessageSendInput extends MessageGlobalInput {
  channel?: string;
  /** Local paths to post as one file message; the body becomes the caption. */
  files?: string[];
  text?: string;
  threadTs?: string;
}

interface MessageUpdateInput extends MessageGlobalInput {
  channel?: string;
  messageTs?: string;
  text?: string;
}

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
  const agentId = resolveToolAgentId(opts);
  if (!agentId) throw new Error('message send requires current agent context for audit');
  if (opts.files?.length) {
    // Files post as one message; the body, if any, is their caption. Paths are
    // checked before stdin is read or any platform call is made.
    if (!opts.channel) throw new Error('message send requires --channel or --chat-id');
    const files = await validateLocalFiles(opts.files);
    const caption = opts.text ?? await readOptionalStdin() ?? '';
    await sendLocalFiles({ agentId, caption, deps, files, opts: { ...opts, channel: opts.channel } });
    return;
  }
  const text = opts.text ?? await readStdin();
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
  await runSlackSend({
    agentId,
    opts: { ...opts, channel: opts.channel },
    text,
    ...(deps.writeOutput ? { writeOutput: deps.writeOutput } : {}),
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
  const { client } = await feishuMessageClientForOpts(input.opts, input.createFeishuMessageClient);
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

  const ownerOpenId = input.item.owner.openId;
  const { chatId, messageId } = input.response;
  await defaultAgentRegistryService.serviceFor(input.agentId).updateConfig((current) => {
    if (current.feishu.ownerOpenId !== ownerOpenId) return current;
    return {
      ...current,
      feishu: {
        ...current.feishu,
        ...(chatId ? { ownerGreetingChatId: chatId } : {}),
        ownerGreetingDeliveredAt: nowIso(),
        ...(messageId ? { ownerGreetingMessageId: messageId } : {}),
      },
    };
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

  const slackText = await slackTextForPostMessage({ channelId: channel.id, client, teamId, text });
  const content = slackMessageContentForText(slackText.text);
  const warnings = await mentionWarningsForTarget({ channelId: channel.id, client, slackText, target, teamId });
  const payload = {
    ...(content.blocks ? { blocks: content.blocks } : {}),
    ...SLACK_NO_UNFURL,
    channel: channel.id,
    text: content.text,
    ts: targetTs,
  } as SlackUpdateMessagePayload;
  await assertSlackContactAllowed({
    agentId, teamId, channelId: channel.id, dmUserId: target.dmUserId,
    client, content, tool: 'anima.message.update',
  });

  await withToolActivity({
    audit: { agentId },
    basePayload,
    effectType: 'slack.message.update',
    op: async () => {
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
  const { client } = await feishuMessageClientForOpts(input.opts, input.createFeishuMessageClient);
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
