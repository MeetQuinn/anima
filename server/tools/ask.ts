import type { Command } from 'commander';
import type { WebClient } from '@slack/web-api';
import { z } from 'zod';

import type { InboxItem } from '../../shared/inbox.js';
import {
  INTERACTIVE_ASK_ACTION_ID,
  interactiveAskServiceForAgent,
  slackAnswerUser,
} from '../asks/interactive-ask.service.js';
import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { makeId, nowIso } from '../ids.js';
import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import {
  ensureThreadSubscriptionForSentMessage,
  recordOutboundEngagement,
} from '../inbox/slack-subscription.service.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import type { InteractiveAskOption, InteractiveAskRecord } from '../storage/schema/interactive-ask.store.js';
import { resolveSlackChannelArgument, type ResolvedSlackChannel } from './slack-channel-resolver.js';
import {
  slackOutputTarget,
  slackTargetPayload,
  slackTargetSummary,
  slackThreadSummary,
  type SlackTargetSummary,
  type SlackThreadSummary,
} from './slack-target.js';
import {
  resolveToolAgentId,
  resolveToolItemId,
  withToolActivity,
} from './tool-context.js';

type SlackPostMessagePayload = Parameters<WebClient['chat']['postMessage']>[0];
type AskAllowedUser = {
  displayName?: string;
  handle?: string;
  slackUserId: string;
};

interface AskTarget {
  channel: ResolvedSlackChannel;
  defaultUser?: AskAllowedUser;
  threadTs?: string;
}

const AskCommandSchema = z.object({
  channel: z.string().optional(),
  option: z.array(z.string()).default([]),
  question: z.string().trim().min(1),
  replyHint: z.boolean().default(true),
  threadTs: z.string().optional(),
  to: z.string().optional(),
}).strict();

export function registerAskCommands(program: Command): void {
  program
    .command('ask')
    .description('Ask a bounded Slack question with one-click answer buttons.')
    .requiredOption('--question <text>', 'question text')
    .option('--option <label>', 'answer option label; repeat 2–5 times', collectOption, [])
    .option('--to <user>', 'limit who can answer: @handle, <@U…>, or U…; omit for DM counterpart or anyone in a channel/thread')
    .option('--channel <channel>', 'channel ID/name or DM target; defaults to the current Slack surface when available')
    .option('--thread-ts <ts>', 'post inside this thread; requires or derives a channel')
    .option('--no-reply-hint', 'hide the typed-reply escape hatch')
    .action(async (_, command) => {
      await runAsk(AskCommandSchema.parse(command.optsWithGlobals()));
    });
}

