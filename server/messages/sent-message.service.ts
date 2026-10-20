import {
  ensureThreadSubscriptionForSentMessage,
  recordOutboundEngagement,
  type SubscriptionRecord,
} from '../inbox/subscription.service.js';
import { errorMessage } from '../ids.js';

/**
 * The thread Slack actually put a post in, from its `chat.postMessage` response.
 * A requested reply can land top-level; its response message then has no
 * `thread_ts`, and the post is its own thread root. Without a response
 * message, trust the request.
 */
export function postedSlackThreadTs(
  response: { message?: { thread_ts?: string }; ts?: string },
  requestedThreadTs: string | undefined,
): string | undefined {
  if (!requestedThreadTs) return undefined;
  if (!response.message) return requestedThreadTs;
  const threadTs = response.message.thread_ts;
  return threadTs && threadTs !== response.ts ? threadTs : undefined;
}

/** Local bookkeeping after Slack has accepted a post. Never retry the post here. */
export async function finalizeSentSlackMessage(input: {
  agentId: string;
  channelId: string;
  isDm: boolean;
  messageTs?: string;
  threadTs?: string;
}): Promise<{ threadSubscription?: SubscriptionRecord; warnings: string[] }> {
  const warnings: string[] = [];
  if (input.isDm) return { warnings };
  if (!input.threadTs) {
    try {
      await recordOutboundEngagement({ agentId: input.agentId, channelId: input.channelId });
    } catch (error) {
      console.warn(`Sent message engagement write failed for ${input.agentId}: ${errorMessage(error)}`);
      warnings.push('Message was sent, but local engagement could not be saved. Do not resend it.');
    }
  }
  let threadSubscription: SubscriptionRecord | undefined;
  if (input.messageTs) {
    try {
      threadSubscription = await ensureThreadSubscriptionForSentMessage({
        agentId: input.agentId,
        channelId: input.channelId,
        messageTs: input.messageTs,
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      });
    } catch (error) {
      console.warn(`Sent message subscription write failed for ${input.agentId}: ${errorMessage(error)}`);
      warnings.push('Message was sent, but its local thread subscription could not be saved. Do not resend it.');
    }
  }
  return { ...(threadSubscription ? { threadSubscription } : {}), warnings };
}
