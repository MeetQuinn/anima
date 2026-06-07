import type {
  ConversationsHistoryResponse,
  ConversationsRepliesResponse,
  WebClient,
} from '@slack/web-api';

import { createFeishuMessageClient as createDefaultFeishuMessageClient } from '../feishu/client.js';
import type {
  FeishuMessageClient,
  FeishuMessageListResult,
} from '../feishu/client.js';
import { resolveSlackChannelArgument } from './slack-channel-resolver.js';
import {
  slackTargetSummary,
  slackThreadSummary,
  type SlackChannelKind,
  type SlackTargetSummary,
  type SlackThreadSummary,
} from './slack-target.js';
import {
  loadAgentFromOpts,
  resolveToolAgentId,
  slackWebClientForOpts,
  withToolActivity,
} from './tool-context.js';
import { feishuTranscriptOutput } from './feishu-transcript.js';
import {
  slackTranscriptOutput,
  slackTranscriptUserLabels,
  type SlackConversationMessage,
} from './slack-transcript.js';

interface MessageGlobalInput {
  agent?: string;
  item?: string;
}

export interface MessageReadInput extends MessageGlobalInput {
  after?: string;
  around?: string;
  before?: string;
  channel?: string;
  cursor?: string;
  inclusive?: boolean;
  json?: boolean;
  latest?: string;
  limit?: number;
  oldest?: string;
  threadTs?: string;
}

interface SlackReadRequest {
  after?: string;
  around?: string;
  before?: string;
  channel: string;
  channelDisplayName: string;
  channelKind: SlackChannelKind;
  channelName?: string;
  client: WebClient;
  cursor?: string;
  dmHandle?: string;
  dmUserId?: string;
  inclusive?: boolean;
  latest?: string;
  limit: number;
  oldest?: string;
  teamId?: string;
  threadTs?: string;
}

interface FeishuReadRequest {
  chatId: string;
  client: FeishuMessageClient;
  cursor?: string;
  limit: number;
  threadId?: string;
  threadRef?: string;
}

type SlackReadTool = 'anima.message.read';
type SlackConversationReadResponse = ConversationsHistoryResponse | ConversationsRepliesResponse;
type SlackConversationReadMessage =
  | NonNullable<ConversationsHistoryResponse['messages']>[number]
  | NonNullable<ConversationsRepliesResponse['messages']>[number];

interface MessageReadDeps {
  createFeishuMessageClient?: typeof createDefaultFeishuMessageClient;
}

export async function runMessageRead(opts: MessageReadInput, deps: MessageReadDeps = {}): Promise<void> {
  const feishuRequest = await feishuReadRequest(opts, deps);
  if (feishuRequest) {
    await runFeishuReadTool({ opts, request: feishuRequest, tool: 'anima.message.read' });
    return;
  }

  const threadTs = opts.threadTs;
  const mode: 'history' | 'replies' = threadTs ? 'replies' : 'history';
  const request = await slackReadRequest({ ...opts, threadTs }, mode);
  if (mode === 'replies' && !request.threadTs) throw new Error('Missing --thread-ts');
  await runSlackReadTool({
    opts,
    request,
    tool: 'anima.message.read',
    execute: () =>
      mode === 'replies'
        ? request.client.conversations.replies({
            channel: request.channel,
            ...(request.cursor ? { cursor: request.cursor } : {}),
            ...(request.inclusive !== undefined ? { inclusive: request.inclusive } : {}),
            ...(request.latest ? { latest: request.latest } : {}),
            limit: request.limit,
            ...(request.oldest ? { oldest: request.oldest } : {}),
            ts: request.threadTs as string,
          })
        : request.client.conversations.history({
            channel: request.channel,
            ...(request.cursor ? { cursor: request.cursor } : {}),
            ...(request.inclusive !== undefined ? { inclusive: request.inclusive } : {}),
            ...(request.latest ? { latest: request.latest } : {}),
            limit: request.limit,
            ...(request.oldest ? { oldest: request.oldest } : {}),
          }),
  });
}

