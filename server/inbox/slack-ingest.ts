import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import {
  attachmentsHaveSlackMessagePreviews,
  slackPermalinkMentioned,
  waitForSlackMessagePreviewAttachments,
} from '../slack/message-previews.js';
import { SlackProfileResolver } from '../slack/profiles.js';
import { slackVisibleMessageText } from '../slack/message-text.js';
import type { SlackInboxItem } from '../../shared/inbox.js';
import {
  normalizeSlackMessage,
  slackEventTeamId,
  type RoutableSlackMessage,
  type SlackMessageEnvelope,
} from './slack-events.js';

export interface SlackIngestInput {
  attentionSuggestion?: string;
  client: WebClient;
  envelope?: SlackMessageEnvelope;
  event: RoutableSlackMessage;
  profiles?: SlackProfileResolver;
  previewClient?: (signal: AbortSignal) => Pick<WebClient, 'conversations'>;
  previewTimeoutMs?: number;
  previewRetryDelaysMs?: readonly number[];
  warn?: (message: string) => void;
}

// Turns one routable Slack event into a fully enriched inbox item: sender and
// channel profiles, readable mention text, permalink, unfurl previews, and file
// metadata. Every Slack lookup is best-effort; a failure degrades that field
// without dropping the wake. Slack-link preview reads finish (or exhaust a
// bounded budget) BEFORE enqueue. Privacy boundary: the only message-content read is
// the containing message itself (for late unfurls); linked channels and DMs are
// never fetched, previews come only from what Slack attached to this event.
export async function buildSlackInboxItem(input: SlackIngestInput): Promise<SlackInboxItem> {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const profiles = input.profiles ?? new SlackProfileResolver();
  const client = input.client;
  const visibleText = slackVisibleMessageText(input.event) ?? input.event.text;
  const event = visibleText === input.event.text
    ? input.event
    : { ...input.event, text: visibleText };
  const teamId = slackEventTeamId(input.envelope, event);

  const [userProfile, channelProfile, text, permalink, attachments] = await Promise.all([
    profiles.user({ client, teamId, userId: event.user }),
    profiles.conversation({ channelId: event.channel, client, teamId }),
    profiles.displayText({ client, teamId, text: event.text }),
    slackPermalink(event, client, warn),
    attachmentsHaveSlackMessagePreviews(event.attachments)
      ? Promise.resolve(event.attachments)
      : waitForSlackMessagePreviewAttachments({
        channelId: event.channel,
        client,
        createClient: input.previewClient,
        messageTs: event.ts,
        retryDelaysMs: input.previewRetryDelaysMs,
        timeoutMs: input.previewTimeoutMs,
        text: event.text,
        warn,
      }),
  ]);

  const item = normalizeSlackMessage({
    ...(attachments ? { attachments } : {}),
    ...(input.attentionSuggestion ? { attentionSuggestion: input.attentionSuggestion } : {}),
    ...(channelProfile?.name ? { channelName: channelProfile.name } : {}),
    envelope: input.envelope,
    event,
    ...(permalink ? { permalink } : {}),
    text,
    ...(userProfile ? { userProfile } : {}),
  });

  if (slackPermalinkMentioned(event.text) && !item.previews?.length) item.previewStatus = 'unavailable';
  return item;
}

async function slackPermalink(
  event: RoutableSlackMessage,
  client: WebClient,
  warn: (message: string) => void,
): Promise<string | undefined> {
  try {
    const response = await client.chat.getPermalink({
      channel: event.channel,
      message_ts: event.ts,
    });
    return response.permalink;
  } catch (error) {
    warn(`Slack permalink lookup failed for ${event.channel}/${event.ts}: ${errorMessage(error)}`);
    return undefined;
  }
}
