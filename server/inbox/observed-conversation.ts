// Slack ingress helper: record an observable message into the agent-scoped
// observed-conversation journal before wake/subscription filtering.
//
// Observation uses a broader predicate than runtime routability: userless
// bot_message and file-only posts are journaled without changing wake routing.

import { errorMessage } from '../ids.js';
import { slackTsToIso, type SlackRawFile } from '../slack/slack.helper.js';
import {
  observedConversationStoreForAgent,
  type ObservedFileDescriptor,
  type ObserveSlackMessageResult,
} from '../storage/schema/observed-conversation.store.js';
import {
  isObservableSlackMessage,
  slackEventTeamId,
  type ObservableSlackMessage,
  type SlackMessageEnvelope,
  type SlackRawMessageEvent,
} from './slack-events.js';

export async function observeObservableSlackMessage(input: {
  agentId: string;
  envelope?: SlackMessageEnvelope;
  event: ObservableSlackMessage;
  /** When true, rethrow store failures after marking continuity degraded. Default: mark degraded and continue. */
  throwOnError?: boolean;
}): Promise<ObserveSlackMessageResult | undefined> {
  const teamId = slackEventTeamId(input.envelope, input.event);
  const store = observedConversationStoreForAgent(input.agentId);
  const files = observedFilesFromSlack(input.event.files);
  try {
    return await store.observe({
      ...(input.event.bot_id ? { botId: input.event.bot_id } : {}),
      channelId: input.event.channel,
      ...(files.length > 0 ? { files } : {}),
      messageTs: input.event.ts,
      ...(slackTsToIso(input.event.ts) ? { receivedAt: slackTsToIso(input.event.ts) } : {}),
      teamId,
      text: input.event.text ?? '',
      ...(input.event.thread_ts ? { threadTs: input.event.thread_ts } : {}),
      ...(input.event.user ? { userId: input.event.user } : {}),
    });
  } catch (error) {
    // store.observe already marks continuity degraded; helper only controls throw.
    if (input.throwOnError) throw error;
    console.warn(
      `observed-conversation journal write failed for agent=${input.agentId} channel=${input.event.channel} ts=${input.event.ts}: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/**
 * Ingress entry: if the raw event is observable, journal it (fail-soft by
 * default). Returns whether observation was attempted.
 */
export async function observeSlackEventAtIngress(input: {
  agentId: string;
  envelope?: SlackMessageEnvelope;
  event: SlackRawMessageEvent;
  throwOnError?: boolean;
}): Promise<ObserveSlackMessageResult | undefined> {
  if (!isObservableSlackMessage(input.event)) return undefined;
  return observeObservableSlackMessage({
    agentId: input.agentId,
    envelope: input.envelope,
    event: input.event,
    ...(input.throwOnError ? { throwOnError: true } : {}),
  });
}

export function observedFilesFromSlack(
  files: SlackRawFile[] | undefined,
): ObservedFileDescriptor[] {
  if (!Array.isArray(files) || files.length === 0) return [];
  const out: ObservedFileDescriptor[] = [];
  for (const file of files) {
    if (!file || typeof file.id !== 'string' || file.id.trim().length === 0) continue;
    const descriptor: ObservedFileDescriptor = { id: file.id };
    if (typeof file.name === 'string' && file.name.length > 0) descriptor.name = file.name;
    else if (typeof file.title === 'string' && file.title.length > 0) descriptor.name = file.title;
    if (typeof file.mimetype === 'string' && file.mimetype.length > 0) {
      descriptor.mimetype = file.mimetype;
    }
    out.push(descriptor);
  }
  return out;
}