async function feishuReadRequest(
  opts: MessageReadInput,
  deps: MessageReadDeps,
): Promise<FeishuReadRequest | undefined> {
  const chatId = opts.channel?.trim();
  if (!chatId?.startsWith('oc_')) return undefined;
  assertFeishuReadSupported(opts);

  const agent = await loadAgentFromOpts(opts);
  if (!agent.feishu.connected) {
    throw new Error(`Agent ${agent.id} has no Feishu connection configured`);
  }

  const client = (deps.createFeishuMessageClient ?? createDefaultFeishuMessageClient)(agent.feishu);
  const thread = await feishuReadThreadRef(opts.threadTs, client);

  return {
    chatId,
    client,
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
    limit: Math.min(opts.limit ?? 20, 50),
    ...(thread ? thread : {}),
  };
}

async function feishuReadThreadRef(
  threadTs: string | undefined,
  client: FeishuMessageClient,
): Promise<Pick<FeishuReadRequest, 'threadId' | 'threadRef'> | undefined> {
  const ref = threadTs?.trim();
  if (!ref) return undefined;
  if (ref.startsWith('omt_')) return { threadId: ref, threadRef: ref };
  if (!ref.startsWith('om_')) {
    throw new Error('Feishu message read --thread-ts must be a topic thread_id (omt_...) or message_id (om_...)');
  }
  if (!client.getMessage) {
    throw new Error('Feishu message client does not support resolving message_id to thread_id');
  }
  const message = await client.getMessage({ messageId: ref });
  if (!message?.threadId) {
    throw new Error(`Feishu message ${ref} did not include thread_id; pass the topic thread_id (omt_...) instead`);
  }
  return { threadId: message.threadId, threadRef: ref };
}

function assertFeishuReadSupported(opts: MessageReadInput): void {
  const unsupported = [
    opts.after ? '--after' : '',
    opts.around ? '--around' : '',
    opts.before ? '--before' : '',
    opts.inclusive ? '--inclusive' : '',
    opts.latest ? '--latest' : '',
    opts.oldest ? '--oldest' : '',
  ].filter(Boolean);
  if (unsupported.length > 0) {
    throw new Error(`Feishu message read currently supports --chat-id/--channel, --thread-ts, --limit, and --cursor only; unsupported: ${unsupported.join(', ')}`);
  }
}

