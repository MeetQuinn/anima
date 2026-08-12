// Slack ingress helper: record a routable message into the agent-scoped
// observed-conversation journal before wake/subscription filtering.

import { errorMessage } from '../ids.js';
import { slackTsToIso } from '../slack/slack.helper.js';
import {
  observedConversationStoreForAgent,
  type ObserveSlackMessageResult,
} from '../storage/schema/observed-conversation.store.js';
import {
  slackEventTeamId,
  type RoutableSlackMessage,
  type SlackMessageEnvelope,
} from './slack-events.js';

export async function observeRoutableSlackMessage(input: {
  agentId: string;
  envelope?: SlackMessageEnvelope;
  event: RoutableSlackMessage;
  /** When true, rethrow store failures (tests). Default: log and continue. */
  throwOnError?: boolean;
}): Promise<ObserveSlackMessageResult | undefined> {
  const teamId = slackEventTeamId(input.envelope, input.event);
  const store = observedConversationStoreForAgent(input.agentId);
  try {
    return await store.observe({
      ...(input.event.bot_id ? { botId: input.event.bot_id } : {}),
      channelId: input.event.channel,
      messageTs: input.event.ts,
      ...(slackTsToIso(input.event.ts) ? { receivedAt: slackTsToIso(input.event.ts) } : {}),
      teamId,
      text: input.event.text,
      ...(input.event.thread_ts ? { threadTs: input.event.thread_ts } : {}),
      userId: input.event.user,
    });
  } catch (error) {
    if (input.throwOnError) throw error;
    console.warn(
      `observed-conversation journal write failed for agent=${input.agentId} channel=${input.event.channel} ts=${input.event.ts}: ${errorMessage(error)}`,
    );
    return undefined;
  }
}