export async function runAsk(opts: z.infer<typeof AskCommandSchema>): Promise<void> {
  const agentId = resolveToolAgentId({});
  if (!agentId) throw new Error('ask requires ANIMA_AGENT_ID');
  const slack = await agentSlackServiceForAgent(agentId).getAgentWebClient();
  const { agent } = slack;
  const client = slack.client;
  const askService = interactiveAskServiceForAgent(agentId);
  const teamId = agent.slack.teamId || undefined;
  if (!teamId) throw new Error(`Agent ${agent.id} has no Slack team id configured`);

  const options = normalizedOptions(opts.option);
  const target = await resolveAskTarget({
    agentId,
    channel: opts.channel,
    client,
    teamId,
    threadTs: opts.threadTs,
  });
  const answerPolicy = await resolveAnswerPolicy({
    client,
    teamId,
    to: opts.to,
    target,
  });
  const targetSummary = await slackTargetSummary({ channel: target.channel, client, teamId });
  const thread = target.threadTs ? slackThreadSummary(targetSummary, target.threadTs) : undefined;
  const question = opts.question.trim();
  const basePayload = {
    ...slackTargetPayload(target.channel),
    ...targetSummary,
    ...(thread ? thread : {}),
    ...(target.threadTs ? { threadTs: target.threadTs } : {}),
    allowAnyone: answerPolicy.allowAnyone,
    ...(answerPolicy.allowedUserLabel ? { allowedUserLabel: answerPolicy.allowedUserLabel } : {}),
    optionCount: options.length,
    target: question,
    tool: 'anima.ask',
  };

  await withToolActivity({
    audit: { agentId },
    basePayload,
    effectType: 'slack.ask.post',
    op: async () => {
      const askId = makeId('ask');
      const content = askMessageContent({
        askId,
        mentionUserId: answerPolicy.mentionUserId,
        options,
        question,
        replyHint: opts.replyHint,
      });
      const payload = {
        blocks: content.blocks,
        channel: target.channel.id,
        text: content.text,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      } as SlackPostMessagePayload;
      const response = await client.chat.postMessage(payload);
      if (!response.ts) throw new Error('Slack chat.postMessage did not return a message ts');

      const messageTs = response.ts;
      const channelId = response.channel ?? target.channel.id;
      const record: InteractiveAskRecord = {
        agentId,
        allowAnyone: answerPolicy.allowAnyone,
        ...(answerPolicy.allowedUserIds ? { allowedUserIds: answerPolicy.allowedUserIds } : {}),
        askId,
        channelId,
        channelName: targetSummary.channelDisplayName,
        createdAt: nowIso(),
        messageTs,
        options,
        question,
        status: 'pending',
        teamId,
        ...(target.threadTs ? { threadTs: target.threadTs } : {}),
      };
      await askService.saveAsk(record);
      if (!target.channel.dmUserId && !target.threadTs) {
        await recordOutboundEngagement({ agentId, channelId });
      }
      const threadSubscription = target.channel.dmUserId
        ? undefined
        : await ensureThreadSubscriptionForSentMessage({
            agentId,
            channelId,
            messageTs,
            ...(target.threadTs ? { threadTs: target.threadTs } : {}),
          });
      console.log(askOutputLine({
        askId,
        messageTs,
        target: targetSummary,
        ...(thread ? { thread } : {}),
      }));
      return {
        result: undefined,
        completedPayload: {
          askId,
          messageTs,
          optionLabels: options.map((option) => option.label),
          question,
          ...(answerPolicy.allowedUserIds ? { allowedUserIds: answerPolicy.allowedUserIds } : {}),
          ...(answerPolicy.allowedUserLabel ? { allowedUserLabel: answerPolicy.allowedUserLabel } : {}),
          ...(answerPolicy.allowAnyone ? { allowAnyone: true } : {}),
          payload,
          ...(threadSubscription ? { threadSubscription: subscriptionPayload(threadSubscription) } : {}),
        },
      };
    },
  });
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function normalizedOptions(labels: string[]): InteractiveAskOption[] {
  const normalized = labels.map((label) => label.trim()).filter(Boolean);
  if (normalized.length < 2 || normalized.length > 5) {
    throw new Error('ask requires 2–5 --option values');
  }
  return normalized.map((label, index) => ({
    label,
    optionId: `option_${index + 1}`,
  }));
}

async function resolveAnswerPolicy(input: {
  client: WebClient;
  teamId: string;
  target: AskTarget;
  to?: string;
}): Promise<{
  allowAnyone?: boolean;
  allowedUserIds?: string[];
  allowedUserLabel?: string;
  mentionUserId?: string;
}> {
  if (!input.to && !input.target.defaultUser) return { allowAnyone: true };

  const explicit = Boolean(input.to);
  const user = input.to
    ? await resolveSlackUserArgument({ client: input.client, teamId: input.teamId, user: input.to })
    : input.target.defaultUser!;
  return {
    allowedUserIds: [user.slackUserId],
    allowedUserLabel: askUserLabel(user),
    ...(explicit ? { mentionUserId: user.slackUserId } : {}),
  };
}

async function resolveSlackUserArgument(input: {
  client: WebClient;
  teamId: string;
  user: string;
}): Promise<AskAllowedUser> {
  const user = input.user.trim();
  const mention = user.match(/^<@([A-Z0-9][A-Z0-9_-]*)>$/i);
  const userId = mention?.[1] ?? (/^U[A-Z0-9_-]+$/i.test(user) ? user : undefined);
  const directory = new SlackWorkspaceDirectoryService({ client: input.client, teamId: input.teamId });
  if (userId) {
    const info = await directory.getUser(userId);
    assertHumanAskTarget(info, user);
    return slackAnswerUser(info, userId);
  }
  const handle = user.replace(/^@/, '');
  if (!handle) throw new Error('--to requires @handle, <@U…>, or U…');
  const info = await directory.getUserByHandle(handle);
  if (!info.id) throw new Error(`Slack user not found: ${user}`);
  assertHumanAskTarget(info, user);
  return slackAnswerUser(info, info.id);
}

function assertHumanAskTarget(
  user: { deleted?: boolean; is_app_user?: boolean; is_bot?: boolean } | undefined,
  label: string,
): void {
  if (!user) return;
  if (user.deleted) throw new Error(`Cannot ask ${label}: that Slack user is deleted`);
  if (user.is_bot || user.is_app_user) {
    throw new Error(`Cannot ask ${label}: anima ask is for human Slack users, not bots`);
  }
}

function askUserLabel(user: AskAllowedUser): string {
  return user.displayName?.trim()
    || user.handle?.replace(/^@/, '').trim()
    || `<@${user.slackUserId}>`;
}

async function resolveAskTarget(input: {
  agentId: string;
  channel?: string;
  client: WebClient;
  teamId: string;
  threadTs?: string;
}): Promise<AskTarget> {
  if (input.channel) {
    const channel = await resolveSlackChannelArgument({
      channel: input.channel,
      client: input.client,
      teamId: input.teamId,
    });
    return {
      channel,
      ...(channel.dmUserId ? { defaultUser: { slackUserId: channel.dmUserId, ...(channel.dmHandle ? { handle: channel.dmHandle } : {}) } } : {}),
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    };
  }
  const current = await currentSlackSurface(input.agentId);
  if (!current) throw new Error('ask requires --channel unless the current inbox item has a Slack surface');
  return {
    channel: { id: current.channelId },
    ...(current.defaultUser ? { defaultUser: current.defaultUser } : {}),
    threadTs: input.threadTs ?? current.threadTs,
  };
}

async function currentSlackSurface(agentId: string): Promise<{
  channelId: string;
  defaultUser?: AskAllowedUser;
  threadTs?: string;
} | undefined> {
  const itemId = await resolveToolItemId({ agent: agentId });
  if (!itemId) return undefined;
  const item = await wakeQueueServiceForAgent(agentId).find(itemId);
  if (!item) return undefined;
  return slackSurfaceFromItem(item);
}

function slackSurfaceFromItem(item: InboxItem): {
  channelId: string;
  defaultUser?: AskAllowedUser;
  threadTs?: string;
} | undefined {
  if (item.kind === 'slack') {
    const defaultUser = item.channelId.startsWith('D') && item.actor?.userId
      ? {
          displayName: item.actor.displayName || item.actor.realName,
          handle: item.actor.handle,
          slackUserId: item.actor.userId,
        }
      : undefined;
    return {
      channelId: item.channelId,
      ...(defaultUser ? { defaultUser } : {}),
      threadTs: item.threadTs ?? item.messageTs,
    };
  }
  if (item.kind === 'choice_response') {
    return {
      channelId: item.channelId,
      ...(item.channelId.startsWith('D') ? { defaultUser: item.answeredBy } : {}),
      threadTs: item.threadTs,
    };
  }
  if (item.kind === 'onboarding') {
    return { channelId: item.channelId, defaultUser: item.operator };
  }
  return undefined;
}

function askMessageContent(input: {
  askId: string;
  mentionUserId?: string;
  options: InteractiveAskOption[];
  question: string;
  replyHint: boolean;
}): {
  blocks: Array<Record<string, unknown>>;
  text: string;
} {
  const prefix = input.mentionUserId ? `<@${input.mentionUserId}> ` : '';
  const questionText = `${prefix}${input.question}`;
  const optionLines = input.options.map((option, index) => `${index + 1}. ${option.label}`);
  const hint = input.replyHint ? '\n\nNone fit? Just reply in this thread.' : '';
  return {
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: questionText },
      },
      {
        type: 'actions',
        elements: input.options.map((option, idx) => ({
          type: 'button',
          action_id: `${INTERACTIVE_ASK_ACTION_ID}:${idx}`,
          text: { type: 'plain_text', text: option.label, emoji: true },
          value: JSON.stringify({ askId: input.askId, optionId: option.optionId }),
        })),
      },
      ...(input.replyHint
        ? [{
            type: 'context',
            elements: [{ type: 'mrkdwn', text: 'None fit? Just reply in this thread.' }],
          }]
        : []),
    ],
    text: `${questionText}\n\nOptions:\n${optionLines.join('\n')}${hint}`,
  };
}

function askOutputLine(input: {
  askId: string;
  messageTs: string;
  target: SlackTargetSummary;
  thread?: SlackThreadSummary;
}): string {
  const parts = [slackOutputTarget(input.target)];
  if (input.thread) parts.push(`thread_ts=${input.thread.threadTs}`);
  parts.push(`message_ts=${input.messageTs}`);
  parts.push(`ask_id=${input.askId}`);
  return `asked successfully. ${parts.join(', ')}.`;
}

function subscriptionPayload(subscription: { kind: string; mutedAt?: string; subscriptionId: string; threadTs?: string }): Record<string, unknown> {
  return {
    subscriptionId: subscription.subscriptionId,
    kind: subscription.kind,
    ...(subscription.mutedAt ? { mutedAt: subscription.mutedAt } : {}),
    ...(subscription.threadTs ? { threadTs: subscription.threadTs } : {}),
  };
}