async function slackReadRequest(opts: MessageReadInput, mode: 'history' | 'replies'): Promise<SlackReadRequest> {
  const { agent, client } = await slackWebClientForOpts(opts);
  const teamId = agent.slack.teamId || undefined;

  if (!opts.channel) throw new Error('Missing --channel or --chat-id');
  const channel = await resolveSlackChannelArgument({
    channel: opts.channel,
    client,
    teamId,
  });

  const agentRangeSelectors = [opts.around, opts.before, opts.after].filter(Boolean);
  if (agentRangeSelectors.length > 1) {
    throw new Error('Pass only one of --around, --before, or --after');
  }
  if (agentRangeSelectors.length > 0 && (opts.latest || opts.oldest || opts.cursor)) {
    throw new Error('Do not combine --around, --before, or --after with --oldest, --latest, or --cursor');
  }
  const latest = opts.latest ?? opts.around ?? opts.before;
  const oldest = opts.oldest ?? opts.after;
  const inclusive = opts.inclusive ?? (opts.around ? true : undefined);
  const threadTs = opts.threadTs;
  const limitDefault = mode === 'replies' ? 50 : 20;
  const limit = Math.min(opts.limit ?? limitDefault, 200);

  return {
    ...(opts.after ? { after: opts.after } : {}),
    ...(opts.around ? { around: opts.around } : {}),
    ...(opts.before ? { before: opts.before } : {}),
    channel: channel.id,
    client,
    ...(channel.name ? { channelName: channel.name } : {}),
    ...('dmHandle' in channel && channel.dmHandle ? { dmHandle: channel.dmHandle } : {}),
    ...('dmUserId' in channel && channel.dmUserId ? { dmUserId: channel.dmUserId } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
    ...(inclusive ? { inclusive } : {}),
    ...(latest ? { latest } : {}),
    limit,
    ...(oldest ? { oldest } : {}),
    ...(teamId ? { teamId } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(await slackTargetSummary({ channel, client, teamId })),
  };
}

async function runSlackReadTool(input: {
  execute: () => Promise<SlackConversationReadResponse>;
  opts: MessageReadInput;
  request: SlackReadRequest;
  tool: SlackReadTool;
}): Promise<void> {
  const agentId = resolveToolAgentId(input.opts);
  if (!agentId) throw new Error('message read requires current agent context for audit');
  const basePayload = slackReadActivityPayload(input.tool, input.request);

  await withToolActivity({
    audit: { agentId },
    basePayload,
    op: async () => {
      const response = await input.execute();
      const messages = slackMessagesWithTimestamps(response.messages);
      const auth = await input.request.client.auth.test().catch(() => undefined);
      const cacheTeamId = auth?.team_id ?? input.request.teamId;
      const cacheContext = { ...(cacheTeamId ? { teamId: cacheTeamId } : {}) };
      const userLabels = await slackTranscriptUserLabels(messages, input.request.client, cacheTeamId);
      console.log(
        slackTranscriptOutput(messages, input.request, userLabels, {
          hasMore: response.has_more ?? false,
          nextCursor: response.response_metadata?.next_cursor ?? '',
        }, cacheContext),
      );
      return {
        result: undefined,
        completedPayload: {
          hasMore: response.has_more ?? false,
          messageCount: messages.length,
          nextCursor: response.response_metadata?.next_cursor ?? '',
        },
      };
    },
  });
}

async function runFeishuReadTool(input: {
  opts: MessageReadInput;
  request: FeishuReadRequest;
  tool: SlackReadTool;
}): Promise<void> {
  const agentId = resolveToolAgentId(input.opts);
  if (!agentId) throw new Error('message read requires current agent context for audit');
  const basePayload = feishuReadActivityPayload(input.tool, input.request);

  await withToolActivity({
    audit: { agentId },
    basePayload,
    op: async () => {
      const response = await input.request.client.listMessages({
        chatId: input.request.chatId,
        ...(input.request.cursor ? { cursor: input.request.cursor } : {}),
        limit: input.request.limit,
        ...(input.request.threadId ? { threadId: input.request.threadId } : {}),
      });
      console.log(feishuReadOutput(input.request, response));
      return {
        result: undefined,
        completedPayload: {
          hasMore: response.hasMore,
          messageCount: response.messages.length,
          nextCursor: response.nextCursor ?? '',
        },
      };
    },
  });
}

function feishuReadOutput(request: FeishuReadRequest, response: FeishuMessageListResult): string {
  return feishuTranscriptOutput(response.messages, request, {
    hasMore: response.hasMore,
    nextCursor: response.nextCursor ?? '',
  });
}

function slackReadActivityPayload(tool: SlackReadTool, request: SlackReadRequest): Record<string, unknown> {
  return {
    ...(request.after ? { after: request.after } : {}),
    ...(request.around ? { around: request.around } : {}),
    ...(request.before ? { before: request.before } : {}),
    channel: request.channel,
    ...slackReadOutputTarget(request),
    ...(request.channelName ? { channelName: request.channelName } : {}),
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.dmHandle ? { dmHandle: request.dmHandle } : {}),
    ...(request.dmUserId ? { dmUserId: request.dmUserId } : {}),
    ...(request.latest ? { latest: request.latest } : {}),
    limit: request.limit,
    ...(request.oldest ? { oldest: request.oldest } : {}),
    ...(request.threadTs ? { threadTs: request.threadTs } : {}),
    tool,
  };
}

function feishuReadActivityPayload(tool: SlackReadTool, request: FeishuReadRequest): Record<string, unknown> {
  return {
    channel: request.chatId,
    channelDisplayName: 'Feishu chat',
    channelKind: request.threadId ? 'topic' : 'chat',
    ...(request.cursor ? { cursor: request.cursor } : {}),
    limit: request.limit,
    platform: 'feishu',
    ...(request.threadId ? { threadId: request.threadId } : {}),
    ...(request.threadRef ? { targetTs: request.threadRef, threadTs: request.threadRef } : {}),
    tool,
  };
}

function slackReadOutputTarget(request: SlackReadRequest): SlackTargetSummary & Partial<SlackThreadSummary> {
  const target = {
    channelDisplayName: request.channelDisplayName,
    channelKind: request.channelKind,
  };
  return request.threadTs
    ? { ...target, ...slackThreadSummary(target, request.threadTs) }
    : target;
}

function slackMessagesWithTimestamps(messages: SlackConversationReadMessage[] | undefined): SlackConversationMessage[] {
  return (messages ?? [])
    .filter((message): message is SlackConversationReadMessage & { ts: string } => typeof message.ts === 'string')
    .map((message) => message as SlackConversationMessage);
}
