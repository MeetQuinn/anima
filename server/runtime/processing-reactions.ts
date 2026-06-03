import { errorMessage } from '../ids.js';
import type { InboxItem } from '../inbox/wake-queue.service.js';
import { createSlackWebClient } from '../slack/client.js';
import { isSlackEvent } from '../inbox/slack-events.js';
import { createFeishuMessageClient, type FeishuMessageClient } from '../feishu/client.js';
import { isFeishuEvent } from '../feishu/events.js';
import type { FeishuConfig } from '../../shared/agent-config.js';

const DEFAULT_PROCESSING_REACTION = 'eyes';
const DEFAULT_FEISHU_PROCESSING_REACTION = 'OneSecond';

interface SlackProcessingReaction {
  channel: string;
  name: string;
  timestamp: string;
}

interface SlackProcessingReactionClient {
  add(input: SlackProcessingReaction): Promise<void>;
  remove(input: SlackProcessingReaction): Promise<void>;
}

interface SlackProcessingReactionContext {
  item: InboxItem;
}

export function slackReactionClient(token: string): SlackProcessingReactionClient {
  const client = createSlackWebClient(token);
  return {
    add: async (reaction) => {
      await client.reactions.add(reaction);
    },
    remove: async (reaction) => {
      await client.reactions.remove(reaction);
    },
  };
}

export async function addProcessingReaction(input: {
  context: SlackProcessingReactionContext;
  logger?: Pick<Console, 'error'>;
  name?: string;
  reactionClient?: SlackProcessingReactionClient;
}): Promise<void> {
  const reaction = processingReactionForEvent(input.context.item, input.name ?? DEFAULT_PROCESSING_REACTION);
  if (!reaction || !input.reactionClient) return;
  try {
    await input.reactionClient.add(reaction);
  } catch (error) {
    if (isIgnoredReactionError(error, 'already_reacted')) return;
    input.logger?.error(`Slack processing reaction add failed for item ${input.context.item.id}: ${errorMessage(error)}`);
  }
}

export async function removeProcessingReactions(input: {
  context: SlackProcessingReactionContext;
  logger?: Pick<Console, 'error'>;
  name?: string;
  reactionClient?: SlackProcessingReactionClient;
}): Promise<void> {
  if (!input.reactionClient) return;
  const reactions = uniqueProcessingReactions(
    [input.context.item],
    input.name ?? DEFAULT_PROCESSING_REACTION,
  );
  for (const reaction of reactions) {
    try {
      await input.reactionClient.remove(reaction);
    } catch (error) {
      if (isIgnoredReactionError(error, 'no_reaction')) continue;
      input.logger?.error(`Slack processing reaction remove failed for item ${input.context.item.id}: ${errorMessage(error)}`);
    }
  }
}

function uniqueProcessingReactions(events: InboxItem[], name: string): SlackProcessingReaction[] {
  const reactions = new Map<string, SlackProcessingReaction>();
  for (const event of events) {
    const reaction = processingReactionForEvent(event, name);
    if (!reaction) continue;
    reactions.set(`${reaction.channel}:${reaction.timestamp}:${reaction.name}`, reaction);
  }
  return Array.from(reactions.values());
}

function processingReactionForEvent(event: InboxItem, name: string): SlackProcessingReaction | undefined {
  if (!isSlackEvent(event)) return undefined;
  return {
    channel: event.channelId,
    name,
    timestamp: event.messageTs,
  };
}

function isIgnoredReactionError(error: unknown, code: string): boolean {
  return errorMessage(error).includes(code);
}

export interface FeishuProcessingReactionClient {
  add(messageId: string): Promise<void>;
  remove(messageId: string): Promise<void>;
}

export function feishuProcessingReactionClient(
  config: FeishuConfig,
  deps: { client?: FeishuMessageClient; emojiType?: string } = {},
): FeishuProcessingReactionClient {
  const client = deps.client ?? createFeishuMessageClient(config);
  const emojiType = deps.emojiType ?? DEFAULT_FEISHU_PROCESSING_REACTION;
  const reactionIds = new Map<string, string>();
  return {
    async add(messageId) {
      if (reactionIds.has(messageId)) return;
      const { reactionId } = await client.addReaction({ emojiType, messageId });
      reactionIds.set(messageId, reactionId);
    },
    async remove(messageId) {
      const reactionId = reactionIds.get(messageId);
      if (!reactionId) return;
      reactionIds.delete(messageId);
      await client.removeReaction({ messageId, reactionId });
    },
  };
}

export async function addFeishuProcessingReaction(input: {
  context: { item: InboxItem };
  feishuClient?: FeishuProcessingReactionClient;
  logger?: Pick<Console, 'error'>;
}): Promise<void> {
  const item = input.context.item;
  if (!isFeishuEvent(item) || !input.feishuClient) return;
  try {
    await input.feishuClient.add(item.messageId);
  } catch (error) {
    input.logger?.error(`Feishu processing reaction add failed for item ${item.id}: ${errorMessage(error)}`);
  }
}

export async function removeFeishuProcessingReaction(input: {
  context: { item: InboxItem };
  feishuClient?: FeishuProcessingReactionClient;
  logger?: Pick<Console, 'error'>;
}): Promise<void> {
  const item = input.context.item;
  if (!isFeishuEvent(item) || !input.feishuClient) return;
  try {
    await input.feishuClient.remove(item.messageId);
  } catch (error) {
    input.logger?.error(`Feishu processing reaction remove failed for item ${item.id}: ${errorMessage(error)}`);
  }
}
